import path from 'path'
import fs from 'fs'

const TEST_LEVELDB_DIR = path.resolve(__dirname, `../../data/test-leveldb-tx-${Date.now()}`)
process.env.LEVELDB_DIR = TEST_LEVELDB_DIR

import http from 'http'
import { AddressInfo } from 'net'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import {
  setupWSConnection,
  getRoom,
  flushRoomPersistence,
  flushAllRooms,
  closeRoom,
  closeAllRooms,
  MESSAGE_SYNC,
  MESSAGE_DURABLE_UPDATE,
  MESSAGE_DURABLE_ACK,
  ACK_STATUS_DURABLE,
  ACK_STATUS_FAILED,
} from '../room.js'
import { dbPool, initDb } from '../db.js'
import { getPersistence, closePersistence } from '../persistence.js'
import { generateHLC } from '../hlc.js'

class DurableTestClient {
  public doc: Y.Doc
  public ws: WebSocket | null = null
  public url: string
  public connected: boolean = false
  public clientID: number
  public pendingAcks = new Map<
    string,
    {
      resolve: (res: { status: 'durable' | 'failed'; hlc?: string; error?: string }) => void
      reject: (err: any) => void
      timer: NodeJS.Timeout
    }
  >()

  constructor(url: string, doc = new Y.Doc()) {
    this.url = url
    this.doc = doc
    this.clientID = this.doc.clientID
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.on('open', () => {
        this.connected = true
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeSyncStep1(encoder, this.doc)
        this.ws!.send(encoding.toUint8Array(encoder))
        resolve()
      })

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)
          const decoder = decoding.createDecoder(new Uint8Array(buf))
          const msgType = decoding.readVarUint(decoder)

