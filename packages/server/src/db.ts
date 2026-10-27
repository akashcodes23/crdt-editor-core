// packages/server/src/db.ts
import { Pool, PoolConfig } from 'pg'

const poolConfig: PoolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      user: process.env.PGUSER || process.env.POSTGRES_USER || 'crdt',
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'password',
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.PGPORT || process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'crdthistory',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    }

export const dbPool = new Pool(poolConfig)

dbPool.on('error', (err) => {
  console.error('[postgres] Unexpected client error in pool:', err)
})

// Initialize operations & snapshot tables
export async function initDb(): Promise<boolean> {
  let client
  try {
    client = await dbPool.connect()
    
    // 1. Immutable append-only operation log
    await client.query(`
      CREATE TABLE IF NOT EXISTS operations (
        id            BIGSERIAL PRIMARY KEY,
        doc_id        TEXT NOT NULL,
        client_id     TEXT NOT NULL,
        hlc_timestamp TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        update_blob   BYTEA NOT NULL
      );
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ops_doc_time 
      ON operations(doc_id, hlc_timestamp);
    `)

    // 2. Compacted document snapshots (Phase 4 support)
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_snapshots (
        id            BIGSERIAL PRIMARY KEY,
        doc_id        TEXT NOT NULL,
        snapshot_blob BYTEA NOT NULL,
        hlc_cutoff    TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_doc_time
      ON doc_snapshots(doc_id, hlc_cutoff DESC);
    `)

    console.log('[postgres] DB initialized: operations & snapshots tables ready.')
    return true
  } catch (err) {
    console.warn('[postgres] DB initialization failed (continuing in ephemeral mode):', err)
    return false
  } finally {
    if (client) client.release()
  }
}
