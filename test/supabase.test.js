import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, query, one } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

// Supabase creates "anon" and "authenticated" roles and grants them every new table in "public".
let supabaseLike = true;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  try {
    await query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$`);
  } catch {
    supabaseLike = false; // this database user can't create roles
    return;
  }
  await query('GRANT USAGE ON SCHEMA public TO anon, authenticated');
  await query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated');
  await migrate({ log: () => {} });
});
after(() => pool.end());

test('on Supabase, the public Data API roles can read nothing', async (t) => {
  if (!supabaseLike) return t.skip('needs permission to create roles');
  for (const table of ['users', 'payments', 'proctor_media', 'certificates', 'session']) {
    const r = await one(`SELECT has_table_privilege('anon', $1, 'SELECT') AS anon, has_table_privilege('authenticated', $1, 'SELECT') AS auth,
                                (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = $2) AS rls`, [`public.${table}`, table]);
    assert.deepEqual(r, { anon: false, auth: false, rls: true }, table);
  }
  // The app (the tables' owner) still works normally.
  await query(`INSERT INTO users (email, password_hash, first_name, last_name) VALUES ('owner-check@example.com', 'x', 'A', 'B')`);
  assert.ok((await one(`SELECT reference FROM users WHERE email = 'owner-check@example.com'`)).reference.startsWith('HV-L-'));
});
