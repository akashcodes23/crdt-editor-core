import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as map from 'lib0/map'
import { WebSocket, RawData } from 'ws'
import http from 'http'
import crypto from 'crypto'
import { getPersistence } from './persistence.js'
import { dbPool } from './db.js'
import { generateHLC } from './hlc.js'
import {
  getSecurityConfig,
  isValidDocId,
  isOriginAllowed,
  isAuthorizedForRoom,
  extractAuthTokenFromReq,
  extractProxyIdentity,
  verifyAuthToken,
  ConnectionRateLimiter,
  type AuthClaims,
  WS_CLOSE_POLICY_VIOLATION,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_TOO_MANY_REQUESTS,
  WS_CLOSE_BAD_REQUEST,
} from './security.js'

// ── y-websocket wire protocol constants ───────────────────────────────────────
export const MESSAGE_SYNC = 0
export const MESSAGE_AWARENESS = 1
export const MESSAGE_DURABLE_UPDATE = 2
export const MESSAGE_DURABLE_ACK = 3

export const ACK_STATUS_DURABLE = 0
export const ACK_STATUS_FAILED = 1

export interface DurableAckRecord {
  status: 'durable' | 'failed'
  hlc?: string
  error?: string
  payloadHash?: string
  timestamp: number
}

// Maximum binary frame size (10MB) to mitigate memory exhaustion DoS
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024

// Ping interval for connection health (30 seconds)
const PING_INTERVAL_MS = 30000

// Extended WebSocket with heartbeat flag and security context
export interface ExtendedWebSocket extends WebSocket {
  isAlive?: boolean
  authContext?: AuthClaims
  rateLimiter?: ConnectionRateLimiter
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
  /** Deduplication cache of recent durable acknowledgements */
  durableAcks: Map<string, DurableAckRecord>
  /** In-flight concurrent durable update promises to serialize identical submissions */
  inFlightUpdates: Map<string, Promise<{ status: 'durable' | 'failed'; hlc?: string; error?: string }>>
}

// Global room registry
export const rooms = new Map<string, Room>()

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
      // Do not store updates generated during initial LevelDB recovery, durable writes, or PostgreSQL reconciliation
      if (origin === 'leveldb-restore' || origin === 'durable-apply' || origin === 'postgres-reconcile') return

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

    // Restore persisted state from LevelDB AND reconcile with canonical PostgreSQL log
    const loadedPromise = (async () => {
      // 1. Load state from LevelDB working storage
      try {
        await getPersistence().bindState(name, doc)
        console.log(`[room] "${name}" restored from LevelDB`)
      } catch (err: unknown) {
        console.warn(`[room] "${name}" LevelDB bind error:`, err)
      }

      // 2. Authoritative PostgreSQL Reconciliation
      try {
        // Query latest snapshot cutoff if any
        const snapshotRes = await dbPool.query(
          `SELECT snapshot_blob, hlc_cutoff FROM doc_snapshots 
           WHERE doc_id = $1 
           ORDER BY hlc_cutoff DESC, id DESC LIMIT 1`,
          [name]
        )
        let afterHlc = '0'
        if (snapshotRes.rows.length > 0) {
          Y.applyUpdate(doc, snapshotRes.rows[0].snapshot_blob, 'postgres-reconcile')
          afterHlc = snapshotRes.rows[0].hlc_cutoff
        }

        // Query all operations strictly after snapshot cutoff
        const opsRes = await dbPool.query(
          `SELECT update_blob, hlc_timestamp FROM operations 
           WHERE doc_id = $1 AND hlc_timestamp > $2 
           ORDER BY hlc_timestamp ASC, id ASC`,
          [name, afterHlc]
        )
        for (const row of opsRes.rows) {
          Y.applyUpdate(doc, row.update_blob, 'postgres-reconcile')
        }

        // 3. Reconcile LevelDB with the complete merged CRDT document
        const reconciledUpdate = Y.encodeStateAsUpdate(doc)
        if (reconciledUpdate.byteLength > 2) {
          await getPersistence().storeUpdate(name, reconciledUpdate).catch((err: any) => {
            console.warn(`[room] "${name}" LevelDB repair sync error:`, err?.message || err)
          })
        }
      } catch (pgErr: any) {
        console.warn(`[room] "${name}" Postgres reconciliation error:`, pgErr?.message || pgErr)
      }
    })()

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
      durableAcks: new Map<string, DurableAckRecord>(),
      inFlightUpdates: new Map(),
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
  let prevQueue: Promise<any> | null = null
  while (prevQueue !== room.persistenceQueue) {
    prevQueue = room.persistenceQueue
    await prevQueue
  }
  const persistence = getPersistence()
  if (persistence.flushDocument) {
    await persistence.flushDocument(room.name)
  }
  return room.lastPersistedHlc
}

