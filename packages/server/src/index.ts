import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { setupWSConnection, getRoom, flushRoomPersistence, flushAllRooms, closeAllRooms, rooms } from './room.js'
import { dbPool, initDb } from './db.js'
import { closePersistence } from './persistence.js'
import * as Y from 'yjs'
import {
  getSecurityConfig,
  validateProductionSecurityConfig,
  adminAuthMiddleware,
  docAuthMiddleware,
  isValidDocId,
  isOriginAllowed,
} from './security.js'

const PORT = parseInt(process.env.PORT ?? '1234', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

// Validate production security configuration before binding ports
const secValidation = validateProductionSecurityConfig()
if (!secValidation.valid) {
  console.error('❌  FATAL SECURITY CONFIGURATION ERROR:')
  for (const err of secValidation.errors) {
    console.error(`   - ${err}`)
  }
  if (process.env.NODE_ENV === 'production') {
    console.error('Server refusing to start in production with insecure configuration.')
    process.exit(1)
  }
}

const securityConfig = getSecurityConfig()
const app = express()

// Dynamic origin CORS check against allowlist
app.use(
  cors({
    origin: (origin, callback) => {
      const check = isOriginAllowed(origin, securityConfig.allowedOrigins)
      if (check.allowed) {
        callback(null, true)
      } else {
        callback(new Error(`CORS policy violation: origin "${origin}" not allowed`))
      }
    },
    credentials: true,
  })
)
app.use(express.json())

export let isShuttingDown = false

// Reject new incoming requests during graceful shutdown
app.use((req, res, next) => {
  if (isShuttingDown && req.path !== '/health') {
    res.status(503).json({
      error: 'SERVER_SHUTTING_DOWN',
      message: 'Server is shutting down; not accepting new requests.',
    })
    return
  }
  next()
})

// Health check with DB status
app.get('/health', async (_req, res) => {
  let dbStatus = 'healthy'
  try {
    await dbPool.query('SELECT 1')
  } catch (e: any) {
    dbStatus = `degraded: ${e.message}`
  }

  res.json({
    status: dbStatus === 'healthy' ? 'ok' : 'degraded',
    database: dbStatus,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  })
})

// Room info endpoint (Inspects active memory registry without allocating new rooms)
app.get('/rooms/:name/info', (req, res) => {
  const roomName = req.params.name
  if (!isValidDocId(roomName)) {
    return res.status(400).json({ error: 'INVALID_ROOM_NAME', message: 'Room name contains invalid characters or exceeds 128 chars' })
  }
  const room = rooms.get(roomName)
  if (!room) {
    return res.status(404).json({ error: 'ROOM_NOT_FOUND', message: `Room "${roomName}" is not currently active` })
  }
  res.json({
    room: roomName,
    clientCount: room.clients.size,
    awarenessCount: room.awareness.getStates().size,
  })
})

// Time-Travel History endpoint with Bounded Snapshot-Assisted Recovery Contract
app.get('/doc/:id/history', docAuthMiddleware, async (req, res) => {
  try {
    const docId = req.params.id || 'demo'
    const beforeHLC = (req.query.before as string) || 'zzzzzzzzzzzz-zzzz-zzzz'

    // 1. Determine earliest retention boundary
    // Check if any compaction has occurred by checking the minimum snapshot cutoff
    const earliestSnapshotRes = await dbPool.query(
      `SELECT MIN(hlc_cutoff) AS earliest_cutoff FROM doc_snapshots WHERE doc_id = $1`,
      [docId]
    )
    const earliestSnapshotCutoff = earliestSnapshotRes.rows[0]?.earliest_cutoff

    if (earliestSnapshotCutoff) {
      // If a snapshot exists, any historical state before this cutoff has been pruned!
      if (beforeHLC < earliestSnapshotCutoff) {
        return res.status(410).json({
          error: 'HISTORICAL_STATE_COMPACTED',
          message: `The requested historical state prior to "${beforeHLC}" has been pruned by compaction. Earliest recoverable checkpoint is "${earliestSnapshotCutoff}".`,
          earliestRecoverableHLC: earliestSnapshotCutoff,
          requestedBeforeHLC: beforeHLC,
        })
      }
    }

    // 2. Check if there is an applicable snapshot at or before beforeHLC
    const snapshotRes = await dbPool.query(
      `SELECT snapshot_blob, hlc_cutoff FROM doc_snapshots 
       WHERE doc_id = $1 AND hlc_cutoff <= $2 
       ORDER BY hlc_cutoff DESC, id DESC LIMIT 1`,
      [docId, beforeHLC]
    )

    let baseSnapshotBase64: string | null = null
    let afterHLC = '0'

    if (snapshotRes.rows.length > 0) {
      baseSnapshotBase64 = snapshotRes.rows[0].snapshot_blob.toString('base64')
      afterHLC = snapshotRes.rows[0].hlc_cutoff
    }

    // 3. Fetch delta operations that occurred strictly after the snapshot cutoff up to beforeHLC
    const { rows } = await dbPool.query(
      `SELECT update_blob FROM operations 
       WHERE doc_id = $1 AND hlc_timestamp > $2 AND hlc_timestamp <= $3 
       ORDER BY hlc_timestamp ASC, id ASC`,
      [docId, afterHLC, beforeHLC]
    )

    const deltaOps = rows.map((r) => r.update_blob.toString('base64'))
    const ops = baseSnapshotBase64 ? [baseSnapshotBase64, ...deltaOps] : deltaOps

    res.json({
      ops,
      count: ops.length,
      snapshotAssisted: baseSnapshotBase64 !== null,
      snapshotCutoffHLC: afterHLC,
      retentionBoundary: earliestSnapshotCutoff || null,
    })
  } catch (err: any) {
    console.error('[http] history fetch error:', err.message)
    res.status(500).json({ error: 'Failed to fetch history' })
  }
})

// Retention Status Endpoint (Reports exact retention boundary and metrics)
app.get('/doc/:id/retention', docAuthMiddleware, async (req, res) => {
  try {
    const docId = req.params.id
    const snapshotStats = await dbPool.query(
      `SELECT COUNT(*) AS count, MIN(hlc_cutoff) AS earliest_cutoff, MAX(hlc_cutoff) AS latest_cutoff 
       FROM doc_snapshots WHERE doc_id = $1`,
      [docId]
    )
    const opStats = await dbPool.query(
      `SELECT COUNT(*) AS count, MIN(hlc_timestamp) AS earliest_op, MAX(hlc_timestamp) AS latest_op 
       FROM operations WHERE doc_id = $1`,
      [docId]
    )

    const snapshotCount = parseInt(snapshotStats.rows[0]?.count || '0', 10)
    const earliestSnapshotCutoff = snapshotStats.rows[0]?.earliest_cutoff || null
    const latestSnapshotCutoff = snapshotStats.rows[0]?.latest_cutoff || null

    const opCount = parseInt(opStats.rows[0]?.count || '0', 10)
    const earliestOpHlc = opStats.rows[0]?.earliest_op || null
    const latestOpHlc = opStats.rows[0]?.latest_op || null

    const earliestRecoverableHLC = earliestSnapshotCutoff || earliestOpHlc || null

    res.json({
      docId,
      contract: 'bounded-snapshot-tail',
      snapshotCount,
      activeOperationCount: opCount,
      earliestSnapshotCutoff,
      latestSnapshotCutoff,
      earliestActiveOperationHLC: earliestOpHlc,
      latestActiveOperationHLC: latestOpHlc,
      earliestRecoverableHLC,
    })
  } catch (err: any) {
    console.error('[http] retention info error:', err.message)
    res.status(500).json({ error: 'Failed to fetch retention info' })
  }
})

// Snapshot Trigger Endpoint (Captures document checkpoint synchronized with persistence)
app.post('/doc/:id/snapshot', adminAuthMiddleware, async (req, res) => {
  try {
    const docId = req.params.id
    const room = getRoom(docId)
    await room.loadedPromise

    // Flush any pending async writes to PostgreSQL so memory and DB are aligned
    await flushRoomPersistence(room)

    let latestHlc = room.lastPersistedHlc
    if (!latestHlc) {
      const hlcRes = await dbPool.query(
        `SELECT hlc_timestamp FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp DESC, id DESC LIMIT 1`,
        [docId]
      )
      latestHlc = hlcRes.rows[0]?.hlc_timestamp || '0'
    }

    const snapshot = Y.encodeStateAsUpdate(room.doc)

    await dbPool.query(
      `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
      [docId, Buffer.from(snapshot), latestHlc]
    )

    res.json({ success: true, docId, hlcCutoff: latestHlc, snapshotBytes: snapshot.byteLength })
  } catch (err: any) {
    console.error('[http] snapshot creation error:', err.message)
    res.status(500).json({ error: 'Failed to create snapshot' })
  }
})

// Transactional Log Compaction Endpoint (Checkpoint + Operation Pruning with Concurrency Lock)
app.post('/doc/:id/compact', adminAuthMiddleware, async (req, res) => {
  const docId = req.params.id
  const room = getRoom(docId)
  await room.loadedPromise

  // Reject concurrent compaction requests on the same document
  if (room.isCompacting) {
    return res.status(409).json({
      error: 'COMPACTION_IN_PROGRESS',
      message: `Compaction already in progress for doc "${docId}". Concurrent compaction is rejected.`,
    })
  }
  room.isCompacting = true

  const client = await dbPool.connect()
  try {
    // 1. Drain in-flight persistence writes to ensure Postgres has all operations applied to memory
    await flushRoomPersistence(room)

    // 2. Determine checkpoint cutoff HLC from flushed writes
    let cutoffHlc = room.lastPersistedHlc
    if (!cutoffHlc) {
      const hlcRes = await client.query(
        `SELECT hlc_timestamp FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp DESC, id DESC LIMIT 1`,
        [docId]
      )
      cutoffHlc = hlcRes.rows[0]?.hlc_timestamp || null
    }

    if (!cutoffHlc) {
      return res.json({ success: true, message: 'No operations to compact', docId })
    }

    // Verify there are actually uncompacted operations at or before cutoffHlc
    const opCountRes = await client.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2`,
      [docId, cutoffHlc]
    )
    if (parseInt(opCountRes.rows[0].count, 10) === 0) {
      return res.json({ success: true, message: 'No operations to compact', docId, compactedOperations: 0 })
    }

    // 3. Capture in-memory snapshot synchronously.
    // Node.js is single-threaded; because flushRoomPersistence completed and no await occurs
    // before taking the snapshot, the snapshot captures EXACTLY the document state through cutoffHlc.
    const snapshot = Y.encodeStateAsUpdate(room.doc)

    await client.query('BEGIN')

    // 4. Atomically insert snapshot checkpoint and delete operations through cutoffHlc
    await client.query(
      `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
      [docId, Buffer.from(snapshot), cutoffHlc]
    )

    const deleteRes = await client.query(
      `DELETE FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2`,
      [docId, cutoffHlc]
    )

    await client.query('COMMIT')

    res.json({
      success: true,
      docId,
      hlcCutoff: cutoffHlc,
      compactedOperations: deleteRes.rowCount,
      snapshotBytes: snapshot.byteLength,
    })
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[http] compaction error:', err.message)
    res.status(500).json({ error: 'COMPACTION_FAILED', message: 'Failed to execute compaction' })
  } finally {
    room.isCompacting = false
    client.release()
  }
})

const server = http.createServer(app)

const wss = new WebSocketServer({
  server,
  maxPayload: securityConfig.maxPayloadBytes,
  handleProtocols: (protocols: Set<string>, _req) => {
    // 1. Prefer standard application subprotocol so capability tokens are never echoed in HTTP response headers
    if (protocols.has('converge.v1')) {
      return 'converge.v1'
    }
    if (protocols.has('converge')) {
      return 'converge'
    }
    // 2. If client supplied non-token subprotocol, select it
    for (const p of protocols) {
      if (!p.startsWith('converge.token.')) {
        return p
      }
    }
    // 3. Fallback for legacy single-subprotocol clients
    for (const p of protocols) {
      if (p.startsWith('converge.token.')) {
        return p
      }
    }
    return protocols.values().next().value ?? false
  },
})

wss.on('connection', (ws, req) => {
  if (isShuttingDown) {
    ws.close(1001, 'Server shutting down')
    return
  }

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  const roomName = url.pathname.slice(1) || 'default'

  console.log(`[ws] client connected → room="${roomName}"`)
  setupWSConnection(ws, req, roomName).catch((err) => {
    console.error(`[ws] setup connection error for room "${roomName}":`, err)
  })

  ws.on('close', () => {
    console.log(`[ws] client disconnected ← room="${roomName}"`)
  })
})

// Graceful shutdown handling
export async function gracefulShutdown(
  options: { timeoutMs?: number; exitProcess?: boolean } = {}
): Promise<{ success: boolean; errors: string[] }> {
  const timeoutMs = options.timeoutMs ?? 10000
  const exitProcess = options.exitProcess ?? false
  const errors: string[] = []

  console.log('[lifecycle] Initiating graceful shutdown sequence...')
  isShuttingDown = true

  // 1. Stop accepting new HTTP requests
  const serverClosePromise = new Promise<void>((resolve) => {
    server.close(() => {
      console.log('[lifecycle] HTTP server closed.')
      resolve()
    })
  })

  // 2. Stop accepting new WebSocket connections
  const wssClosePromise = new Promise<void>((resolve) => {
    wss.close(() => {
      console.log('[lifecycle] WebSocket server closed.')
      resolve()
    })
  })

  try {
    // 3. Drain pending room persistence queues and LevelDB writes
    console.log('[lifecycle] Draining room persistence queues...')
    const flushRes = await flushAllRooms(Math.max(1000, timeoutMs - 3000))
    if (flushRes.errors.length > 0) {
      errors.push(...flushRes.errors)
      console.warn('[lifecycle] Warnings during persistence flush:', flushRes.errors)
    }

    // 4. Close LevelDB working storage
    console.log('[lifecycle] Closing LevelDB persistence...')
    await closePersistence()

    // 5. Terminate client sockets and destroy room docs
    closeAllRooms()

    // Wait for server socket closures
    await Promise.all([serverClosePromise, wssClosePromise])

    // 6. Drain database connection pool only after all writes settle
    console.log('[lifecycle] Draining database pool...')
    await dbPool.end()
    console.log('[lifecycle] Database pool drained.')

    if (exitProcess) {
      process.exit(errors.length > 0 ? 1 : 0)
    }
    return { success: errors.length === 0, errors }
  } catch (err: any) {
    console.error('[lifecycle] Error during graceful shutdown:', err.message)
    errors.push(err.message)
    if (exitProcess) {
      process.exit(1)
    }
    return { success: false, errors }
  }
}

const shutdown = (signal: string) => {
  console.log(`[lifecycle] Received ${signal}. Shutting down gracefully...`)
  gracefulShutdown({ timeoutMs: 10000, exitProcess: true }).catch(() => process.exit(1))
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, HOST, async () => {
  await initDb()
  console.log(`✅  Converge Collaboration Server listening on http://${HOST}:${PORT} (ws://${HOST}:${PORT})`)
})
