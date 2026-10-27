import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { setupWSConnection, getRoom, flushRoomPersistence } from './room.js'
import { dbPool, initDb } from './db.js'
import * as Y from 'yjs'

const PORT = parseInt(process.env.PORT ?? '1234', 10)
const HOST = process.env.HOST ?? '0.0.0.0'

const app = express()
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }))
app.use(express.json())

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

// Room info endpoint
app.get('/rooms/:name/info', (req, res) => {
  const roomName = req.params.name
  const room = getRoom(roomName)
  res.json({
    room: roomName,
    clientCount: room.clients.size,
    awarenessCount: room.awareness.getStates().size,
  })
})

// Time-Travel History endpoint with Bounded Snapshot-Assisted Recovery Contract
app.get('/doc/:id/history', async (req, res) => {
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
app.get('/doc/:id/retention', async (req, res) => {
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
app.post('/doc/:id/snapshot', async (req, res) => {
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
app.post('/doc/:id/compact', async (req, res) => {
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
    res.status(500).json({ error: 'Failed to execute compaction', details: err.message })
  } finally {
    room.isCompacting = false
    client.release()
  }
})

const server = http.createServer(app)

const wss = new WebSocketServer({
  server,
  maxPayload: 10 * 1024 * 1024, // 10MB limit
})

wss.on('connection', (ws, req) => {
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
const shutdown = async (signal: string) => {
  console.log(`[lifecycle] Received ${signal}. Shutting down gracefully...`)

  // Close WebSocket server
  wss.close(() => {
    console.log('[lifecycle] WebSocket server closed.')
  })

  // Close HTTP server
  server.close(async () => {
    console.log('[lifecycle] HTTP server closed.')
    try {
      await dbPool.end()
      console.log('[lifecycle] Database pool drained.')
    } catch (e: any) {
      console.error('[lifecycle] Error draining DB pool:', e.message)
    }
    process.exit(0)
  })

  // Force shutdown if cleanup hangs
  setTimeout(() => {
    console.error('[lifecycle] Forced shutdown after timeout.')
    process.exit(1)
  }, 10000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.listen(PORT, HOST, async () => {
  await initDb()
  console.log(`✅  Converge Collaboration Server listening on http://${HOST}:${PORT} (ws://${HOST}:${PORT})`)
})