/**
 * Flushes pending persistence queues across all active rooms with a defined timeout.
 */
export async function flushAllRooms(
  timeoutMs: number = 5000
): Promise<{ flushedCount: number; errors: string[] }> {
  const roomList = Array.from(rooms.values())
  const errors: string[] = []
  let flushedCount = 0

  const flushPromises = roomList.map(async (room) => {
    try {
      await flushRoomPersistence(room)
      flushedCount++
    } catch (err: any) {
      errors.push(`Room "${room.name}": ${err?.message || err}`)
    }
  })

  const timeoutPromise = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs)
  )

  const result = await Promise.race([
    Promise.all(flushPromises).then(() => 'done' as const),
    timeoutPromise,
  ])

  if (result === 'timeout') {
    errors.push(`Persistence flush timed out after ${timeoutMs}ms`)
  }

  return { flushedCount, errors }
}

/**
 * Disposes all active rooms, terminates remaining sockets, and destroys Y.Docs.
 */
export function closeAllRooms(): void {
  for (const name of Array.from(rooms.keys())) {
    closeRoom(name)
  }
}

/**
 * Disposes a room, terminates remaining client sockets, destroys in-memory Y.Doc,
 * and evicts it from the global room registry.
 */
export function closeRoom(name: string): boolean {
  const room = rooms.get(name)
  if (!room) return false
  for (const client of room.clients) {
    try {
      client.terminate()
    } catch {}
  }
  room.clients.clear()
  room.clientAwareness.clear()
  room.doc.destroy()
  return rooms.delete(name)
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
  // 1. Connection-level message rate limiting
  if (ws.rateLimiter && !ws.rateLimiter.recordMessage()) {
    console.warn(`[security] Rate limit exceeded for client in room "${room.name}"`)
    ws.close(WS_CLOSE_TOO_MANY_REQUESTS, 'Message rate limit exceeded')
    return
  }

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
    if (ws.rateLimiter && !ws.rateLimiter.recordError()) {
      ws.close(1002, 'Excessive decode errors')
    } else {
      ws.close(1002, 'Malformed protocol header')
    }
    return
  }

  let msgType: number
  try {
    msgType = decoding.readVarUint(decoder)
  } catch (err) {
    console.error('[room] Protocol decode error:', err)
    if (ws.rateLimiter && !ws.rateLimiter.recordError()) {
      ws.close(1002, 'Excessive decode errors')
    } else {
      ws.close(1002, 'Protocol decode error')
    }
    return
  }

  if (ws.rateLimiter) {
    ws.rateLimiter.resetErrors()
  }

  // 2. Read-only viewer authorization enforcement
  if (ws.authContext && ws.authContext.role === 'viewer') {
    if (msgType === MESSAGE_DURABLE_UPDATE) {
      try {
        const updateId = decoding.readVarString(decoder)
        sendDurableAck(ws, updateId, ACK_STATUS_FAILED, '', 'FORBIDDEN: Read-only client cannot submit updates')
      } catch {}
      return
    }

    if (msgType === MESSAGE_SYNC) {
      try {
        const probe = decoding.createDecoder(new Uint8Array(buf))
        decoding.readVarUint(probe) // skip outer MESSAGE_SYNC
        const syncType = decoding.readVarUint(probe)
        if (syncType === syncProtocol.messageYjsUpdate || syncType === syncProtocol.messageYjsSyncStep2) {
          // Read-only client cannot push updates into room.doc
          return
        }
      } catch {}
    }
  }

  switch (msgType) {
    case MESSAGE_SYNC: {
      try {
        const encoder = encoding.createEncoder()
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

    case MESSAGE_DURABLE_UPDATE: {
      handleDurableUpdate(ws, room, decoder)
      break
    }

    default:
      console.warn(`[room] unknown message type: ${msgType}`)
  }
}

function sendDurableAck(
  ws: ExtendedWebSocket,
  updateId: string,
  statusCode: number,
  hlc: string = '',
  error: string = ''
) {
  if (ws.readyState === WebSocket.OPEN) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_DURABLE_ACK)
    encoding.writeVarString(encoder, updateId)
    encoding.writeVarUint(encoder, statusCode)
    encoding.writeVarString(encoder, hlc)
    encoding.writeVarString(encoder, error)
    ws.send(encoding.toUint8Array(encoder))
  }
}

