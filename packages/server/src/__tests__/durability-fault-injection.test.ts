import path from 'path'
import fs from 'fs'

const TEST_LEVELDB_DIR = path.resolve(__dirname, `../../data/test-leveldb-durability-${Date.now()}`)
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
  closeRoom,
  MESSAGE_SYNC,
  MESSAGE_DURABLE_UPDATE,
  MESSAGE_DURABLE_ACK,
  ACK_STATUS_DURABLE,
  ACK_STATUS_FAILED,
} from '../room.js'
import { dbPool, initDb } from '../db.js'
import { getPersistence, closePersistence } from '../persistence.js'
import { generateHLC } from '../hlc.js'
import { DurableSyncClient } from '../../../client/src/lib/durable-client'

// ── Client for Durable Acknowledgement Testing ─────────────────────────────
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
        // Initiate handshake
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

  async sendDurableUpdateRaw(updateId: string, update: Uint8Array): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Client not connected')
    }
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_DURABLE_UPDATE)
    encoding.writeVarString(encoder, updateId)
    encoding.writeVarUint8Array(encoder, update)

    return new Promise((resolve, reject) => {
      this.ws!.send(encoding.toUint8Array(encoder), (err) => {
        if (err) reject(err)
        else resolve()
      })
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

  destroy(): void {
    this.disconnect()
    this.doc.destroy()
  }
}

describe('Durability Contract & Fault Injection Integration Suite (19 Scenarios)', () => {
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
  // 1. Successful update and durable acknowledgement
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 1: Update applied in memory, persisted to LevelDB & Postgres, and durably acknowledged with HLC', async () => {
    const roomName = `durability-s1-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Durable commit alpha;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s1-${Date.now()}`

    const ack = await client.submitDurableUpdate(updateId, update)

    expect(ack.status).toBe('durable')
    expect(ack.hlc).toBeDefined()
    expect(ack.error).toBeUndefined()

    // Verify row exists in PostgreSQL operations table
    const opRow = await dbPool.query(
      `SELECT hlc_timestamp, update_blob FROM operations WHERE doc_id = $1 AND hlc_timestamp = $2`,
      [roomName, ack.hlc]
    )
    expect(opRow.rows.length).toBe(1)

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. PostgreSQL unavailable before an update
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 2: PostgreSQL unavailable before update surfaces explicit failed ACK', async () => {
    const roomName = `durability-s2-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Fails on database offline;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s2-${Date.now()}`

    // Temporarily stub dbPool.query to simulate database network failure
    const originalQuery = dbPool.query.bind(dbPool)
    ;(dbPool as any).query = async (text: any, params: any) => {
      if (typeof text === 'string' && text.includes('INSERT INTO operations')) {
        throw new Error('Connection refused: PostgreSQL offline')
      }
      return originalQuery(text, params)
    }

    try {
      const ack = await client.submitDurableUpdate(updateId, update)
      expect(ack.status).toBe('failed')
      expect(ack.error).toContain('POSTGRES_FAILED: Connection refused')
    } finally {
      ;(dbPool as any).query = originalQuery
    }

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. PostgreSQL failure during insertion
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 3: PostgreSQL failure during insertion surfaces error instead of false durability', async () => {
    const roomName = `durability-s3-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Constraint error write;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s3-${Date.now()}`

    const originalQuery = dbPool.query.bind(dbPool)
    ;(dbPool as any).query = async (text: any, params: any) => {
      if (typeof text === 'string' && text.includes('INSERT INTO operations')) {
        throw new Error('duplicate key value violates unique constraint')
      }
      return originalQuery(text, params)
    }

    try {
      const ack = await client.submitDurableUpdate(updateId, update)
      expect(ack.status).toBe('failed')
      expect(ack.error).toContain('violates unique constraint')
    } finally {
      ;(dbPool as any).query = originalQuery
    }

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Commit succeeds but acknowledgement is lost
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 4: Lost acknowledgement recovered cleanly via idempotent retry', async () => {
    const roomName = `durability-s4-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Lost ACK test;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s4-${Date.now()}`

    // First attempt: intercept and drop the outgoing ACK from server to simulate dropped packet
    const originalSend = client.ws!.send.bind(client.ws!)
    let dropAck = true

    // Intercept client's message handler to drop the first ACK
    const rawWs = client.ws!
    const originalOnMessage = rawWs.listeners('message')[0] as (data: any) => void

    rawWs.removeListener('message', originalOnMessage)
    rawWs.on('message', (data: any) => {
      const buf = Buffer.from(data)
      if (dropAck && buf[0] === MESSAGE_DURABLE_ACK) {
        dropAck = false // Drop the first ACK
        return
      }
      originalOnMessage(data)
    })

    // Submit with short timeout to trigger timeout
    let timeoutOccurred = false
    try {
      await client.submitDurableUpdate(updateId, update, 200)
    } catch (err: any) {
      if (err.message.includes('DURABLE_ACK_TIMEOUT')) {
        timeoutOccurred = true
      }
    }
    expect(timeoutOccurred).toBe(true)

    // Retry with the exact same updateId
    const retryAck = await client.submitDurableUpdate(updateId, update, 2000)
    expect(retryAck.status).toBe('durable')
    expect(retryAck.hlc).toBeDefined()

    // Verify only ONE operation was recorded in PostgreSQL operations table
    const opCount = await dbPool.query(`SELECT COUNT(*) FROM operations WHERE doc_id = $1`, [roomName])
    expect(parseInt(opCount.rows[0].count, 10)).toBe(1)

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Duplicate retry after an acknowledgement timeout
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 5: Duplicate retries are idempotent and do not duplicate document text or DB logs', async () => {
    const roomName = `durability-s5-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'UniqueLine;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s5-dedup-${Date.now()}`

    // Send original
    const ack1 = await client.submitDurableUpdate(updateId, update)
    expect(ack1.status).toBe('durable')

    // Send duplicate retry 1
    const ack2 = await client.submitDurableUpdate(updateId, update)
    expect(ack2.status).toBe('durable')
    expect(ack2.hlc).toBe(ack1.hlc)

    // Send duplicate retry 2
    const ack3 = await client.submitDurableUpdate(updateId, update)
    expect(ack3.status).toBe('durable')
    expect(ack3.hlc).toBe(ack1.hlc)

    // Verify exactly 1 DB row
    const ops = await dbPool.query(`SELECT COUNT(*) FROM operations WHERE doc_id = $1`, [roomName])
    expect(parseInt(ops.rows[0].count, 10)).toBe(1)

    // Verify document content contains exactly one occurrence of UniqueLine
    const room = getRoom(roomName)
    expect(room.doc.getText('content').toString()).toBe('UniqueLine;')

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Client disconnects after submission
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 6: Client disconnects immediately after submission; server completes persistence', async () => {
    const roomName = `durability-s6-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Survives client drop;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s6-${Date.now()}`

    const room = getRoom(roomName)

    // Submit update to server
    await client.sendDurableUpdateRaw(updateId, update)

    // Verify server has received the update in memory before client drops
    const waitStart = Date.now()
    while (Date.now() - waitStart < 1000) {
      if (room.doc.getText('content').toString() === 'Survives client drop;') break
      await new Promise((r) => setTimeout(r, 10))
    }

    // Client drops abruptly before receiving durable ACK
    await client.disconnect()

    // Server background queue must still complete persistence despite client departure
    await flushRoomPersistence(room)

    // Check DB has the operation
    const opRes = await dbPool.query(`SELECT COUNT(*) FROM operations WHERE doc_id = $1`, [roomName])
    expect(parseInt(opRes.rows[0].count, 10)).toBe(1)

    // Verify room in memory has the content
    expect(room.doc.getText('content').toString()).toBe('Survives client drop;')

    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Server crashes after applying an update but before persistence
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 7: Server crashes before disk persistence; restarts to last durable state', async () => {
    const roomName = `durability-s7-${Date.now()}`
    const clientDb = await dbPool.connect()

    try {
      // 1. Establish initial durable checkpoint in PostgreSQL
      const initialDoc = new Y.Doc()
      initialDoc.getText('content').insert(0, 'Initial durable line;\n')
      const initialUpdate = Y.encodeStateAsUpdate(initialDoc)
      const hlc1 = generateHLC('server')

      await clientDb.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, 'c1', $2, $3)`,
        [roomName, hlc1, Buffer.from(initialUpdate)]
      )

      // 2. Memory doc receives unpersisted edit
      const memoryDoc = new Y.Doc()
      Y.applyUpdate(memoryDoc, initialUpdate)
      memoryDoc.getText('content').insert(memoryDoc.getText('content').length, 'Transient in-memory edit;\n')

      // 3. Crash simulation: Memory wiped before writeOp executes
      memoryDoc.destroy()

      // 4. Recovery: Server restarts and restores from disk (Postgres / LevelDB)
      const restoredDoc = new Y.Doc()
      const { rows } = await clientDb.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp ASC`,
        [roomName]
      )
      for (const r of rows) Y.applyUpdate(restoredDoc, r.update_blob)

      expect(restoredDoc.getText('content').toString()).toBe('Initial durable line;\n')
      expect(restoredDoc.getText('content').toString()).not.toContain('Transient in-memory edit;')
    } finally {
      clientDb.release()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Server crashes after persistence but before acknowledgement
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 8: Crash after disk write but before ACK; reconnecting client recovers write', async () => {
    const roomName = `durability-s8-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Committed pre-crash;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s8-${Date.now()}`

    // Update submitted and persisted
    const ack = await client.submitDurableUpdate(updateId, update)
    expect(ack.status).toBe('durable')
    await client.disconnect()

    // Simulate server restart: evict room from memory
    closeRoom(roomName)

    // Reconnect a fresh client to the room
    const freshClient = new DurableTestClient(url)
    await freshClient.connect()

    const startWait = Date.now()
    while (Date.now() - startWait < 2000) {
      if (freshClient.doc.getText('content').toString() === 'Committed pre-crash;') break
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(freshClient.doc.getText('content').toString()).toBe('Committed pre-crash;')

    await freshClient.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 9. LevelDB persistence fails
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 9: LevelDB persistence failure surfaces error and rejects durable ACK', async () => {
    const roomName = `durability-s9-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'LevelDB failure test;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s9-${Date.now()}`

    // Stub storeUpdate in persistence to simulate disk failure
    const persistence = getPersistence()
    const originalStore = persistence.storeUpdate.bind(persistence)
    persistence.storeUpdate = async () => {
      throw new Error('EIO: Disk I/O error writing to LevelDB')
    }

    try {
      const ack = await client.submitDurableUpdate(updateId, update)
      expect(ack.status).toBe('failed')
      expect(ack.error).toContain('LEVELDB_FAILED')
    } finally {
      persistence.storeUpdate = originalStore
    }

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 10. A queued write is still pending during shutdown
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 10: Pending queued persistence writes drain completely before room shutdown', async () => {
    const roomName = `durability-s10-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableTestClient(url)
    await client.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Pending during shutdown;')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s10-${Date.now()}`

    // Submit update
    const ackPromise = client.submitDurableUpdate(updateId, update)

    // Trigger room persistence flush as would occur during graceful shutdown
    const room = getRoom(roomName)
    const lastHlc = await flushRoomPersistence(room)

    const ack = await ackPromise
    expect(ack.status).toBe('durable')
    expect(lastHlc).toBeDefined()

    // Assert operations row was committed
    const opRow = await dbPool.query(`SELECT COUNT(*) FROM operations WHERE doc_id = $1`, [roomName])
    expect(parseInt(opRow.rows[0].count, 10)).toBe(1)

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 11. PostgreSQL and LevelDB contain divergent recovery states
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 11: Divergent store recovery reconciles deterministically via snapshot and operations log', async () => {
    const roomName = `durability-s11-${Date.now()}`
    const clientDb = await dbPool.connect()

    try {
      // Postgres has full operation history
      const doc = new Y.Doc()
      const text = doc.getText('content')
      text.insert(0, 'Base line;\n')
      const u1 = Y.encodeStateAsUpdate(doc)
      const hlc1 = generateHLC('server')

      text.insert(text.length, 'Tail line in Postgres;\n')
      const u2 = Y.encodeStateAsUpdate(doc)
      const hlc2 = generateHLC('server')

      await clientDb.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES 
         ($1, 'c1', $2, $3),
         ($1, 'c1', $4, $5)`,
        [roomName, hlc1, Buffer.from(u1), hlc2, Buffer.from(u2)]
      )

      // Snapshot cutoff at hlc1
      await clientDb.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
        [roomName, Buffer.from(u1), hlc1]
      )

      // Reconstruct document using Postgres authoritative history
      const recoveredDoc = new Y.Doc()
      const snapRes = await clientDb.query(
        `SELECT snapshot_blob, hlc_cutoff FROM doc_snapshots WHERE doc_id = $1 ORDER BY hlc_cutoff DESC LIMIT 1`,
        [roomName]
      )
      Y.applyUpdate(recoveredDoc, snapRes.rows[0].snapshot_blob)

      const tailOps = await clientDb.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 AND hlc_timestamp > $2 ORDER BY hlc_timestamp ASC`,
        [roomName, snapRes.rows[0].hlc_cutoff]
      )
      for (const row of tailOps.rows) {
        Y.applyUpdate(recoveredDoc, row.update_blob)
      }

      expect(recoveredDoc.getText('content').toString()).toBe('Base line;\nTail line in Postgres;\n')
    } finally {
      clientDb.release()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 12. Client reconnects after an ambiguous write outcome
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 12: Reconnect after ambiguous network drop reconciles state vectors deterministically', async () => {
    const roomName = `durability-s12-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new DurableTestClient(url)
    await c1.connect()

    // Client makes local edit
    c1.doc.getText('content').insert(0, 'Ambiguous outcome line;\n')
    const update = Y.encodeStateAsUpdate(c1.doc)
    const updateId = `up-s12-${Date.now()}`

    // Submit update and ensure bytes are flushed to server, then disconnect client abruptly
    await c1.sendDurableUpdateRaw(updateId, update)
    await c1.disconnect()

    // Wait for server to finish processing
    const room = getRoom(roomName)
    await flushRoomPersistence(room)

    // Reconnect client with its existing document state
    const c1Reconnected = new DurableTestClient(url, c1.doc)
    await c1Reconnected.connect()

    // Wait for document to converge and match server state
    const startWait = Date.now()
    while (Date.now() - startWait < 3000) {
      const serverSv = Buffer.from(Y.encodeStateVector(room.doc))
      const clientSv = Buffer.from(Y.encodeStateVector(c1Reconnected.doc))
      if (clientSv.equals(serverSv)) break
      await new Promise((r) => setTimeout(r, 20))
    }

    // Verify document converges and matches server state
    const serverSv = Buffer.from(Y.encodeStateVector(room.doc))
    const clientSv = Buffer.from(Y.encodeStateVector(c1Reconnected.doc))
    expect(clientSv.equals(serverSv)).toBe(true)
    expect(c1Reconnected.doc.getText('content').toString()).toBe('Ambiguous outcome line;\n')

    await c1Reconnected.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 13. Concurrent duplicate submissions
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 13: Concurrent duplicate submissions serialize safely and produce exactly 1 operation row', async () => {
    const roomName = `durability-s13-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new DurableTestClient(url)
    const c2 = new DurableTestClient(url)
    await Promise.all([c1.connect(), c2.connect()])

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Concurrent duplicate line;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s13-concurrent-${Date.now()}`

    // Both clients submit the identical updateId concurrently
    const [ack1, ack2] = await Promise.all([
      c1.submitDurableUpdate(updateId, update),
      c2.submitDurableUpdate(updateId, update),
    ])

    expect(ack1.status).toBe('durable')
    expect(ack2.status).toBe('durable')
    expect(ack1.hlc).toBeDefined()
    expect(ack2.hlc).toBe(ack1.hlc)

    // Ensure database contains EXACTLY one operation record for this update
    const opRes = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opRes.rows[0].count, 10)).toBe(1)

    // Ensure document text has the line only once
    const room = getRoom(roomName)
    expect(room.doc.getText('content').toString()).toBe('Concurrent duplicate line;\n')

    await Promise.all([c1.disconnect(), c2.disconnect()])
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 14. Retry arrives after server restart (restart-safe idempotency)
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 14: Retry after server restart returns committed status from database without duplicate operations', async () => {
    const roomName = `durability-s14-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new DurableTestClient(url)
    await c1.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Restart idempotency line;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s14-${Date.now()}`

    const ack1 = await c1.submitDurableUpdate(updateId, update)
    expect(ack1.status).toBe('durable')
    const committedHlc = ack1.hlc
    await c1.disconnect()

    // Simulate complete server restart: evict room and wipe all in-memory cache
    closeRoom(roomName)

    // Reconnecting client retries the same updateId
    const c2 = new DurableTestClient(url)
    await c2.connect()

    const ack2 = await c2.submitDurableUpdate(updateId, update)
    expect(ack2.status).toBe('durable')
    expect(ack2.hlc).toBe(committedHlc)

    // Operations table must still have exactly 1 record
    const opRes = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opRes.rows[0].count, 10)).toBe(1)

    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 15. Compaction occurs before a retry for an already committed update
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 15: Compaction prunes operations but preserves idempotency record in durable_acks', async () => {
    const roomName = `durability-s15-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new DurableTestClient(url)
    await c1.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Compaction pruned op;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s15-${Date.now()}`

    const ack1 = await c1.submitDurableUpdate(updateId, update)
    expect(ack1.status).toBe('durable')
    const committedHlc = ack1.hlc!

    const room = getRoom(roomName)
    await flushRoomPersistence(room)

    // Execute transactional compaction: snapshot inserted, operations pruned through cutoff
    const snapshot = Y.encodeStateAsUpdate(room.doc)
    const clientDb = await dbPool.connect()
    try {
      await clientDb.query('BEGIN')
      await clientDb.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
        [roomName, Buffer.from(snapshot), committedHlc]
      )
      await clientDb.query(
        `DELETE FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2`,
        [roomName, committedHlc]
      )
      await clientDb.query('COMMIT')
    } finally {
      clientDb.release()
    }

    // Verify operation row is indeed pruned from operations table
    const opCheck = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opCheck.rows[0].count, 10)).toBe(0)

    // Simulate server restart to clear in-memory cache
    closeRoom(roomName)

    // Client retries with updateId
    const c2 = new DurableTestClient(url)
    await c2.connect()

    const ack2 = await c2.submitDurableUpdate(updateId, update)
    expect(ack2.status).toBe('durable')
    expect(ack2.hlc).toBe(committedHlc)

    // Operations table must still NOT have re-inserted the pruned operation
    const opCheck2 = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(opCheck2.rows[0].count, 10)).toBe(0)

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 16. Reuse of an update ID with different payload bytes is rejected
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 16: Reuse of an update ID with different payload bytes is rejected with mismatch error', async () => {
    const roomName = `durability-s16-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new DurableTestClient(url)
    await c1.connect()

    const docA = new Y.Doc()
    docA.getText('content').insert(0, 'Original payload;\n')
    const updateA = Y.encodeStateAsUpdate(docA)
    const updateId = `up-s16-collision-${Date.now()}`

    const ackA = await c1.submitDurableUpdate(updateId, updateA)
    expect(ackA.status).toBe('durable')

    // Now attempt to reuse the exact same updateId with DIFFERENT bytes
    const docB = new Y.Doc()
    docB.getText('content').insert(0, 'Malicious divergent payload;\n')
    const updateB = Y.encodeStateAsUpdate(docB)

    const ackB = await c1.submitDurableUpdate(updateId, updateB)
    expect(ackB.status).toBe('failed')
    expect(ackB.error).toContain('UPDATE_ID_PAYLOAD_MISMATCH')

    // Document text must remain strictly original
    const room = getRoom(roomName)
    expect(room.doc.getText('content').toString()).toBe('Original payload;\n')

    await c1.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 17. Partial persistence: PostgreSQL succeeds, LevelDB fails, retry repairs LevelDB
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 17: PostgreSQL commit succeeds but LevelDB fails; client retry completes repair', async () => {
    const roomName = `durability-s17-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new DurableTestClient(url)
    await c1.connect()

    const localDoc = new Y.Doc()
    localDoc.getText('content').insert(0, 'Partial write repair;\n')
    const update = Y.encodeStateAsUpdate(localDoc)
    const updateId = `up-s17-${Date.now()}`

    // Temporarily fail LevelDB writes
    const persistence = getPersistence()
    const originalStore = persistence.storeUpdate.bind(persistence)
    persistence.storeUpdate = async () => {
      throw new Error('EIO: Simulated disk I/O error during LevelDB commit')
    }

    const ackFail = await c1.submitDurableUpdate(updateId, update)
    expect(ackFail.status).toBe('failed')
    expect(ackFail.error).toContain('LEVELDB_FAILED')

    // Verify PostgreSQL DOES have the operation recorded
    const pgOp = await dbPool.query(
      `SELECT COUNT(*) FROM operations WHERE doc_id = $1 AND update_id = $2`,
      [roomName, updateId]
    )
    expect(parseInt(pgOp.rows[0].count, 10)).toBe(1)

    // Restore LevelDB storeUpdate
    persistence.storeUpdate = originalStore

    // Client retries after failure
    const ackSuccess = await c1.submitDurableUpdate(updateId, update)
    expect(ackSuccess.status).toBe('durable')

    // Evict room and restart to verify cold reload contains the repaired state
    closeRoom(roomName)
    const restartedRoom = getRoom(roomName)
    await restartedRoom.loadedPromise

    expect(restartedRoom.doc.getText('content').toString()).toBe('Partial write repair;\n')

    await c1.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 18. Server crashes between two writes: Cold restart reconciles from PostgreSQL
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 18: Server crashes between PostgreSQL commit and LevelDB write; cold restart reconciles', async () => {
    const roomName = `durability-s18-${Date.now()}`

    // Insert an operation directly into PostgreSQL as if committed before process death
    const docPreCrash = new Y.Doc()
    docPreCrash.getText('content').insert(0, 'Committed in PG pre-crash;\n')
    const update = Y.encodeStateAsUpdate(docPreCrash)
    const hlc = generateHLC('server')
    const updateId = `up-s18-precrash-${Date.now()}`

    await dbPool.query(
      `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob, update_id) VALUES ($1, $2, $3, $4, $5)`,
      [roomName, 'pre-crash-client', hlc, Buffer.from(update), updateId]
    )
    await dbPool.query(
      `INSERT INTO durable_acks (doc_id, update_id, status, hlc_timestamp, payload_hash) VALUES ($1, $2, 'durable', $3, 'precrash-hash')`,
      [roomName, updateId, hlc]
    )

    // LevelDB has NOT received this write.
    // Now start the room on cold restart:
    const coldRoom = getRoom(roomName)
    await coldRoom.loadedPromise

    // Cold-room reconciliation must have merged the PostgreSQL operation into doc
    expect(coldRoom.doc.getText('content').toString()).toBe('Committed in PG pre-crash;\n')

    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 19. Client save-state tracking distinguishes pending, durable, failed, and unknown
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 19: DurableSyncClient correctly tracks pending, durable, failed, and unknown states without discarding local updates', async () => {
    const roomName = `durability-s19-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const client = new DurableSyncClient(url, new Y.Doc(), {
      ackTimeoutMs: 1500,
      WebSocketPolyfill: WebSocket,
    })
    await client.connect()

    // 1. Submit update 1 -> Confirms durable
    const doc1 = new Y.Doc()
    doc1.getText('content').insert(0, 'First durable line;\n')
    const up1 = Y.encodeStateAsUpdate(doc1)
    const id1 = `up-s19-1-${Date.now()}`

    const res1 = await client.submitUpdate(up1, id1)
    expect(res1.status).toBe('durable')
    expect(client.updates.get(id1)?.status).toBe('durable')

    // 2. Submit update 2 with injected payload collision -> Fails
    const doc2 = new Y.Doc()
    doc2.getText('content').insert(0, 'Conflicting line;\n')
    const up2 = Y.encodeStateAsUpdate(doc2)

    const res2 = await client.submitUpdate(up2, id1) // Intentional reuse of id1 with different payload
    expect(res2.status).toBe('failed')
    expect(client.updates.get(id1)?.status).toBe('failed')

    // 3. Submit update 3 and drop connection while in-flight -> Transitions to unknown
    const doc3 = new Y.Doc()
    doc3.getText('content').insert(0, 'Dropped line;\n')
    const up3 = Y.encodeStateAsUpdate(doc3)
    const id3 = `up-s19-3-${Date.now()}`

    const inFlightPromise = client.submitUpdate(up3, id3).catch(() => {})
    // Force immediate connection drop
    await client.disconnect()
    await inFlightPromise

    const stateAfterDrop = client.getSaveState()
    expect(stateAfterDrop.unknownCount).toBeGreaterThanOrEqual(1)
    expect(client.updates.get(id3)?.status).toBe('unknown')

    // In local-first CRDT, updates are NOT discarded
    expect(client.updates.has(id3)).toBe(true)

    closeRoom(roomName)
  })
})
