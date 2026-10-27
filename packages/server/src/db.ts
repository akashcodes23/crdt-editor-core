// packages/server/src/db.ts
import { Pool } from 'pg';

export const dbPool = new Pool({
  user: 'crdt',
  password: 'password',
  host: 'localhost',
  port: 5432,
  database: 'crdthistory',
});

// Initialize the operations table if it doesn't exist
export async function initDb() {
  const client = await dbPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS operations (
        id            BIGSERIAL PRIMARY KEY,
        doc_id        TEXT NOT NULL,
        client_id     TEXT NOT NULL,
        hlc_timestamp TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        update_blob   BYTEA NOT NULL
      );
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ops_doc_time 
      ON operations(doc_id, hlc_timestamp);
    `);
    console.log('[postgres] DB initialized: operations table ready.');
  } catch (err) {
    console.error('[postgres] Failed to initialize DB:', err);
  } finally {
    client.release();
  }
}
