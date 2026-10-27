import express from 'express'
import http from 'http'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { setupWSConnection } from './room.js'
import { dbPool, initDb } from './db.js'

const PORT = parseInt(process.env.PORT ?? '1234', 10)
const HOST = process.env.HOST ?? 'localhost'

const app = express()
app.use(cors({ origin: '*' }))
app.use(express.json())

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Room info endpoint — returns list of connected clients per room
app.get('/rooms/:name/info', (req, res) => {
  res.json({ room: req.params.name, note: 'see WebSocket for live state' })
})

// Time-Travel History endpoint
app.get('/doc/:id/history', async (req, res) => {
  try {
    const docId = req.params.id || 'demo'
    // Default to a very large HLC if no 'before' string is provided
    const beforeHLC = (req.query.before as string) || 'zzzzzzzzzzzz-zzzz-zzzz'
    
    // Postgres fetches operations that happened strictly up to `beforeHLC`
    const { rows } = await dbPool.query(
      `SELECT update_blob FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2 ORDER BY hlc_timestamp ASC`,
      [docId, beforeHLC]
    )

    // Send array of base64 encoded binary arrays
    const ops = rows.map(r => r.update_blob.toString('base64'))
    res.json({ ops })
  } catch (err) {
    console.error('[http] history fetch error:', err)
    res.status(500).json({ error: 'Failed to fetch history' })
  }
})

const server = http.createServer(app)

const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`)
  // Room name comes from the pathname: /room-name
  const roomName = url.pathname.slice(1) || 'default'

  console.log(`[ws] client connected → room="${roomName}"`)
  setupWSConnection(ws, req, roomName)

  ws.on('close', () => {
    console.log(`[ws] client disconnected ← room="${roomName}"`)
  })
})

server.listen(PORT, async () => {
  await initDb()
  console.log(`✅  CRDT WebSocket server listening on ws://${HOST}:${PORT}`)
})
