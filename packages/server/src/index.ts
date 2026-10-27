import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { setupWSConnection, getRoom } from './room.js'
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

// Time-Travel History endpoint
app.get('/doc/:id/history', async (req, res) => {
  try {
    const docId = req.params.id || 'demo'
    const beforeHLC = (req.query.before as string) || 'zzzzzzzzzzzz-zzzz-zzzz'

    // Postgres fetches operations that happened strictly up to `beforeHLC`
    const { rows } = await dbPool.query(
      `SELECT update_blob FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2 ORDER BY hlc_timestamp ASC`,
      [docId, beforeHLC]
    )

    const ops = rows.map((r) => r.update_blob.toString('base64'))
    res.json({ ops, count: ops.length })
  } catch (err: any) {
    console.error('[http] history fetch error:', err.message)
    res.status(500).json({ error: 'Failed to fetch history' })
  }
})

// Snapshot Trigger Endpoint (Manual or scheduled compaction)
app.post('/doc/:id/snapshot', async (req, res) => {
  try {
    const docId = req.params.id
    const room = getRoom(docId)
    const snapshot = Y.encodeStateAsUpdate(room.doc)
    
    // Find highest HLC currently stored for this doc
    const hlcRes = await dbPool.query(
      `SELECT hlc_timestamp FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp DESC LIMIT 1`,
      [docId]
    )
    const latestHlc = hlcRes.rows[0]?.hlc_timestamp || '0'

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

const server = http.createServer(app)

const wss = new WebSocketServer({
  server,
  maxPayload: 10 * 1024 * 1024, // 10MB limit
})

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  const roomName = url.pathname.slice(1) || 'default'

  console.log(`[ws] client connected → room="${roomName}"`)
  setupWSConnection(ws, req, roomName)

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
