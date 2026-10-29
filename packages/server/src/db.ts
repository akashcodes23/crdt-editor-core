// packages/server/src/db.ts
import { Pool, PoolConfig } from 'pg'

// Determine if SSL is required for managed database connection (e.g. Neon, Supabase, Render, AWS RDS)
const hasSslInUrl =
  typeof process.env.DATABASE_URL === 'string' &&
  (process.env.DATABASE_URL.includes('sslmode=require') ||
    process.env.DATABASE_URL.includes('neon.tech') ||
    process.env.DATABASE_URL.includes('ssl=true'))

const useSsl =
  process.env.DATABASE_SSL === 'true' ||
  process.env.PGSSL === 'true' ||
  (hasSslInUrl && process.env.DATABASE_SSL !== 'false')

// Certificate verification MUST remain enabled by default (rejectUnauthorized: true) in production TLS.
// Only allow disabling if the operator explicitly configures DATABASE_SSL_REJECT_UNAUTHORIZED=false.
const rejectUnauthorized = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'

if (useSsl && !rejectUnauthorized) {
  console.warn(
    '[security] WARNING: DATABASE_SSL_REJECT_UNAUTHORIZED is set to false. PostgreSQL TLS certificate validation is disabled (vulnerable to MITM). Do not use this in production unless connecting to a verified private host with a custom CA.'
  )
}

const sslConfig = useSsl ? { rejectUnauthorized } : undefined

const poolConfig: PoolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ...(sslConfig ? { ssl: sslConfig } : {}),
    }
  : {
      user: process.env.PGUSER || process.env.POSTGRES_USER || 'crdt',
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'password',
      host: process.env.PGHOST || process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.PGPORT || process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'crdthistory',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ...(sslConfig ? { ssl: sslConfig } : {}),
    }

export const dbPool = new Pool(poolConfig)
;(dbPool as any).__originalQuery = dbPool.query.bind(dbPool)

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
        update_blob   BYTEA NOT NULL,
        update_id     TEXT
      );
    `)

    await client.query(`
      ALTER TABLE operations ADD COLUMN IF NOT EXISTS update_id TEXT;
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ops_doc_time 
      ON operations(doc_id, hlc_timestamp);
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ops_doc_update_id
      ON operations(doc_id, update_id);
    `)

    // Check for any duplicate (doc_id, update_id) records before creating the unique index
    const dupCheck = await client.query(`
      SELECT doc_id, update_id, COUNT(*) AS count
      FROM operations
      WHERE update_id IS NOT NULL
      GROUP BY doc_id, update_id
      HAVING COUNT(*) > 1
    `)
    if (dupCheck.rows.length > 0) {
      console.warn(`[postgres] Found ${dupCheck.rows.length} duplicate (doc_id, update_id) pairs in operations. Preserving historical rows without silent deletion.`)
    } else {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_doc_update_id_unique
        ON operations(doc_id, update_id)
        WHERE update_id IS NOT NULL;
      `)
    }

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

    // 3. Durable Acknowledgement & Restart-Safe Idempotency Log
    await client.query(`
      CREATE TABLE IF NOT EXISTS durable_acks (
        doc_id        TEXT NOT NULL,
        update_id     TEXT NOT NULL,
        status        TEXT NOT NULL,
        hlc_timestamp TEXT,
        payload_hash  TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (doc_id, update_id)
      );
    `)

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_durable_acks_doc
      ON durable_acks(doc_id);
    `)

    console.log('[postgres] DB initialized: operations, snapshots, and durable_acks tables ready.')
    return true
  } catch (err) {
    console.warn('[postgres] DB initialization failed (continuing in ephemeral mode):', err)
    return false
  } finally {
    if (client) client.release()
  }
}
