import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import pg from 'pg';
import { config } from '../config.js';

// Always verify the database's certificate. Managed databases signed by their own CA (AWS, Supabase) add
// it here; the public roots stay trusted too, for hosts whose poolers use a public certificate.
const customCa = [
  config.DATABASE_CA_FILE ? readFileSync(config.DATABASE_CA_FILE, 'utf8') : null,
  config.DATABASE_CA_CERT ? config.DATABASE_CA_CERT.replace(/\\n/g, '\n') : null,
].filter(Boolean);
const ssl = config.DATABASE_SSL || customCa.length
  ? { rejectUnauthorized: true, ...(customCa.length ? { ca: [...tls.rootCertificates, ...customCa] } : {}) }
  : undefined;

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl,
  max: 10,
  connectionTimeoutMillis: 10_000,
  // Fail fast instead of piling up connections behind a stuck query. Set per session rather than as
  // startup options, which connection poolers (Supabase, PgBouncer) can refuse.
  onConnect: (client) => client.query('SET statement_timeout = 15000; SET idle_in_transaction_session_timeout = 30000'),
});

export const query = (text, params) => pool.query(text, params);

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] ?? null;
}

export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/** Runs fn inside a transaction, passing a dedicated client. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
