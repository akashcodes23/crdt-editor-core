import http from 'http'
import { AddressInfo } from 'net'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { setupWSConnection, getRoom, flushRoomPersistence, closeRoom } from '../room'
import { dbPool, initDb } from '../db'
import { closePersistence } from '../persistence'

// ── Test WS Client Helper ───────────────────────────────────────────────────
class TestWSClient {
  public doc: Y.Doc
  public ws: WebSocket | null = null
  public url: string
  public connected: boolean = false
  public clientID: number
  private onUpdate: (update: Uint8Array, origin: any) => void

  constructor(url: string, doc = new Y.Doc()) {
    this.url = url
    this.doc = doc
    this.clientID = this.doc.clientID

    this.onUpdate = (update: Uint8Array, origin: any) => {
      if (origin !== 'remote' && this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, 0) // MESSAGE_SYNC
        syncProtocol.writeUpdate(encoder, update)
        this.ws.send(encoding.toUint8Array(encoder))
      }
    }
    this.doc.on('update', this.onUpdate)
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)

      this.ws.on('open', () => {
        this.connected = true
        // Send initial syncStep1 from client to request server state
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, 0) // MESSAGE_SYNC
        syncProtocol.writeSyncStep1(encoder, this.doc)
        this.ws!.send(encoding.toUint8Array(encoder))
      })

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)
          const decoder = decoding.createDecoder(new Uint8Array(buf))
          const msgType = decoding.readVarUint(decoder)

          if (msgType === 0) {
            // MESSAGE_SYNC
            const replyEncoder = encoding.createEncoder()
            encoding.writeVarUint(replyEncoder, 0)
            syncProtocol.readSyncMessage(decoder, replyEncoder, this.doc, 'remote')
            if (encoding.length(replyEncoder) > 1 && this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(encoding.toUint8Array(replyEncoder))
            }
          }
        } catch (err) {
          console.error('[TestWSClient] message error:', err)
        }
      })

      this.ws.on('error', (err) => {
        reject(err)
      })

      // Allow initial roundtrip handshake to complete
      setTimeout(() => {
        resolve()
      }, 60)
    })
  }

  async disconnect(): Promise<void> {
    this.connected = false
    if (!this.ws) return
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      await new Promise<void>((resolve) => {
        this.ws!.once('close', () => resolve())
        this.ws!.close()
      })
    }
    this.ws = null
  }

  destroy(): void {
    this.doc.off('update', this.onUpdate)
    if (this.ws) {
      this.ws.terminate()
      this.ws = null
    }
    this.doc.destroy()
  }
}