          if (msgType === MESSAGE_SYNC) {
            const replyEncoder = encoding.createEncoder()
            encoding.writeVarUint(replyEncoder, MESSAGE_SYNC)
            syncProtocol.readSyncMessage(decoder, replyEncoder, this.doc, 'remote')
            if (encoding.length(replyEncoder) > 1 && this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(encoding.toUint8Array(replyEncoder))
            }
          } else if (msgType === MESSAGE_DURABLE_ACK) {
            const updateId = decoding.readVarString(decoder)
            const statusCode = decoding.readVarUint(decoder)
            const hlc = decoding.readVarString(decoder)
            const error = decoding.readVarString(decoder)

            const pending = this.pendingAcks.get(updateId)
            if (pending) {
              clearTimeout(pending.timer)
              this.pendingAcks.delete(updateId)
              pending.resolve({
                status: statusCode === ACK_STATUS_DURABLE ? 'durable' : 'failed',
                hlc: hlc || undefined,
                error: error || undefined,
              })
            }
          }
        } catch (err) {
          console.error('[DurableTestClient] message error:', err)
        }
      })

      this.ws.on('error', (err) => reject(err))
    })
  }

  async submitDurableUpdate(
    updateId: string,
    update: Uint8Array,
    timeoutMs = 3000
  ): Promise<{ status: 'durable' | 'failed'; hlc?: string; error?: string }> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Client not connected')
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(updateId)
        reject(new Error(`DURABLE_ACK_TIMEOUT: Update "${updateId}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingAcks.set(updateId, { resolve, reject, timer })

      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_DURABLE_UPDATE)
      encoding.writeVarString(encoder, updateId)
      encoding.writeVarUint8Array(encoder, update)
      this.ws!.send(encoding.toUint8Array(encoder))
    })
  }

  async disconnect(): Promise<void> {
    this.connected = false
    for (const [, p] of this.pendingAcks) {
      clearTimeout(p.timer)
      p.reject(new Error('Client disconnected before acknowledgement'))
    }
    this.pendingAcks.clear()

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      await new Promise<void>((resolve) => {
        this.ws!.once('close', () => resolve())
        this.ws!.close()
      })
    }
    this.ws = null
  }
}

describe('PostgreSQL Transaction Semantics, Database Uniqueness & Graceful Shutdown Suite', () => {
  let server: http.Server
  let wss: WebSocketServer
  let serverPort: number
  let baseUrl: string

  const startTestServer = async (): Promise<void> => {
    return new Promise((resolve) => {
      server = http.createServer((_req, res) => res.end('ok'))
      wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 })
      wss.on('connection', (ws, req) => {
        ws.on('error', () => {})
        const url = new URL(req.url ?? '/', `http://localhost:${serverPort}`)
        const roomName = url.pathname.slice(1) || 'default'
        setupWSConnection(ws as any, req, roomName).catch((err) => {
          console.error('[test-ws] setup error:', err)
        })
      })

      server.listen(0, '127.0.0.1', () => {
        serverPort = (server.address() as AddressInfo).port
        baseUrl = `ws://127.0.0.1:${serverPort}`
        resolve()
      })
    })
  }

  const stopTestServer = async (): Promise<void> => {
    return new Promise((resolve) => {
      for (const client of wss.clients) {
        client.terminate()
      }
      wss.close(() => {
        server.close(() => resolve())
      })
    })
  }

  beforeAll(async () => {
    await initDb()
    await startTestServer()
  })

  afterAll(async () => {
    await stopTestServer()
    await closePersistence()
    try {
      fs.rmSync(TEST_LEVELDB_DIR, { recursive: true, force: true })
    } catch {}
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Operation insertion fails -> Transaction rollback -> 0 rows in either table
  // ───────────────────────────────────────────────────────────────────────────
  it('1. Operation insertion fails: transaction rolls back so no durable_acks row is committed', async () => {
    const roomName = `tx-s1-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Should rollback completely;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-tx-fail-op-${Date.now()}`

    // Inject failure specifically on INSERT INTO operations
    const originalQuery = (dbPool as any).query.bind(dbPool)
    ;(dbPool as any).query = async (text: any, params: any) => {
      if (typeof text === 'string' && text.includes('INSERT INTO operations')) {
        throw new Error('SIMULATED_DB_ERROR: Operation write failed')
      }
      return originalQuery(text, params)
    }

    try {
      const ack = await client.submitDurableUpdate(updateId, update)
      expect(ack.status).toBe('failed')
      expect(ack.error).toContain('SIMULATED_DB_ERROR')

      // Assert database transaction rolled back cleanly
      const opCheck = await originalQuery(
        `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
        [roomName, updateId]
      )
      expect(parseInt(opCheck.rows[0].count, 10)).toBe(0)

      const ackCheck = await originalQuery(
        `SELECT COUNT(*) FROM durable_acks WHERE doc_id = $1 AND update_id = $2`,
        [roomName, updateId]
      )
      expect(parseInt(ackCheck.rows[0].count, 10)).toBe(0)
    } finally {
      ;(dbPool as any).query = originalQuery
      await client.disconnect()
      closeRoom(roomName)
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Idempotency insertion fails -> Operation insertion is rolled back
  // ───────────────────────────────────────────────────────────────────────────
  it('2. Idempotency insertion fails: operation insertion is rolled back completely', async () => {
    const roomName = `tx-s2-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Should rollback operation;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-tx-fail-ack-${Date.now()}`

    // Inject failure specifically on INSERT INTO durable_acks
    const originalQuery = (dbPool as any).query.bind(dbPool)
    ;(dbPool as any).query = async (text: any, params: any) => {
      if (typeof text === 'string' && text.includes('INSERT INTO durable_acks')) {
        throw new Error('SIMULATED_DB_ERROR: durable_acks write failed')
      }
      return originalQuery(text, params)
    }

    try {
      const ack = await client.submitDurableUpdate(updateId, update)
      expect(ack.status).toBe('failed')
      expect(ack.error).toContain('SIMULATED_DB_ERROR')

      // Crucial verification: operations insert MUST HAVE BEEN ROLLED BACK!
      const opCheck = await originalQuery(
        `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
        [roomName, updateId]
      )
      expect(parseInt(opCheck.rows[0].count, 10)).toBe(0)

      const ackCheck = await originalQuery(
        `SELECT COUNT(*) FROM durable_acks WHERE doc_id = $1 AND update_id = $2`,
        [roomName, updateId]
      )
      expect(parseInt(ackCheck.rows[0].count, 10)).toBe(0)
    } finally {
      ;(dbPool as any).query = originalQuery
      await client.disconnect()
      closeRoom(roomName)
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Both insertions succeed -> Transaction commits -> Consistent records
  // ───────────────────────────────────────────────────────────────────────────
  it('3. Both insertions and transaction commit succeed consistently in PostgreSQL', async () => {
    const roomName = `tx-s3-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Successful transaction commit;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-tx-s3-${Date.now()}`

    const ack = await client.submitDurableUpdate(updateId, update)
    expect(ack.status).toBe('durable')
    expect(ack.hlc).toBeDefined()

    // Verify operations table
    const opCheck = await dbPool.query(
      `SELECT hlc_timestamp, update_id FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(opCheck.rows.length).toBe(1)
    expect(opCheck.rows[0].hlc_timestamp).toBe(ack.hlc)

    // Verify durable_acks table
    const ackCheck = await dbPool.query(
      `SELECT status, hlc_timestamp, payload_hash FROM durable_acks WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(ackCheck.rows.length).toBe(1)
    expect(ackCheck.rows[0].status).toBe('durable')
    expect(ackCheck.rows[0].hlc_timestamp).toBe(ack.hlc)

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Committed transaction followed by lost acknowledgement is safely retried
  // ───────────────────────────────────────────────────────────────────────────
  it('4. A committed transaction followed by lost ACK is safely retried idempotently', async () => {
    const roomName = `tx-s4-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Retry after lost ACK;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-tx-s4-${Date.now()}`

    const firstAck = await client.submitDurableUpdate(updateId, update)
    expect(firstAck.status).toBe('durable')

    // Disconnect and reconnect to simulate lost ACK / retry on new connection
    await client.disconnect()
    const retryClient = new DurableTestClient(url)
    await retryClient.connect()

    const retryAck = await retryClient.submitDurableUpdate(updateId, update)
    expect(retryAck.status).toBe('durable')
    expect(retryAck.hlc).toBe(firstAck.hlc)

    // Verify strictly 1 row in operations table
    const opCount = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opCount.rows[0].count, 10)).toBe(1)

    await retryClient.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Concurrent requests with same document and update ID produce 1 canonical op
  // ───────────────────────────────────────────────────────────────────────────
  it('5. Concurrent duplicate requests produce exactly one canonical operation via DB uniqueness', async () => {
    const roomName = `tx-s5-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new DurableTestClient(url)
    const c2 = new DurableTestClient(url)
    await Promise.all([c1.connect(), c2.connect()])

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Concurrent idempotency submission;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-tx-s5-${Date.now()}`

    // Submit simultaneously across two WebSocket connections
    const [ack1, ack2] = await Promise.all([
      c1.submitDurableUpdate(updateId, update),
      c2.submitDurableUpdate(updateId, update),
    ])

    expect(ack1.status).toBe('durable')
    expect(ack2.status).toBe('durable')
    expect(ack1.hlc).toBe(ack2.hlc)

    // Operations table must contain exactly 1 row
    const opCount = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opCount.rows[0].count, 10)).toBe(1)

    // Test direct database level constraint: attempt an independent direct SQL insert with same update_id
    const directInsert = await dbPool.query(
      `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob, update_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (doc_id, update_id) WHERE update_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [roomName, 'direct-client', '999-9-test', Buffer.from(update), updateId]
    )
    // The conflict was trapped by idx_ops_doc_update_id_unique!
    expect(directInsert.rows.length).toBe(0)

    await Promise.all([c1.disconnect(), c2.disconnect()])
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Reusing same update ID with different payload is rejected
  // ───────────────────────────────────────────────────────────────────────────
  it('6. Reusing same update ID with different payload is rejected without DB corruption', async () => {
    const roomName = `tx-s6-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const client = new DurableTestClient(url)
    await client.connect()

    const docA = new Y.Doc()
    docA.getText('content').insert(0, 'Payload A;\n')
    const updateA = Y.encodeStateAsUpdate(docA)
    const updateId = `up-tx-s6-${Date.now()}`

    const ackA = await client.submitDurableUpdate(updateId, updateA)
    expect(ackA.status).toBe('durable')

    // Submit different payload with same updateId
    const docB = new Y.Doc()
    docB.getText('content').insert(0, 'Conflicting Payload B;\n')
    const updateB = Y.encodeStateAsUpdate(docB)

    const ackB = await client.submitDurableUpdate(updateId, updateB)
    expect(ackB.status).toBe('failed')
    expect(ackB.error).toContain('UPDATE_ID_PAYLOAD_MISMATCH')

    // Verify room content remains uncorrupted
    const room = getRoom(roomName)
    expect(room.doc.getText('content').toString()).toBe('Payload A;\n')

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 7. LevelDB failure after PostgreSQL commit does not corrupt canonical database
  // ───────────────────────────────────────────────────────────────────────────
  it('7. LevelDB failure after PostgreSQL commit preserves canonical DB and enables retry repair', async () => {
    const roomName = `tx-s7-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'LevelDB failure test;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-tx-s7-${Date.now()}`

    const persistence = getPersistence()
    const originalStore = persistence.storeUpdate.bind(persistence)
    persistence.storeUpdate = async () => {
      throw new Error('EIO: Simulated disk failure during LevelDB storeUpdate')
    }

    try {
      const ackFail = await client.submitDurableUpdate(updateId, update)
      expect(ackFail.status).toBe('failed')
      expect(ackFail.error).toContain('LEVELDB_FAILED')

      // Crucial verification: Canonical PostgreSQL operations record DOES exist!
      const opCheck = await dbPool.query(
        `SELECT COUNT(*), MAX(hlc_timestamp) as hlc FROM operations WHERE doc_id = $1 AND update_id = $2`,
        [roomName, updateId]
      )
      expect(parseInt(opCheck.rows[0].count, 10)).toBe(1)
      const committedHlc = opCheck.rows[0].hlc

      // durable_acks reflects failure because LevelDB failed
      const ackCheck = await dbPool.query(
        `SELECT status FROM durable_acks WHERE doc_id = $1 AND update_id = $2`,
        [roomName, updateId]
      )
      expect(ackCheck.rows[0].status).toBe('failed')

      // Now restore LevelDB storage and retry
      persistence.storeUpdate = originalStore

      const ackSuccess = await client.submitDurableUpdate(updateId, update)
      expect(ackSuccess.status).toBe('durable')
      expect(ackSuccess.hlc).toBe(committedHlc)

      // Still exactly 1 row in operations table
      const opCountAfter = await dbPool.query(
        `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
        [roomName, updateId]
      )
      expect(parseInt(opCountAfter.rows[0].count, 10)).toBe(1)
    } finally {
      persistence.storeUpdate = originalStore
      await client.disconnect()
      closeRoom(roomName)
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Restart after LevelDB failure repairs working cache without duplicate operations
  // ───────────────────────────────────────────────────────────────────────────
  it('8. Cold restart after LevelDB failure repairs working cache from PostgreSQL without duplicates', async () => {
    const roomName = `tx-s8-${Date.now()}`

    // Directly insert committed state into PostgreSQL as if LevelDB crashed before write
    const docPreCrash = new Y.Doc()
    docPreCrash.getText('content').insert(0, 'Canonical PostgreSQL state to repair LevelDB;\n')
    const update = Y.encodeStateAsUpdate(docPreCrash)
    const hlc = generateHLC('server')
    const updateId = `up-tx-s8-${Date.now()}`

    await dbPool.query(
      `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob, update_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [roomName, 'cold-client', hlc, Buffer.from(update), updateId]
    )
    await dbPool.query(
      `INSERT INTO durable_acks (doc_id, update_id, status, hlc_timestamp, payload_hash)
       VALUES ($1, $2, 'durable', $3, 'test-hash')`,
      [roomName, updateId, hlc]
    )

    // LevelDB has NOT received this update.
    // Start room on cold restart:
    const coldRoom = getRoom(roomName)
    await coldRoom.loadedPromise

    // Verify reconstructed document matches
    expect(coldRoom.doc.getText('content').toString()).toBe('Canonical PostgreSQL state to repair LevelDB;\n')

    // Verify operations table count remains 1
    const opCount = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opCount.rows[0].count, 10)).toBe(1)

    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Graceful shutdown drains pending room persistence queues and LevelDB writes
  // ───────────────────────────────────────────────────────────────────────────
  it('9. Graceful shutdown drains pending room persistence queues and LevelDB writes completely', async () => {
    const roomName = `tx-s9-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'In flight during shutdown;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-tx-s9-${Date.now()}`

    // Dispatch update
    const ackPromise = client.submitDurableUpdate(updateId, update)

    // Trigger flushAllRooms
    const flushRes = await flushAllRooms(5000)
    expect(flushRes.errors.length).toBe(0)
    expect(flushRes.flushedCount).toBeGreaterThanOrEqual(1)

    const ack = await ackPromise
    expect(ack.status).toBe('durable')

    // Verify database row exists
    const opCount = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opCount.rows[0].count, 10)).toBe(1)

    await client.disconnect()
    closeAllRooms()
  })
})

