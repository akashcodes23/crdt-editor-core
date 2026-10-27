import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as map from 'lib0/map'
import { WebSocket, RawData } from 'ws'
import http from 'http'
import { getPersistence } from './persistence.js'
import { dbPool } from './db.js'
import { generateHLC } from './hlc.js'

// ── y-websocket wire protocol constants ───────────────────────────────────────
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

// Maximum binary frame size (10MB) to mitigate memory exhaustion DoS
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024

// Ping interval for connection health (30 seconds)
const PING_INTERVAL_MS = 30000

// Extended WebSocket with heartbeat flag
export interface ExtendedWebSocket extends WebSocket {
  isAlive?: boolean
}

// ── Room state ─────────────────────────────────────────────────────────────────
export interface Room {
  name: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  /** Set of actively connected WebSockets */
  clients: Set<ExtendedWebSocket>
  /** Map each WebSocket to the awareness clientIDs it registered */
  clientAwareness: Map<ExtendedWebSocket, Set<number>>
  /** Promise that resolves when persistence state is loaded */
  loadedPromise: Promise<void>
  /** Promise chain of queued PostgreSQL persistence writes */
  persistenceQueue: Promise<void>
  /** Highest HLC confirmed written to PostgreSQL for this room */
  lastPersistedHlc: string | null
  /** Mutex flag to serialize compaction requests */
  isCompacting?: boolean
}

// Global room registry
const rooms = new Map<string, Room>()

export function getRoom(name: string): Room {
  return map.setIfUndefined(rooms, name, (): Room => {
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    const clients = new Set<ExtendedWebSocket>()
    const clientAwareness = new Map<ExtendedWebSocket, Set<number>>()

    // Awareness broadcast: triggered whenever local or remote awareness updates
    awareness.on(
      'update',
      ({
        added,
        updated,
        removed,
      }: {
        added: number[]
        updated: number[]
        removed: number[]
      }) => {
        const changedClients = added.concat(updated, removed)
        const room = rooms.get(name)
        if (!room) return
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
        )
        const buf = encoding.toUint8Array(encoder)
        for (const clientWs of room.clients) {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(buf)
          }
        }
      }
    )

    // Store operations in PostgreSQL append-only backend with HLC
    let persistenceQueue = Promise.resolve()
    let lastPersistedHlc: string | null = null

    doc.on('update', (updateBuffer: Uint8Array, origin: any) => {
      // Do not store updates generated during initial LevelDB recovery
      if (origin === 'leveldb-restore') return

      const hlc = generateHLC('server')
      const clientId =
        origin && typeof origin === 'object' && origin.clientID !== undefined
          ? origin.clientID.toString()
          : doc.clientID.toString()

      const writeOp = dbPool
        .query(
          `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, $2, $3, $4)`,
          [name, clientId, hlc, Buffer.from(updateBuffer)]
        )
        .then(() => {
          const r = rooms.get(name)
          if (r) {
            r.lastPersistedHlc = hlc
          }
        })
        .catch((err) => {
          console.error(`[postgres] update insert error for doc "${name}":`, err.message)
        })

      const r = rooms.get(name)
      if (r) {
        r.persistenceQueue = r.persistenceQueue.then(() => writeOp)
      }
    })

    // Restore persisted state from LevelDB before serving any clients
    const loadedPromise = getPersistence()
      .bindState(name, doc)
      .then(() => {
        console.log(`[room] "${name}" restored from LevelDB`)
      })
      .catch((err: unknown) => {
        console.warn(`[room] "${name}" LevelDB bind error:`, err)
      })

    const room: Room = {
      name,
      doc,
      awareness,
      clients,
      clientAwareness,
      loadedPromise,
      persistenceQueue,
      lastPersistedHlc,
      isCompacting: false,
    }
    rooms.set(name, room)
    return room
  })
}

/**
 * Awaits all pending asynchronous PostgreSQL operation inserts for this room.
 * Returns the highest persisted HLC timestamp.
 */
export async function flushRoomPersistence(room: Room): Promise<string | null> {
  await room.persistenceQueue
  return room.lastPersistedHlc
}

// ── Broadcast helper (excludes sender WebSocket) ──────────────────────────────
function broadcastExcept(room: Room, data: Uint8Array, exclude: ExtendedWebSocket) {
  for (const clientWs of room.clients) {
    if (clientWs !== exclude && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data)
    }
  }
}