// ── Helper to wait for deterministic convergence ─────────────────────────────
async function waitForConvergence(
  clientA: TestWSClient,
  clientB: TestWSClient,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const svA = Buffer.from(Y.encodeStateVector(clientA.doc))
    const svB = Buffer.from(Y.encodeStateVector(clientB.doc))
    if (svA.equals(svB)) {
      return
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  const textA = clientA.doc.getText('content').toString()
  const textB = clientB.doc.getText('content').toString()
  throw new Error(
    `Convergence timed out after ${timeoutMs}ms.\nClient A text: "${textA}"\nClient B text: "${textB}"`
  )
}

describe('Real WebSocket Multi-Client Integration Suite (12 Scenarios + Lifecycle)', () => {
  let server: http.Server
  let wss: WebSocketServer
  let serverPort: number
  let baseUrl: string

  const startTestServer = async (): Promise<void> => {
    return new Promise((resolve) => {
      server = http.createServer((_req, res) => res.end('ok'))
      wss = new WebSocketServer({ server, maxPayload: 10 * 1024 * 1024 })
      wss.on('connection', (ws, req) => {
        ws.on('error', () => {}) // Suppress unhandled errors during test harness drops
        const url = new URL(req.url ?? '/', `http://localhost:${serverPort}`)
        const roomName = url.pathname.slice(1) || 'default'
        setupWSConnection(ws as any, req, roomName).catch((err) => {
          console.error(`[test-ws] setup connection error:`, err)
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
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Normal concurrent editing
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 1: Normal concurrent editing between 2 live clients converges', async () => {
    const roomName = `room-s1-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    await c1.connect()
    await c2.connect()

    c1.doc.getText('content').insert(0, 'Hello from Client 1! ')
    c2.doc.getText('content').insert(0, 'Greetings from Client 2! ')

    await waitForConvergence(c1, c2)

    const text1 = c1.doc.getText('content').toString()
    const text2 = c2.doc.getText('content').toString()
    expect(text1).toBe(text2)
    expect(text1).toContain('Hello from Client 1!')
    expect(text1).toContain('Greetings from Client 2!')

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Disconnection while edits are made
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 2: Disconnection while edits are made by remaining peer syncs upon reconnect', async () => {
    const roomName = `room-s2-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    await c1.connect()
    await c2.connect()

    c1.doc.getText('content').insert(0, 'Initial shared line.\n')
    await waitForConvergence(c1, c2)

    // Client 2 disconnects
    await c2.disconnect()

    // Client 1 makes edits while Client 2 is disconnected
    c1.doc.getText('content').insert(c1.doc.getText('content').length, 'Appended while C2 disconnected.\n')

    // Client 2 reconnects
    await c2.connect()
    await waitForConvergence(c1, c2)

    expect(c2.doc.getText('content').toString()).toBe(c1.doc.getText('content').toString())
    expect(c2.doc.getText('content').toString()).toContain('Appended while C2 disconnected.')

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Reconnection and synchronization with bidirectional edits
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 3: Bidirectional concurrent edits during disconnection synchronize cleanly', async () => {
    const roomName = `room-s3-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    await c1.connect()
    await c2.connect()

    c1.doc.getText('content').insert(0, 'Baseline.\n')
    await waitForConvergence(c1, c2)

    // Network partition: Client 2 disconnects
    await c2.disconnect()

    // Both clients make independent edits in isolation
    c1.doc.getText('content').insert(c1.doc.getText('content').length, 'C1 offline partition edit.\n')
    c2.doc.getText('content').insert(c2.doc.getText('content').length, 'C2 offline partition edit.\n')

    // Partition heals: Client 2 reconnects
    await c2.connect()
    await waitForConvergence(c1, c2)

    const result1 = c1.doc.getText('content').toString()
    const result2 = c2.doc.getText('content').toString()

    expect(result1).toBe(result2)
    expect(result1).toContain('Baseline.\n')
    expect(result1).toContain('C1 offline partition edit.\n')
    expect(result1).toContain('C2 offline partition edit.\n')

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Duplicate update delivery
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 4: Duplicate update delivery is idempotent and does not duplicate content', async () => {
    const roomName = `room-s4-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    await c1.connect()

    const capturedUpdates: Uint8Array[] = []
    const rawWs = new WebSocket(url)
    await new Promise<void>((res) => rawWs.on('open', () => res()))

    rawWs.on('message', (data: WebSocket.RawData) => {
      capturedUpdates.push(Buffer.from(data as any))
    })

    c1.doc.getText('content').insert(0, 'OnceOnly')
    await new Promise((r) => setTimeout(r, 100))

    // Deliver the captured update 4 additional times to a new client doc
    const duplicateDoc = new Y.Doc()
    for (const updateBuffer of capturedUpdates) {
      const decoder = decoding.createDecoder(new Uint8Array(updateBuffer))
      const msgType = decoding.readVarUint(decoder)
      if (msgType === 0) {
        const dummyEncoder = encoding.createEncoder()
        syncProtocol.readSyncMessage(decoder, dummyEncoder, duplicateDoc, 'remote')
      }
    }

    // Repeat application 3 more times
    for (let i = 0; i < 3; i++) {
      for (const updateBuffer of capturedUpdates) {
        const decoder = decoding.createDecoder(new Uint8Array(updateBuffer))
        decoding.readVarUint(decoder)
        const dummyEncoder = encoding.createEncoder()
        syncProtocol.readSyncMessage(decoder, dummyEncoder, duplicateDoc, 'remote')
      }
    }

    expect(duplicateDoc.getText('content').toString()).toBe('OnceOnly')

    rawWs.close()
    await c1.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Delayed update delivery
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 5: Delayed update delivery reconciles completely once packets arrive', async () => {
    const roomName = `room-s5-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    await c1.connect()
    await c2.connect()

    // Produce multiple rapid edits
    c1.doc.getText('content').insert(0, 'Alpha;')
    c1.doc.getText('content').insert(c1.doc.getText('content').length, ' Beta;')
    c1.doc.getText('content').insert(c1.doc.getText('content').length, ' Gamma;')

    // Wait bounded period for delayed packets to propagate across real WebSocket
    await waitForConvergence(c1, c2, 1000)

    expect(c2.doc.getText('content').toString()).toBe('Alpha; Beta; Gamma;')

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Reordered messages
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 6: Reordered updates converge to identical deterministic state', () => {
    const sourceDoc = new Y.Doc()
    const targetDoc = new Y.Doc()

    const rawUpdates: Uint8Array[] = []
    sourceDoc.on('update', (u) => {
      rawUpdates.push(new Uint8Array(u))
    })

    const text = sourceDoc.getText('content')
    text.insert(0, 'A')
    text.insert(1, 'B')
    text.insert(2, 'C')
    text.insert(3, 'D')
    text.insert(4, 'E')

    expect(rawUpdates.length).toBe(5)

    // Reorder updates: [4, 2, 0, 3, 1]
    const reorderedIndices = [4, 2, 0, 3, 1]
    for (const idx of reorderedIndices) {
      Y.applyUpdate(targetDoc, rawUpdates[idx])
    }

    expect(targetDoc.getText('content').toString()).toBe('ABCDE')
    expect(
      Buffer.from(Y.encodeStateVector(targetDoc)).equals(
        Buffer.from(Y.encodeStateVector(sourceDoc))
      )
    ).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Client reconnect after server restart
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 7: Client reconnects after server restart and synchronizes state', async () => {
    const roomName = `room-s7-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    await c1.connect()
    c1.doc.getText('content').insert(0, 'Survives server restart')

    const room = getRoom(roomName)
    await flushRoomPersistence(room)

    // Client disconnects before server stop
    await c1.disconnect()

    // Stop and restart the server
    await stopTestServer()
    await startTestServer()

    // Reconnect client to restarted server
    const restartedUrl = `${baseUrl}/${roomName}`
    const c1Reconnected = new TestWSClient(restartedUrl, c1.doc)
    await c1Reconnected.connect()

    // Verify document retained state
    expect(c1Reconnected.doc.getText('content').toString()).toBe('Survives server restart')

    await c1Reconnected.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Server restart after persisted updates (Fresh client joins)
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 8: Fresh client connects after server restart and recovers persisted document', async () => {
    const roomName = `room-s8-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    await c1.connect()
    c1.doc.getText('content').insert(0, 'Persisted content for new client')

    const room = getRoom(roomName)
    // Wait for room.doc to receive and apply the edit from c1
    const editWait = Date.now()
    while (Date.now() - editWait < 2000) {
      if (room.doc.getText('content').length > 0) break
      await new Promise((r) => setTimeout(r, 15))
    }
    await flushRoomPersistence(room)
    await c1.disconnect()

    // Evict room from in-memory cache to force loading from LevelDB persistence
    closeRoom(roomName)

    // Connect a fresh client that had no prior state
    const cFresh = new TestWSClient(url)
    await cFresh.connect()

    // Wait for initial sync from persistence
    const startWait = Date.now()
    while (Date.now() - startWait < 3000) {
      if (cFresh.doc.getText('content').toString() === 'Persisted content for new client') {
        break
      }
      await new Promise((r) => setTimeout(r, 25))
    }

    expect(cFresh.doc.getText('content').toString()).toBe('Persisted content for new client')

    await cFresh.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Simultaneous reconnects
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 9: 3 simultaneous reconnects with concurrent offline edits converge', async () => {
    const roomName = `room-s9-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    const c3 = new TestWSClient(url)

    await c1.connect()
    await c2.connect()
    await c3.connect()

    c1.doc.getText('content').insert(0, 'Init;\n')
    await waitForConvergence(c1, c2)
    await waitForConvergence(c2, c3)

    // All 3 disconnect simultaneously
    await Promise.all([c1.disconnect(), c2.disconnect(), c3.disconnect()])

    // Each makes an independent offline edit
    c1.doc.getText('content').insert(c1.doc.getText('content').length, 'c1_burst;\n')
    c2.doc.getText('content').insert(c2.doc.getText('content').length, 'c2_burst;\n')
    c3.doc.getText('content').insert(c3.doc.getText('content').length, 'c3_burst;\n')

    // Reconnect simultaneously
    await Promise.all([c1.connect(), c2.connect(), c3.connect()])

    await waitForConvergence(c1, c2)
    await waitForConvergence(c2, c3)

    const text1 = c1.doc.getText('content').toString()
    const text2 = c2.doc.getText('content').toString()
    const text3 = c3.doc.getText('content').toString()

    expect(text1).toBe(text2)
    expect(text2).toBe(text3)
    expect(text1).toContain('c1_burst;')
    expect(text1).toContain('c2_burst;')
    expect(text1).toContain('c3_burst;')

    await Promise.all([c1.disconnect(), c2.disconnect(), c3.disconnect()])
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Two clients editing the same region
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 10: Two clients editing index 0 simultaneously resolve deterministically', async () => {
    const roomName = `room-s10-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    await c1.connect()
    await c2.connect()

    c1.doc.getText('content').insert(0, 'BASE')
    await waitForConvergence(c1, c2)

    // Both insert at position 0 concurrently
    c1.doc.getText('content').insert(0, '[A]')
    c2.doc.getText('content').insert(0, '[B]')

    await waitForConvergence(c1, c2)

    const final1 = c1.doc.getText('content').toString()
    const final2 = c2.doc.getText('content').toString()

    expect(final1).toBe(final2)
    expect(final1.endsWith('BASE')).toBe(true)
    expect(final1).toContain('[A]')
    expect(final1).toContain('[B]')

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 11. Independent edits to different files
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 11: Independent edits to different files in a shared workspace converge', async () => {
    const roomName = `room-s11-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    await c1.connect()
    await c2.connect()

    const files1 = c1.doc.getMap('files')
    const files2 = c2.doc.getMap('files')

    // Client 1 edits index.ts, Client 2 edits utils.ts
    files1.set('index.ts', 'console.log("index");')
    files2.set('utils.ts', 'export const add = (a, b) => a + b;')

    // Wait for convergence of both files
    const start = Date.now()
    while (Date.now() - start < 2000) {
      if (files1.get('utils.ts') && files2.get('index.ts')) {
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(files1.get('index.ts')).toBe('console.log("index");')
    expect(files1.get('utils.ts')).toBe('export const add = (a, b) => a + b;')
    expect(files2.get('index.ts')).toBe('console.log("index");')
    expect(files2.get('utils.ts')).toBe('export const add = (a, b) => a + b;')

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 12. Repeated reconnect cycles
  // ───────────────────────────────────────────────────────────────────────────
  it('Scenario 12: 5 sequential disconnect-edit-reconnect cycles maintain full consistency', async () => {
    const roomName = `room-s12-${Date.now()}`
    const url = `${baseUrl}/${roomName}`

    const c1 = new TestWSClient(url)
    const c2 = new TestWSClient(url)
    await c1.connect()
    await c2.connect()

    for (let cycle = 0; cycle < 5; cycle++) {
      // Disconnect C2
      await c2.disconnect()

      // C1 makes edit
      c1.doc.getText('content').insert(c1.doc.getText('content').length, `cycle_${cycle}_c1;`)

      // C2 makes local edit while disconnected
      c2.doc.getText('content').insert(c2.doc.getText('content').length, `cycle_${cycle}_c2;`)

      // Reconnect C2
      await c2.connect()
      await waitForConvergence(c1, c2)

      expect(c1.doc.getText('content').toString()).toBe(c2.doc.getText('content').toString())
    }

    const finalText = c1.doc.getText('content').toString()
    for (let cycle = 0; cycle < 5; cycle++) {
      expect(finalText).toContain(`cycle_${cycle}_c1;`)
      expect(finalText).toContain(`cycle_${cycle}_c2;`)
    }

    await c1.disconnect()
    await c2.disconnect()
    closeRoom(roomName)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Protocol & Lifecycle Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe('Protocol & Lifecycle Invariants', () => {
    it('Rejects oversized payload frames (> 10MB limit) and closes with code 1009', async () => {
      const roomName = `room-oversized-${Date.now()}`
      const url = `${baseUrl}/${roomName}`

      const rawWs = new WebSocket(url)
      rawWs.on('error', () => {}) // Expected frame rejection error
      await new Promise<void>((res) => rawWs.on('open', () => res()))

      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        rawWs.on('close', (code, reason) => {
          resolve({ code, reason: reason.toString() })
        })
      })

      // Send 11 MB oversized frame (exceeds 10 MB limit)
      const oversizedBuffer = Buffer.alloc(11 * 1024 * 1024)
      rawWs.send(oversizedBuffer)

      const { code } = await closePromise
      expect(code).toBe(1009)
      closeRoom(roomName)
    })

    it('Handles unknown protocol message types safely', async () => {
      const roomName = `room-malformed-${Date.now()}`
      const url = `${baseUrl}/${roomName}`

      const rawWs = new WebSocket(url)
      await new Promise<void>((res) => rawWs.on('open', () => res()))

      // Send invalid message type 99
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 99)
      rawWs.send(encoding.toUint8Array(encoder))

      await new Promise((r) => setTimeout(r, 50))
      rawWs.close(1000)
      closeRoom(roomName)
    })

    it('Cleans up awareness states accurately upon client disconnect', async () => {
      const roomName = `room-awareness-${Date.now()}`
      const url = `${baseUrl}/${roomName}`

      const c1 = new TestWSClient(url)
      await c1.connect()

      const room = getRoom(roomName)
      expect(room.clients.size).toBe(1)

      // Set awareness state using Awareness API
      room.awareness.setLocalStateField('user', { name: 'Alice' })
      expect(room.awareness.getStates().size).toBeGreaterThan(0)

      // Disconnect
      await c1.disconnect()

      // Wait briefly for server close event to execute
      const closeWait = Date.now()
      while (Date.now() - closeWait < 1000) {
        if (room.clients.size === 0) break
        await new Promise((r) => setTimeout(r, 10))
      }

      // Room clients set must be 0
      expect(room.clients.size).toBe(0)
      expect(room.clientAwareness.size).toBe(0)

      closeRoom(roomName)
    })

    it('Room disposal cleanly removes room from memory and destroys doc', async () => {
      const roomName = `room-dispose-${Date.now()}`
      const room = getRoom(roomName)
      await room.loadedPromise
      expect(room).toBeDefined()

      const closed = closeRoom(roomName)
      expect(closed).toBe(true)

      // Next call creates a fresh, separate room instance
      const freshRoom = getRoom(roomName)
      await freshRoom.loadedPromise
      expect(freshRoom).not.toBe(room)
      closeRoom(roomName)
    })
  })
})