function recordAck(room: Room, updateId: string, record: DurableAckRecord) {
  if (room.durableAcks.size >= 1000) {
    const firstKey = room.durableAcks.keys().next().value
    if (firstKey) room.durableAcks.delete(firstKey)
  }
  room.durableAcks.set(updateId, record)
}

async function handleDurableUpdate(
  ws: ExtendedWebSocket,
  room: Room,
  decoder: decoding.Decoder
): Promise<void> {
  let updateId: string
  let update: Uint8Array
  try {
    updateId = decoding.readVarString(decoder)
    update = decoding.readVarUint8Array(decoder)
  } catch (err: any) {
    console.error('[room] Failed to decode durable update:', err)
    sendDurableAck(ws, 'unknown', ACK_STATUS_FAILED, '', 'MALFORMED_DURABLE_UPDATE')
    return
  }

  if (!updateId || typeof updateId !== 'string' || update.length === 0) {
    sendDurableAck(ws, updateId || 'unknown', ACK_STATUS_FAILED, '', 'INVALID_PAYLOAD')
    return
  }

  const payloadHash = crypto.createHash('sha256').update(update).digest('hex')

  // 1. Fast in-memory deduplication check
  const cached = room.durableAcks.get(updateId)
  if (cached && cached.status === 'durable') {
    if (cached.payloadHash && cached.payloadHash !== payloadHash) {
      sendDurableAck(
        ws,
        updateId,
        ACK_STATUS_FAILED,
        '',
        'UPDATE_ID_PAYLOAD_MISMATCH: updateId already used with different payload'
      )
      return
    }
    sendDurableAck(ws, updateId, ACK_STATUS_DURABLE, cached.hlc || '', '')
    return
  }

  // 2. Restart-safe & compaction-safe database deduplication check
  try {
    const dbAckRes = await dbPool.query(
      `SELECT status, hlc_timestamp, payload_hash FROM durable_acks WHERE doc_id = $1 AND update_id = $2`,
      [room.name, updateId]
    )
    if (dbAckRes.rows.length > 0) {
      const row = dbAckRes.rows[0]
      if (row.payload_hash && row.payload_hash !== payloadHash) {
        sendDurableAck(
          ws,
          updateId,
          ACK_STATUS_FAILED,
          '',
          'UPDATE_ID_PAYLOAD_MISMATCH: updateId already used with different payload'
        )
        return
      }
      if (row.status === 'durable') {
        recordAck(room, updateId, {
          status: 'durable',
          hlc: row.hlc_timestamp || undefined,
          payloadHash: row.payload_hash,
          timestamp: Date.now(),
        })
        sendDurableAck(ws, updateId, ACK_STATUS_DURABLE, row.hlc_timestamp || '', '')
        return
      }
    }
  } catch (err: any) {
    // If PostgreSQL query fails (e.g. offline), continue to write pipeline
  }

  // 3. Concurrent duplicate submission guard (in-flight serialization)
  const existingInFlight = room.inFlightUpdates.get(updateId)
  if (existingInFlight) {
    try {
      const outcome = await existingInFlight
      sendDurableAck(
        ws,
        updateId,
        outcome.status === 'durable' ? ACK_STATUS_DURABLE : ACK_STATUS_FAILED,
        outcome.hlc || '',
        outcome.error || ''
      )
    } catch (err: any) {
      sendDurableAck(ws, updateId, ACK_STATUS_FAILED, '', err?.message || 'IN_FLIGHT_ERROR')
    }
    return
  }

  // Register in-flight promise for concurrent duplicate submissions
  let resolveInFlight!: (val: { status: 'durable' | 'failed'; hlc?: string; error?: string }) => void
  const inFlightPromise = new Promise<{ status: 'durable' | 'failed'; hlc?: string; error?: string }>((res) => {
    resolveInFlight = res
  })
  room.inFlightUpdates.set(updateId, inFlightPromise)

  // 4. In-memory CRDT application
  try {
    Y.applyUpdate(room.doc, update, 'durable-apply')
  } catch (err: any) {
    const errorMsg = `CRDT_APPLY_FAILED: ${err.message}`
    recordAck(room, updateId, { status: 'failed', error: errorMsg, payloadHash, timestamp: Date.now() })
    room.inFlightUpdates.delete(updateId)
    resolveInFlight({ status: 'failed', error: errorMsg })
    sendDurableAck(ws, updateId, ACK_STATUS_FAILED, '', errorMsg)
    return
  }

  // 5. In-memory peer broadcast (immediate)
  const syncEncoder = encoding.createEncoder()
  encoding.writeVarUint(syncEncoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(syncEncoder, update)
  broadcastExcept(room, encoding.toUint8Array(syncEncoder), ws)

  // 6. Dual persistence pipeline
  const hlc = generateHLC('server')
  const clientId = room.doc.clientID.toString()

  const writeOp = (async () => {
    let pgError: string | null = null
    let ldbError: string | null = null
    let finalHlc = hlc

    let pgClient: any = null
    try {
      pgClient = await dbPool.connect()

      // Wrap client query to support test harness overrides if dbPool.query was stubbed
      const originalPoolQuery = (dbPool as any).__originalQuery || dbPool.query
      const clientQuery = async (text: string, params?: any[]) => {
        if ((dbPool as any).query !== originalPoolQuery) {
          return (dbPool as any).query(text, params)
        }
        return pgClient.query(text, params)
      }

      await clientQuery('BEGIN')

      try {
        // 1. Insert into operations log with uniqueness enforcement
        const opInsert = await clientQuery(
          `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob, update_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (doc_id, update_id) WHERE update_id IS NOT NULL
           DO NOTHING
           RETURNING hlc_timestamp`,
          [room.name, clientId, hlc, Buffer.from(update), updateId]
        )

        if (opInsert.rows.length > 0 && opInsert.rows[0].hlc_timestamp) {
          finalHlc = opInsert.rows[0].hlc_timestamp
        } else {
          // If conflict occurred (operation already inserted), retrieve existing authoritative HLC
          const existingOp = await clientQuery(
            `SELECT hlc_timestamp FROM operations WHERE doc_id = $1 AND update_id = $2 LIMIT 1`,
            [room.name, updateId]
          )
          if (existingOp.rows.length > 0 && existingOp.rows[0].hlc_timestamp) {
            finalHlc = existingOp.rows[0].hlc_timestamp
          }
        }

        // 2. Persist corresponding durable idempotency record in durable_acks
        const ackInsert = await clientQuery(
          `INSERT INTO durable_acks (doc_id, update_id, status, hlc_timestamp, payload_hash)
           VALUES ($1, $2, 'durable', $3, $4)
           ON CONFLICT (doc_id, update_id) DO UPDATE 
           SET status = 'durable', hlc_timestamp = COALESCE(durable_acks.hlc_timestamp, EXCLUDED.hlc_timestamp)
           RETURNING hlc_timestamp, payload_hash`,
          [room.name, updateId, finalHlc, payloadHash]
        )

        const ackRow = ackInsert.rows[0]
        if (ackRow && ackRow.hlc_timestamp) {
          finalHlc = ackRow.hlc_timestamp
        }

        // 3. Commit transaction ensuring atomicity between operations and durable_acks
        await clientQuery('COMMIT')
        room.lastPersistedHlc = finalHlc
      } catch (txErr: any) {
        await clientQuery('ROLLBACK').catch(() => {})
        throw txErr
      }
    } catch (err: any) {
      pgError = err.message || 'Postgres insert failed'
      console.error(`[postgres] durable insert error:`, pgError)
    } finally {
      if (pgClient && typeof pgClient.release === 'function') {
        pgClient.release()
      }
    }

    try {
      await getPersistence().storeUpdate(room.name, update)
    } catch (err: any) {
      ldbError = err?.message || 'LevelDB store failed'
      console.error(`[leveldb] durable store error:`, ldbError)
    }

    room.inFlightUpdates.delete(updateId)

    if (!pgError && !ldbError) {
      recordAck(room, updateId, { status: 'durable', hlc: finalHlc, payloadHash, timestamp: Date.now() })
      resolveInFlight({ status: 'durable', hlc: finalHlc })
      sendDurableAck(ws, updateId, ACK_STATUS_DURABLE, finalHlc, '')
    } else {
      const combined = pgError && ldbError
        ? `PG_AND_LDB_FAILED: ${pgError}; ${ldbError}`
        : pgError
          ? `POSTGRES_FAILED: ${pgError}`
          : `LEVELDB_FAILED: ${ldbError}`
      recordAck(room, updateId, { status: 'failed', error: combined, payloadHash, timestamp: Date.now() })
      if (!pgError) {
        // If Postgres write succeeded but LevelDB failed, update durable_acks record to reflect failure
        dbPool.query(
          `UPDATE durable_acks SET status = 'failed' WHERE doc_id = $1 AND update_id = $2`,
          [room.name, updateId]
        ).catch(() => {})
      }
      resolveInFlight({ status: 'failed', error: combined })
      sendDurableAck(ws, updateId, ACK_STATUS_FAILED, '', combined)
    }
  })()

  room.persistenceQueue = room.persistenceQueue.then(() => writeOp).catch(() => {})
}

// ── Public entry point ─────────────────────────────────────────────────────────
export async function setupWSConnection(
  ws: ExtendedWebSocket,
  req: http.IncomingMessage,
  roomName: string
): Promise<void> {
  const config = getSecurityConfig()

  // 1. Document identifier syntax validation (prevents path traversal / injection)
  if (!isValidDocId(roomName)) {
    console.warn(`[security] Rejected connection with invalid room identifier: "${roomName}"`)
    ws.close(WS_CLOSE_BAD_REQUEST, 'Invalid room ID')
    return
  }

  // 2. WebSocket Origin allowlist validation
  const origin = req?.headers?.origin
  const originCheck = isOriginAllowed(origin, config.allowedOrigins)
  if (!originCheck.allowed) {
    console.warn(`[security] Rejected connection with disallowed origin: "${origin}"`)
    ws.close(WS_CLOSE_POLICY_VIOLATION, 'Origin not allowed')
    return
  }

  // 3. Global capacity limits (mitigates memory exhaustion DoS)
  if (!rooms.has(roomName) && rooms.size >= config.maxRooms) {
    console.warn(`[security] Room creation rejected: maximum rooms (${config.maxRooms}) reached`)
    ws.close(WS_CLOSE_TOO_MANY_REQUESTS, 'Max rooms limit reached')
    return
  }

  let totalConnections = 0
  for (const [, r] of rooms) {
    totalConnections += r.clients.size
  }
  if (totalConnections >= config.maxTotalConnections) {
    console.warn(`[security] Connection rejected: server capacity (${config.maxTotalConnections}) reached`)
    ws.close(WS_CLOSE_TOO_MANY_REQUESTS, 'Server capacity reached')
    return
  }

  // 4. Authentication & Authorization
  const token = extractAuthTokenFromReq(req)
  const proxyClaims = extractProxyIdentity(req, config)

  let claims: AuthClaims | undefined = proxyClaims || undefined

  if (!claims && token && config.authSecret) {
    const verifyRes = verifyAuthToken(token, config.authSecret)
    if (!verifyRes.valid) {
      if (config.authRequired) {
        console.warn(`[security] Authentication failed for room "${roomName}":`, verifyRes.error)
        ws.close(WS_CLOSE_UNAUTHORIZED, `Authentication failed: ${verifyRes.error}`)
        return
      }
    } else {
      claims = verifyRes.claims
    }
  }

  if (config.authRequired) {
    if (!claims) {
      console.warn(`[security] Unauthenticated connection rejected for room "${roomName}"`)
      ws.close(WS_CLOSE_UNAUTHORIZED, 'Authentication required')
      return
    }

    // Verify room access permissions
    const authRes = isAuthorizedForRoom(claims, roomName, 'viewer')
    if (!authRes.authorized) {
      console.warn(`[security] Authorization rejected for room "${roomName}":`, authRes.reason)
      ws.close(WS_CLOSE_FORBIDDEN, `Forbidden: ${authRes.reason}`)
      return
    }
  }

  if (claims) {
    ws.authContext = claims
  }

  const room = getRoom(roomName)

  // 5. Per-Room Connection Limit
  if (room.clients.size >= config.maxClientsPerRoom) {
    console.warn(`[security] Room "${roomName}" connection rejected: maximum clients (${config.maxClientsPerRoom}) reached`)
    ws.close(WS_CLOSE_TOO_MANY_REQUESTS, 'Room client limit reached')
    return
  }

  // Reserve client slot immediately so concurrent handshakes cannot bypass capacity
  room.clients.add(ws)

  // Attach rate limiter
  ws.rateLimiter = new ConnectionRateLimiter(config.maxMessagesPerSec)

  // Mark connection alive and attach error listener synchronously to catch early transport errors
  ws.isAlive = true
  ws.on('error', (err: any) => {
    console.warn(`[room] socket error in room "${roomName}":`, err.message)
  })

  ws.on('pong', () => {
    ws.isAlive = true
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

  // Buffer messages arriving while LevelDB persistence is loading into room.doc
  const preLoadQueue: RawData[] = []
  let isRoomLoaded = false

  ws.on('message', (data) => {
    if (!isRoomLoaded) {
      preLoadQueue.push(data)
      return
    }
    try {
      handleMessage(ws, room, data)
    } catch (err) {
      console.error('[room] message handling error:', err)
    }
  })

  // Ensure persistent state is fully restored before handshake
  await room.loadedPromise
  isRoomLoaded = true

  // Drain any queued messages received while loading persistence
  for (const queued of preLoadQueue) {
    try {
      handleMessage(ws, room, queued)
    } catch (err) {
      console.error('[room] queued message handling error:', err)
    }
  }

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