// ── Per-message handler ────────────────────────────────────────────────────────
function handleMessage(ws: ExtendedWebSocket, room: Room, data: RawData) {
  const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)

  if (buf.length > MAX_PAYLOAD_BYTES) {
    console.warn(`[room] Rejected oversized frame (${buf.length} bytes)`)
    ws.close(1009, 'Message exceeds size limit')
    return
  }

  let decoder: decoding.Decoder
  try {
    decoder = decoding.createDecoder(new Uint8Array(buf))
  } catch (err) {
    console.error('[room] Failed to decode frame header:', err)
    ws.close(1002, 'Malformed protocol header')
    return
  }

  const encoder = encoding.createEncoder()
  let msgType: number

  try {
    msgType = decoding.readVarUint(decoder)
  } catch (err) {
    console.error('[room] Protocol decode error:', err)
    ws.close(1002, 'Protocol decode error')
    return
  }

  switch (msgType) {
    case MESSAGE_SYNC: {
      try {
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        const syncMsgType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws)

        // Reply only when encoder has content beyond the outer MESSAGE_SYNC byte
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder))
        }

        // Forward update to all other peers
        if (
          syncMsgType === syncProtocol.messageYjsSyncStep2 ||
          syncMsgType === syncProtocol.messageYjsUpdate
        ) {
          broadcastExcept(room, buf, ws)
        }
      } catch (err) {
        console.error('[room] Error processing sync message:', err)
        ws.close(1002, 'Sync protocol error')
      }
      break
    }

    case MESSAGE_AWARENESS: {
      try {
        const update = decoding.readVarUint8Array(decoder)

        // Track which clientIDs belong to this WebSocket for accurate disconnect cleanup
        try {
          const idDecoder = decoding.createDecoder(update)
          const count = decoding.readVarUint(idDecoder)
          let tracked = room.clientAwareness.get(ws)
          if (!tracked) {
            tracked = new Set<number>()
            room.clientAwareness.set(ws, tracked)
          }
          for (let i = 0; i < count; i++) {
            const clientId = decoding.readVarUint(idDecoder)
            decoding.readVarUint(idDecoder) // clock
            decoding.readVarString(idDecoder) // json state
            tracked.add(clientId)
          }
        } catch {
          // Non-fatal if parsing tracking IDs fails; awareness protocol validates
        }

        awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws)
      } catch (err) {
        console.error('[room] Error processing awareness message:', err)
      }
      break
    }

    default:
      console.warn(`[room] unknown message type: ${msgType}`)
  }
}

// ── Public entry point ─────────────────────────────────────────────────────────
export async function setupWSConnection(
  ws: ExtendedWebSocket,
  _req: http.IncomingMessage,
  roomName: string
): Promise<void> {
  const room = getRoom(roomName)

  // Ensure persistent state is fully restored before handshake
  await room.loadedPromise

  // Mark connection alive and register
  ws.isAlive = true
  room.clients.add(ws)

  ws.on('pong', () => {
    ws.isAlive = true
  })

  ws.on('message', (data) => {
    try {
      handleMessage(ws, room, data)
    } catch (err) {
      console.error('[room] message handling error:', err)
    }
  })

  ws.on('close', () => {
    room.clients.delete(ws)

    // Clean up awareness state for any clientIDs registered by this connection
    const controlledIds = room.clientAwareness.get(ws)
    if (controlledIds && controlledIds.size > 0) {
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        Array.from(controlledIds),
        'client disconnected'
      )
    }
    room.clientAwareness.delete(ws)

    if (room.clients.size === 0) {
      console.log(`[room] "${roomName}" is now empty`)
    } else {
      console.log(
        `[room] "${roomName}" client disconnected — ${room.clients.size} remaining`
      )
    }
  })

  // ── Handshake step 1: ask client for its state vector ─────────────────────
  {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, room.doc)
    ws.send(encoding.toUint8Array(encoder))
  }

  // ── Push current awareness states to the newly connected client ───────────
  const awarenessStates = room.awareness.getStates()
  if (awarenessStates.size > 0) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        Array.from(awarenessStates.keys())
      )
    )
    ws.send(encoding.toUint8Array(encoder))
  }

  console.log(
    `[room] "${roomName}" client connected — total: ${room.clients.size}`
  )
}

// ── Periodic heartbeat to terminate hung connections ──────────────────────────
const heartbeatInterval = setInterval(() => {
  for (const [, room] of rooms) {
    for (const ws of room.clients) {
      if (ws.isAlive === false) {
        console.warn(`[heartbeat] Terminating inactive connection in room "${room.name}"`)
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }
}, PING_INTERVAL_MS)

heartbeatInterval.unref()
