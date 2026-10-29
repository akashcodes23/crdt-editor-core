import path from 'path'
import fs from 'fs'

const TEST_LEVELDB_DIR = path.resolve(__dirname, `../../data/test-leveldb-monaco-e2e-${Date.now()}`)
process.env.LEVELDB_DIR = TEST_LEVELDB_DIR

import http from 'http'
import { AddressInfo } from 'net'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
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
  MESSAGE_AWARENESS,
  MESSAGE_DURABLE_UPDATE,
  MESSAGE_DURABLE_ACK,
  ACK_STATUS_DURABLE,
  ACK_STATUS_FAILED,
} from '../room.js'
import { dbPool, initDb } from '../db.js'
import { getPersistence, closePersistence } from '../persistence.js'
import { DurableSyncClient } from '../../../client/src/lib/durable-client'

describe('Durable Client & Monaco End-to-End Synchronization and Durability Suite', () => {
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
          console.error('[monaco-e2e-ws] setup error:', err)
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
  // 1. Local edit receives durable acknowledgement
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 1: Local edit in Monaco/Y.Doc triggers durable update and receives HLC-bearing ACK', async () => {
    const roomName = `monaco-e2e-s1-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const doc = new Y.Doc()

    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: true,
      ackTimeoutMs: 3000,
    })
    await client.connect()

    // Trigger local edit on the document (simulates Monaco editor typing)
    const codeText = doc.getText('code')
    codeText.insert(0, 'export const answer = 42;\n')

    // Wait for auto-submit and durable ACK
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for durable ACK')), 3000)
      client.on('save-status', (state: any) => {
        if (state.overallStatus === 'durable' && state.durableCount >= 1) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    const saveState = client.getSaveState()
    expect(saveState.overallStatus).toBe('durable')
    expect(saveState.durableCount).toBe(1)
    expect(saveState.latestConfirmedHlc).toBeDefined()
    expect(saveState.pendingCount).toBe(0)
    expect(saveState.failedCount).toBe(0)

    // Verify canonical PostgreSQL record
    const opRes = await dbPool.query(
      'SELECT doc_id, hlc_timestamp, update_id FROM operations WHERE doc_id = $1 ORDER BY id DESC LIMIT 1',
      [roomName]
    )
    expect(opRes.rows.length).toBe(1)
    expect(opRes.rows[0].hlc_timestamp).toBe(saveState.latestConfirmedHlc)

    const ackRes = await dbPool.query(
      'SELECT doc_id, status, hlc_timestamp FROM durable_acks WHERE doc_id = $1 AND update_id = $2',
      [roomName, opRes.rows[0].update_id]
    )
    expect(ackRes.rows.length).toBe(1)
    expect(ackRes.rows[0].status).toBe('durable')
    expect(ackRes.rows[0].hlc_timestamp).toBe(saveState.latestConfirmedHlc)

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Two clients converge
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 2: Two concurrent clients synchronize and converge on identical document state', async () => {
    const roomName = `monaco-e2e-s2-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const clientA = new DurableSyncClient(url, docA, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: true,
    })
    const clientB = new DurableSyncClient(url, docB, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: true,
    })

    await Promise.all([clientA.connect(), clientB.connect()])

    // Wait for initial sync step exchange
    await new Promise((r) => setTimeout(r, 100))

    // Client A inserts text
    docA.getText('code').insert(0, 'Hello from Client A\n')
    // Client B inserts text
    docB.getText('code').insert(0, 'Hello from Client B\n')

    // Wait for convergence and durable state
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Convergence timeout')), 4000)
      const checkConvergence = () => {
        if (
          docA.getText('code').toString() === docB.getText('code').toString() &&
          docA.getText('code').toString().includes('Client A') &&
          docA.getText('code').toString().includes('Client B') &&
          clientA.getSaveState().overallStatus === 'durable' &&
          clientB.getSaveState().overallStatus === 'durable'
        ) {
          clearTimeout(timeout)
          resolve()
        }
      }
      docA.on('update', checkConvergence)
      docB.on('update', checkConvergence)
      clientA.on('save-status', checkConvergence)
      clientB.on('save-status', checkConvergence)
      checkConvergence()
    })

    expect(docA.getText('code').toString()).toBe(docB.getText('code').toString())
    expect(clientA.getSaveState().overallStatus).toBe('durable')
    expect(clientB.getSaveState().overallStatus).toBe('durable')

    await Promise.all([clientA.disconnect(), clientB.disconnect()])
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Echo-loop prevention
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 3: Client receiving remote updates does NOT echo them back to the server', async () => {
    const roomName = `monaco-e2e-s3-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const clientA = new DurableSyncClient(url, docA, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: true,
    })
    const clientB = new DurableSyncClient(url, docB, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: true,
    })

    await Promise.all([clientA.connect(), clientB.connect()])
    await new Promise((r) => setTimeout(r, 100))

    // Client B should not submit any updates initially
    expect(clientB.updateOrder.length).toBe(0)

    // Client A makes an edit
    docA.getText('code').insert(0, 'echo-loop-guard-test\n')

    // Wait for Client B to receive the text
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for B to receive text')), 3000)
      docB.on('update', () => {
        if (docB.getText('code').toString().includes('echo-loop-guard-test')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    // Allow time for any errant echo to have fired
    await new Promise((r) => setTimeout(r, 300))

    // Crucial: Client B received the update but did NOT submit any update of its own!
    expect(docB.getText('code').toString()).toBe('echo-loop-guard-test\n')
    expect(clientB.updateOrder.length).toBe(0)
    expect(clientB.getSaveState().pendingCount).toBe(0)

    await Promise.all([clientA.disconnect(), clientB.disconnect()])
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Database failure before commit reflects 'failed' state in UI
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 4: PostgreSQL failure before commit causes update to be rejected with failed status', async () => {
    const roomName = `monaco-e2e-s4-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const doc = new Y.Doc()
    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: false,
      ackTimeoutMs: 1500,
    })
    await client.connect()

    // First submit a valid update
    const dummyDoc1 = new Y.Doc()
    dummyDoc1.getText('code').insert(0, 'Valid update\n')
    const up1 = Y.encodeStateAsUpdate(dummyDoc1)
    const updateId = `up-s4-conflict-${Date.now()}`

    const res1 = await client.submitUpdate(up1, updateId)
    expect(res1.status).toBe('durable')

    // Now submit conflicting payload under the SAME update ID (simulates transactional validation rejection)
    const dummyDoc2 = new Y.Doc()
    dummyDoc2.getText('code').insert(0, 'Malicious payload collision\n')
    const up2 = Y.encodeStateAsUpdate(dummyDoc2)

    const res2 = await client.submitUpdate(up2, updateId)
    expect(res2.status).toBe('failed')
    expect(res2.error).toContain('UPDATE_ID_PAYLOAD_MISMATCH')

    const saveState = client.getSaveState()
    expect(saveState.overallStatus).toBe('failed')
    expect(saveState.failedCount).toBe(1)

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. LevelDB failure after PostgreSQL commit preserves canonical persistence
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 5: LevelDB failure after PostgreSQL commit rejects durable ACK, preserves PG operation, and retry repairs LevelDB', async () => {
    const roomName = `monaco-e2e-s5-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const doc = new Y.Doc()
    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: false,
    })
    await client.connect()

    // Monkey-patch LevelDB storeUpdate to simulate LevelDB disk failure
    const levelPersist = getPersistence()
    const originalStore = levelPersist.storeUpdate.bind(levelPersist)
    levelPersist.storeUpdate = async () => {
      throw new Error('SIMULATED_LEVELDB_IO_ERROR')
    }

    const updateId = `up-s5-level-fail-${Date.now()}`
    try {
      const dummyDoc = new Y.Doc()
      dummyDoc.getText('code').insert(0, 'Canonical PG priority test\n')
      const up = Y.encodeStateAsUpdate(dummyDoc)

      const res = await client.submitUpdate(up, updateId)
      // LevelDB failure fails the durable confirmation
      expect(res.status).toBe('failed')
      expect(res.error).toContain('LEVELDB_FAILED')

      // But PostgreSQL canonical transaction already committed the operation record
      const checkRes = await dbPool.query(
        'SELECT COUNT(*)::int as count FROM operations WHERE doc_id = $1 AND update_id = $2',
        [roomName, updateId]
      )
      expect(checkRes.rows[0].count).toBe(1)
    } finally {
      levelPersist.storeUpdate = originalStore
    }

    // Now that LevelDB is restored, retry the update
    const retryRes = await client.retryUpdate(updateId)
    expect(retryRes.status).toBe('durable')
    expect(retryRes.hlc).toBeDefined()
    expect(client.getSaveState().overallStatus).toBe('durable')

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Lost ACK retry returns consistent duplicate ACK without duplicating records
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 6: Lost ACK retry returns consistent duplicate ACK without creating duplicate database records', async () => {
    const roomName = `monaco-e2e-s6-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const doc = new Y.Doc()
    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: false,
    })
    await client.connect()

    const dummyDoc = new Y.Doc()
    dummyDoc.getText('code').insert(0, 'Lost ACK payload\n')
    const up = Y.encodeStateAsUpdate(dummyDoc)
    const updateId = `up-s6-lost-ack-${Date.now()}`

    // First submission
    const res1 = await client.submitUpdate(up, updateId)
    expect(res1.status).toBe('durable')
    const originalHlc = res1.hlc

    // Client retries same updateId and payload (as if first ACK was lost in transit)
    const res2 = await client.retryUpdate(updateId)
    expect(res2.status).toBe('durable')
    expect(res2.hlc).toBe(originalHlc) // Consistent with original durable result

    // Ensure database uniqueness constraint prevented duplicate records
    const ackCount = await dbPool.query(
      'SELECT COUNT(*)::int as count FROM durable_acks WHERE doc_id = $1 AND update_id = $2',
      [roomName, updateId]
    )
    expect(ackCount.rows[0].count).toBe(1)

    const opCount = await dbPool.query(
      'SELECT COUNT(*)::int as count FROM operations WHERE doc_id = $1 AND update_id = $2',
      [roomName, updateId]
    )
    expect(opCount.rows[0].count).toBe(1)

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Disconnection during pending update transitions to 'unknown' outcome
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 7: Connection loss while update is pending marks status as unknown without dropping local edits', async () => {
    const roomName = `monaco-e2e-s7-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const doc = new Y.Doc()
    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: false,
      ackTimeoutMs: 3000,
    })
    await client.connect()

    const dummyDoc = new Y.Doc()
    dummyDoc.getText('code').insert(0, 'In-flight line\n')
    const up = Y.encodeStateAsUpdate(dummyDoc)
    const updateId = `up-s7-inflight-${Date.now()}`

    // Launch submission in flight
    const inFlight = client.submitUpdate(up, updateId).catch(() => {})

    // Drop connection immediately while in-flight
    await client.disconnect()
    await inFlight

    const saveState = client.getSaveState()
    expect(saveState.overallStatus).toBe('unknown')
    expect(saveState.unknownCount).toBe(1)
    expect(client.updates.get(updateId)?.status).toBe('unknown')

    // Crucial: Update is NOT discarded from client tracking
    expect(client.updates.has(updateId)).toBe(true)
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Reconnection after ambiguous outcome resynchronizes and confirms durability
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 8: Reconnecting after ambiguous outcome resynchronizes and transitions unknown update to durable', async () => {
    const roomName = `monaco-e2e-s8-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const doc = new Y.Doc()
    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: false,
      ackTimeoutMs: 3000,
    })
    await client.connect()

    const dummyDoc = new Y.Doc()
    dummyDoc.getText('code').insert(0, 'Resync after drop line\n')
    const up = Y.encodeStateAsUpdate(dummyDoc)
    const updateId = `up-s8-reconnect-${Date.now()}`

    // Submit update and disconnect
    const inFlight = client.submitUpdate(up, updateId).catch(() => {})
    await client.disconnect()
    await inFlight

    expect(client.updates.get(updateId)?.status).toBe('unknown')

    // Reconnect: client automatically executes retryAllUnconfirmed() on connection open
    await client.connect()

    // Wait for retry to confirm
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for durable confirmation on reconnect')), 3000)
      const checkState = () => {
        const s = client.getSaveState()
        if (s.overallStatus === 'durable' && s.unknownCount === 0 && s.durableCount >= 1) {
          clearTimeout(timeout)
          resolve()
        }
      }
      client.on('save-status', checkState)
      checkState()
    })

    const saveState = client.getSaveState()
    expect(saveState.overallStatus).toBe('durable')
    expect(saveState.unknownCount).toBe(0)
    expect(client.updates.get(updateId)?.status).toBe('durable')

    await client.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Duplicate retry after server restart recognizes persisted update ID
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 9: Update ID persisted in PostgreSQL is recognized after server restart and returns duplicate ACK', async () => {
    const roomName = `monaco-e2e-s9-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const doc = new Y.Doc()
    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: false,
    })
    await client.connect()

    const dummyDoc = new Y.Doc()
    dummyDoc.getText('code').insert(0, 'Restart test content\n')
    const up = Y.encodeStateAsUpdate(dummyDoc)
    const updateId = `up-s9-restart-${Date.now()}`

    const res1 = await client.submitUpdate(up, updateId)
    expect(res1.status).toBe('durable')
    const originalHlc = res1.hlc
    await client.disconnect()

    // Close room and clean in-memory state to simulate full process restart
    await flushRoomPersistence(getRoom(roomName))
    closeRoom(roomName)

    // Reconnect with new client instance (same room, persisted database)
    const client2 = new DurableSyncClient(url, new Y.Doc(), {
      WebSocketPolyfill: WebSocket,
      autoSubmit: false,
    })
    await client2.connect()

    // Retry update on fresh room instance
    const res2 = await client2.submitUpdate(up, updateId)
    expect(res2.status).toBe('durable')
    expect(res2.hlc).toBe(originalHlc)

    // Verify still exactly 1 record in PostgreSQL
    const opCount = await dbPool.query(
      'SELECT COUNT(*)::int as count FROM operations WHERE doc_id = $1 AND update_id = $2',
      [roomName, updateId]
    )
    expect(opCount.rows[0].count).toBe(1)

    await client2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Out-of-order ACKs update statuses independently without save-state corruption
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 10: Out-of-order ACKs correctly update individual update statuses without premature durable overall status', () => {
    const client = new DurableSyncClient('ws://mock', new Y.Doc(), {
      autoSubmit: false,
    })

    const id1 = 'up-order-1'
    const id2 = 'up-order-2'

    // Manually register two updates as pending
    client.updates.set(id1, {
      updateId: id1,
      payload: new Uint8Array([1]),
      status: 'pending',
      submittedAt: Date.now(),
      attemptCount: 1,
    })
    client.updateOrder.push(id1)

    client.updates.set(id2, {
      updateId: id2,
      payload: new Uint8Array([2]),
      status: 'pending',
      submittedAt: Date.now(),
      attemptCount: 1,
    })
    client.updateOrder.push(id2)

    expect(client.getSaveState().overallStatus).toBe('pending')
    expect(client.getSaveState().pendingCount).toBe(2)

    // Simulate ACK for update 2 arriving FIRST
    ;(client as any).processAck(id2, 'durable', 'hlc-2', '')

    const stateMid = client.getSaveState()
    // Overall status MUST NOT be 'durable' because id1 is still pending!
    expect(stateMid.overallStatus).toBe('pending')
    expect(stateMid.pendingCount).toBe(1)
    expect(stateMid.durableCount).toBe(1)
    expect(client.updates.get(id2)?.status).toBe('durable')
    expect(client.updates.get(id1)?.status).toBe('pending')

    // Now ACK for update 1 arrives
    ;(client as any).processAck(id1, 'durable', 'hlc-1', '')

    const stateFinal = client.getSaveState()
    expect(stateFinal.overallStatus).toBe('durable')
    expect(stateFinal.pendingCount).toBe(0)
    expect(stateFinal.durableCount).toBe(2)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 11. Unmount and cleanup
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 11: Destroy cleans up all WebSocket connections, awareness, and listeners without leaks', async () => {
    const roomName = `monaco-e2e-s11-${Date.now()}`
    const url = `${baseUrl}/${roomName}`
    const doc = new Y.Doc()

    const client = new DurableSyncClient(url, doc, {
      WebSocketPolyfill: WebSocket,
      autoSubmit: true,
    })
    await client.connect()
    expect(client.connected).toBe(true)

    // Destroy client
    client.destroy()

    expect(client.connected).toBe(false)
    expect(client.ws).toBeNull()

    // Verifying doc listener detached
    doc.getText('code').insert(0, 'post-destroy text')
    expect(client.updateOrder.length).toBe(0)

    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 12. Awareness and presence broadcast user cursor and name
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 12: Awareness protocol broadcasts cursor positions and user metadata to connected peers', async () => {
    const roomName = `monaco-e2e-s12-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const clientA = new DurableSyncClient(url, docA, {
      WebSocketPolyfill: WebSocket,
    })
    const clientB = new DurableSyncClient(url, docB, {
      WebSocketPolyfill: WebSocket,
    })

    await Promise.all([clientA.connect(), clientB.connect()])
    await new Promise((r) => setTimeout(r, 100))

    // Client A broadcasts awareness state
    clientA.awareness.setLocalState({
      user: { name: 'Alice', color: '#ff4444', clientID: docA.clientID },
      cursor: { index: 15, length: 0 },
    })

    // Wait for Client B to receive Client A's awareness update
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for awareness propagation')), 3000)
      const checkAwareness = () => {
        const stateA = clientB.awareness.getStates().get(docA.clientID) as any
        if (stateA && stateA.user && stateA.user.name === 'Alice' && stateA.cursor?.index === 15) {
          clearTimeout(timeout)
          resolve()
        }
      }
      clientB.awareness.on('change', checkAwareness)
      checkAwareness()
    })

    const peerState = clientB.awareness.getStates().get(docA.clientID) as any
    expect(peerState.user.name).toBe('Alice')
    expect(peerState.user.color).toBe('#ff4444')
    expect(peerState.cursor.index).toBe(15)

    // Disconnect Client A
    await clientA.disconnect()

    // Wait for Client B to see Client A removed
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for awareness cleanup')), 3000)
      const checkRemoved = () => {
        const stateA = clientB.awareness.getStates().get(docA.clientID)
        if (!stateA) {
          clearTimeout(timeout)
          resolve()
        }
      }
      clientB.awareness.on('change', checkRemoved)
      checkRemoved()
    })

    expect(clientB.awareness.getStates().has(docA.clientID)).toBe(false)

    await clientB.disconnect()
    closeRoom(roomName)
  })
})
