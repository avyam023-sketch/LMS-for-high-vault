import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';

// Always verify the database's certificate. Managed databases signed by their own CA (AWS) need its bundle.
const ssl = config.DATABASE_SSL || config.DATABASE_CA_FILE
  ? { rejectUnauthorized: true, ...(config.DATABASE_CA_FILE ? { ca: readFileSync(config.DATABASE_CA_FILE, 'utf8') } : {}) }
  : undefined;

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl,
  max: 10,
  // Fail fast instead of piling up connections behind a stuck query.
  statement_timeout: 15_000,
  idle_in_transaction_session_timeout: 30_000,
  connectionTimeoutMillis: 10_000,
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
