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

// ── Room state ─────────────────────────────────────────────────────────────────
export interface Room {
  name: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  /** Set of actively connected WebSockets */
  clients: Set<WebSocket>
  /** Map each WebSocket to the awareness clientIDs it registered */
  clientAwareness: Map<WebSocket, Set<number>>
}

// Global room registry
const rooms = new Map<string, Room>()

export function getRoom(name: string): Room {
  return map.setIfUndefined(rooms, name, (): Room => {
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    const clients = new Set<WebSocket>()
    const clientAwareness = new Map<WebSocket, Set<number>>()

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

    const room: Room = { name, doc, awareness, clients, clientAwareness }
    rooms.set(name, room)

    // Store operations in PostgreSQL append-only backend with HLC
    doc.on('update', (updateBuffer: Uint8Array, origin: any) => {
      const hlc = generateHLC('server')
      const clientId = origin && typeof origin === 'object' && origin.clientID !== undefined
        ? origin.clientID.toString()
        : doc.clientID.toString()

      dbPool.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, $2, $3, $4)`,
        [name, clientId, hlc, Buffer.from(updateBuffer)]
      ).catch(err => {
        // Log error without crashing
        console.error(`[postgres] update insert error for doc "${name}":`, err.message)
      })
    })

    // Restore persisted state from LevelDB before serving any clients
    getPersistence()
      .bindState(name, doc)
      .then(() => console.log(`[room] "${name}" restored from LevelDB`))
      .catch((err: unknown) =>
        console.warn(`[room] "${name}" LevelDB bind error:`, err)
      )

    return room
  })
}

// ── Broadcast helper (excludes sender WebSocket) ──────────────────────────────
function broadcastExcept(room: Room, data: Uint8Array, exclude: WebSocket) {
  for (const clientWs of room.clients) {
    if (clientWs !== exclude && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data)
    }
  }
}

// ── Per-message handler ────────────────────────────────────────────────────────
function handleMessage(ws: WebSocket, room: Room, data: RawData) {
  const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)
  
  if (buf.length > MAX_PAYLOAD_BYTES) {
    console.warn(`[room] Rejected oversized frame (${buf.length} bytes)`)
    ws.close(1009, 'Message exceeds size limit')
    return
  }

  const decoder = decoding.createDecoder(new Uint8Array(buf))
  const encoder = encoding.createEncoder()
  const msgType = decoding.readVarUint(decoder)

  switch (msgType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      const syncMsgType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, null)

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
      break
    }

    case MESSAGE_AWARENESS: {
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
      } catch (e) {
        // Non-fatal if parsing tracking IDs fails; awareness protocol will still validate
      }

      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws)
      break
    }

    default:
      console.warn(`[room] unknown message type: ${msgType}`)
  }
}

// ── Public entry point ─────────────────────────────────────────────────────────
export function setupWSConnection(
  ws: WebSocket,
  _req: http.IncomingMessage,
  roomName: string
): void {
  const room = getRoom(roomName)

  // Register this socket in the room's active client set
  room.clients.add(ws)

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
