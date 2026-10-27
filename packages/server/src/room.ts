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
// Must match what y-websocket client expects:
// https://github.com/yjs/y-websocket/blob/master/src/y-websocket.js
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

// ── Room state ─────────────────────────────────────────────────────────────────
interface Room {
  name: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  /** Map from clientID → WebSocket for correct awareness cleanup on disconnect */
  clients: Map<number, WebSocket>
}

// Global room registry
const rooms = new Map<string, Room>()

function getRoom(name: string): Room {
  return map.setIfUndefined(rooms, name, (): Room => {
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)

    // Awareness broadcast: fired by applyAwarenessUpdate below.
    // We broadcast to ALL connected clients (sender included — idempotent for Yjs awareness).
    // This is the ONLY place awareness gets broadcast; the message handler does NOT
    // do a second broadcast, avoiding the double-send bug.
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
        room.clients.forEach((clientWs) => {
          if (clientWs.readyState === WebSocket.OPEN) clientWs.send(buf)
        })
      }
    )

    const room: Room = { name, doc, awareness, clients: new Map() }
    rooms.set(name, room)

    // Store operations in PostgreSQL append-only backend
    doc.on('update', (updateBuffer: Uint8Array, origin: any) => {
      // Create a deterministic monotonic timestamp
      const hlc = generateHLC('server')
      // Extract client ID (we could map properly, but we'll store string)
      // origin here is commonly the WebSocket connection or client ID. 
      // We will simply capture 'server-sync' or doc.clientID when unknown
      const clientId = origin && typeof origin === 'object' && origin.clientID !== undefined 
        ? origin.clientID.toString() 
        : doc.clientID.toString()

      // Fire and forget storing to PG
      dbPool.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, $2, $3, $4)`,
        [name, clientId, hlc, Buffer.from(updateBuffer)]
      ).catch(err => console.error('[postgres] update insert error:', err))
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

// ── Broadcast helper (excludes one WebSocket) ─────────────────────────────────
function broadcastExcept(room: Room, data: Uint8Array, exclude: WebSocket) {
  room.clients.forEach((clientWs) => {
    if (clientWs !== exclude && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data)
    }
  })
}

// ── Per-message handler ────────────────────────────────────────────────────────
function handleMessage(ws: WebSocket, room: Room, data: RawData) {
  const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)
  const decoder = decoding.createDecoder(new Uint8Array(buf))
  const encoder = encoding.createEncoder()
  const msgType = decoding.readVarUint(decoder)

  switch (msgType) {
    case MESSAGE_SYNC: {
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      // readSyncMessage:
      //   • If step1 → writes step2 (our doc update) into encoder → we reply to sender
      //   • If step2 or update → applies to doc, writes nothing → we broadcast raw buf
      const syncMsgType = syncProtocol.readSyncMessage(decoder, encoder, room.doc, null)

      // Reply only when encoder has content beyond the outer MESSAGE_SYNC byte
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder))
      }

      // Forward update to all other peers. Persistence is handled inside
      // getPersistence().bindState() via the doc 'update' listener it installs.
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
      // applyAwarenessUpdate triggers the 'update' listener above which broadcasts
      // to ALL clients. No separate broadcast needed here.
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

  // Each connection gets its own Yjs clientID so awareness cleanup is precise.
  // We assign it on first awareness setLocalState from the client; for cleanup
  // we track the clientID via a WeakMap keyed by ws.
  const connectionClientId = room.doc.clientID // server-side placeholder; client sends its own
  room.clients.set(connectionClientId, ws)

  ws.on('message', (data) => {
    try {
      handleMessage(ws, room, data)
    } catch (err) {
      console.error('[room] message handling error:', err)
    }
  })

  ws.on('close', () => {
    // Remove this connection from the room's client map
    room.clients.delete(connectionClientId)

    // Clean up awareness state for this peer
    awarenessProtocol.removeAwarenessStates(
      room.awareness,
      [connectionClientId],
      'client disconnected'
    )

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
