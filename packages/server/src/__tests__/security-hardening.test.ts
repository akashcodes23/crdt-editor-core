import http from 'http'
import express from 'express'
import { AddressInfo } from 'net'
import WebSocket, { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import {
  createAuthToken,
  verifyAuthToken,
  isValidDocId,
  isOriginAllowed,
  isAuthorizedForRoom,
  adminAuthMiddleware,
  docAuthMiddleware,
  extractProxyIdentity,
  WS_CLOSE_UNAUTHORIZED,
  WS_CLOSE_FORBIDDEN,
  WS_CLOSE_TOO_MANY_REQUESTS,
  WS_CLOSE_POLICY_VIOLATION,
  WS_CLOSE_BAD_REQUEST,
} from '../security'
import {
  setupWSConnection,
  getRoom,
  closeRoom,
  rooms,
  MESSAGE_DURABLE_UPDATE,
  MESSAGE_DURABLE_ACK,
  ACK_STATUS_DURABLE,
  ACK_STATUS_FAILED,
} from '../room'
import { dbPool, initDb } from '../db'
import { closePersistence } from '../persistence'

const TEST_SECRET = 'converge-test-hmac-sha256-secret-key-32chars!'
const TEST_ADMIN_KEY = 'admin-secret-test-key-998877'
const TEST_PROXY_SECRET = 'proxy-shared-secret-val-5544'

describe('Security Hardening Suite (SEC-01 through SEC-04)', () => {
  const origEnv = { ...process.env }

  beforeAll(async () => {
    process.env.CONVERGE_AUTH_SECRET = TEST_SECRET
    process.env.ADMIN_API_KEY = TEST_ADMIN_KEY
    process.env.PROXY_SHARED_SECRET = TEST_PROXY_SECRET
    process.env.AUTH_REQUIRED = 'true'
    process.env.ALLOWED_ORIGINS = 'http://localhost:3000,https://app.converge.dev'
    process.env.TRUST_PROXY_AUTH = 'true'
    process.env.MAX_CLIENTS_PER_ROOM = '2'
    process.env.MAX_MESSAGES_PER_SEC = '10'

    await initDb()
  })

  afterAll(async () => {
    process.env = origEnv
    await closePersistence()
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Token Minting, Verification, and DocID Input Validation
  // ─────────────────────────────────────────────────────────────────────────────
  describe('HMAC Token & Input Validation Unit Semantics', () => {
    it('mints and verifies valid capability tokens', () => {
      const token = createAuthToken(
        { sub: 'alice', room: 'room-1', role: 'editor', exp: Date.now() + 60000 },
        TEST_SECRET
      )
      const res = verifyAuthToken(token, TEST_SECRET)
      expect(res.valid).toBe(true)
      expect(res.claims?.sub).toBe('alice')
      expect(res.claims?.room).toBe('room-1')
      expect(res.claims?.role).toBe('editor')
    })

    it('rejects tokens with tampered signatures or wrong secret', () => {
      const token = createAuthToken({ sub: 'bob', room: '*' }, TEST_SECRET)
      const parts = token.split('.')
      const tampered = `${parts[0]}.wrongsignature`
      const resTampered = verifyAuthToken(tampered, TEST_SECRET)
      expect(resTampered.valid).toBe(false)
      expect(resTampered.error).toBe('INVALID_SIGNATURE')

      const resWrongSecret = verifyAuthToken(token, 'different-secret-key')
      expect(resWrongSecret.valid).toBe(false)
      expect(resWrongSecret.error).toBe('INVALID_SIGNATURE')
    })

    it('assigns default 24h expiration when exp is omitted during token creation', () => {
      const before = Date.now()
      const token = createAuthToken({ sub: 'dave', room: 'room-1' }, TEST_SECRET)
      const res = verifyAuthToken(token, TEST_SECRET)
      expect(res.valid).toBe(true)
      expect(res.claims?.exp).toBeDefined()
      // Expiration should be roughly 24 hours in the future
      const diff = (res.claims?.exp || 0) - before
      expect(diff).toBeGreaterThanOrEqual(23 * 60 * 60 * 1000)
      expect(diff).toBeLessThanOrEqual(25 * 60 * 60 * 1000)
    })

    it('rejects minting tokens without subject or with weak secret', () => {
      expect(() => createAuthToken({ sub: '' } as any, TEST_SECRET)).toThrow()
      expect(() => createAuthToken({} as any, TEST_SECRET)).toThrow()
      expect(() => createAuthToken({ sub: 'user' }, 'short-key')).toThrow()
    })

    it('detects privilege escalation attempts: role modification breaks HMAC', () => {
      const viewerToken = createAuthToken({ sub: 'eve', room: 'project-1', role: 'viewer' }, TEST_SECRET)
      const [payloadB64, sig] = viewerToken.split('.')
      const claims = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))
      // Attacker attempts to change role to admin
      claims.role = 'admin'
      const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
      const forgedToken = `${forgedPayload}.${sig}`

      const res = verifyAuthToken(forgedToken, TEST_SECRET)
      expect(res.valid).toBe(false)
      expect(res.error).toBe('INVALID_SIGNATURE')
    })

    it('detects room scope tampering: changing room breaks HMAC', () => {
      const scopedToken = createAuthToken({ sub: 'eve', room: 'sandbox', role: 'editor' }, TEST_SECRET)
      const [payloadB64, sig] = scopedToken.split('.')
      const claims = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))
      // Attacker attempts to change room to production
      claims.room = 'production'
      const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
      const forgedToken = `${forgedPayload}.${sig}`

      const res = verifyAuthToken(forgedToken, TEST_SECRET)
      expect(res.valid).toBe(false)
      expect(res.error).toBe('INVALID_SIGNATURE')
    })

    it('validates document and room IDs strictly against path traversal', () => {
      // Valid identifiers with internal dots, dashes, underscores
      expect(isValidDocId('document-123')).toBe(true)
      expect(isValidDocId('room.alpha_beta-99')).toBe(true)
      expect(isValidDocId('a')).toBe(true)
      expect(isValidDocId('0')).toBe(true)

      // Path traversal and dangerous directory attacks
      expect(isValidDocId('.')).toBe(false)
      expect(isValidDocId('..')).toBe(false)
      expect(isValidDocId('...')).toBe(false)
      expect(isValidDocId('../etc/passwd')).toBe(false)
      expect(isValidDocId('..\\etc\\passwd')).toBe(false)
      expect(isValidDocId('/root/doc')).toBe(false)
      expect(isValidDocId('doc\\sub')).toBe(false)
      expect(isValidDocId('doc?query=1')).toBe(false)

      // Boundary dot / dash restrictions (prevents hidden/normalized files)
      expect(isValidDocId('.hidden')).toBe(false)
      expect(isValidDocId('hidden.')).toBe(false)
      expect(isValidDocId('-leading')).toBe(false)
      expect(isValidDocId('trailing-')).toBe(false)

      // Percent-encoded and traversal variants
      expect(isValidDocId('%2e%2e')).toBe(false)
      expect(isValidDocId('..%2fsecret')).toBe(false)
      expect(isValidDocId('%2e%2e%2f')).toBe(false)
      expect(isValidDocId('doc%20id')).toBe(false)

      // Separators, empty, overlong, null-byte, and Unicode
      expect(isValidDocId('')).toBe(false)
      expect(isValidDocId('foo//bar')).toBe(false)
      expect(isValidDocId('foo..bar')).toBe(false)
      expect(isValidDocId('doc\0inject')).toBe(false)
      expect(isValidDocId('café')).toBe(false)
      expect(isValidDocId('\u202Ereversed')).toBe(false)
      expect(isValidDocId('a'.repeat(129))).toBe(false) // length > 128
    })

    it('validates Origins against allowed origin list and blocks lookalikes', () => {
      const allowed = ['http://localhost:3000', 'https://app.converge.dev']
      expect(isOriginAllowed('http://localhost:3000', allowed).allowed).toBe(true)
      expect(isOriginAllowed('https://app.converge.dev', allowed).allowed).toBe(true)

      // Hostile and lookalike domains
      expect(isOriginAllowed('https://evil-attacker.com', allowed).allowed).toBe(false)
      expect(isOriginAllowed('https://app.converge.dev.attacker.com', allowed).allowed).toBe(false)
      expect(isOriginAllowed('https://evilconverge.dev', allowed).allowed).toBe(false)
      expect(isOriginAllowed('http://localhost:3000.attacker.com', allowed).allowed).toBe(false)
      expect(isOriginAllowed('http://localhost:4000', allowed).allowed).toBe(false)
      expect(isOriginAllowed('http://localhost:3001', allowed).allowed).toBe(false)

      // Absent origin allowed for CLI/testing by default
      expect(isOriginAllowed(undefined, allowed).allowed).toBe(true)
    })

    it('evaluates room authorization and roles correctly', () => {
      const editorClaims = { sub: 'u1', room: 'project-a', role: 'editor' as const }
      expect(isAuthorizedForRoom(editorClaims, 'project-a', 'editor').authorized).toBe(true)
      expect(isAuthorizedForRoom(editorClaims, 'project-b', 'editor').authorized).toBe(false)

      const viewerClaims = { sub: 'u2', room: 'project-a', role: 'viewer' as const }
      expect(isAuthorizedForRoom(viewerClaims, 'project-a', 'viewer').authorized).toBe(true)
      expect(isAuthorizedForRoom(viewerClaims, 'project-a', 'editor').authorized).toBe(false)

      const adminClaims = { sub: 'admin', role: 'admin' as const }
      expect(isAuthorizedForRoom(adminClaims, 'any-room', 'editor').authorized).toBe(true)
      expect(isAuthorizedForRoom(adminClaims, 'any-room', 'admin').authorized).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Administrative API Authorization Middleware (SEC-02)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('SEC-02: Administrative Endpoint Authorization', () => {
    let app: express.Express
    let server: http.Server
    let port: number
    let httpUrl: string

    beforeAll(async () => {
      app = express()
      app.use(express.json())

      app.post('/doc/:id/snapshot', adminAuthMiddleware, (req, res) => {
        res.json({ success: true, docId: req.params.id, endpoint: 'snapshot' })
      })

      app.post('/doc/:id/compact', adminAuthMiddleware, (req, res) => {
        res.json({ success: true, docId: req.params.id, endpoint: 'compact' })
      })

      app.get('/doc/:id/history', docAuthMiddleware, (req, res) => {
        res.json({ success: true, docId: req.params.id, ops: [] })
      })

      app.get('/rooms/:name/info', (req, res) => {
        const roomName = req.params.name
        if (!isValidDocId(roomName)) {
          return res.status(400).json({ error: 'INVALID_ROOM_NAME' })
        }
        const room = rooms.get(roomName)
        if (!room) {
          return res.status(404).json({ error: 'ROOM_NOT_FOUND' })
        }
        res.json({ room: roomName, clientCount: room.clients.size })
      })

      await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => {
          port = (server.address() as AddressInfo).port
          httpUrl = `http://127.0.0.1:${port}`
          resolve()
        })
      })
    })

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${httpUrl}/doc/doc-test-1/snapshot`, { method: 'POST' })
      expect(res.status).toBe(401)
      const data: any = await res.json()
      expect(data.error).toBe('UNAUTHORIZED')
    })

    it('rejects requests with incorrect admin API key with 401', async () => {
      const res = await fetch(`${httpUrl}/doc/doc-test-1/compact`, {
        method: 'POST',
        headers: { 'X-Admin-Key': 'invalid-key' },
      })
      expect(res.status).toBe(401)
    })

    it('accepts requests with valid X-Admin-Key header with 200', async () => {
      const res = await fetch(`${httpUrl}/doc/doc-test-1/snapshot`, {
        method: 'POST',
        headers: { 'X-Admin-Key': TEST_ADMIN_KEY },
      })
      expect(res.status).toBe(200)
      const data: any = await res.json()
      expect(data.success).toBe(true)
      expect(data.docId).toBe('doc-test-1')
    })

    it('accepts requests with Bearer admin API key in Authorization header', async () => {
      const res = await fetch(`${httpUrl}/doc/doc-test-1/compact`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
      })
      expect(res.status).toBe(200)
      const data: any = await res.json()
      expect(data.success).toBe(true)
      expect(data.docId).toBe('doc-test-1')
    })

    it('accepts requests with valid admin JWT token', async () => {
      const adminToken = createAuthToken({ sub: 'superadmin', role: 'admin' }, TEST_SECRET)
      const res = await fetch(`${httpUrl}/doc/doc-test-1/snapshot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      expect(res.status).toBe(200)
      const data: any = await res.json()
      expect(data.success).toBe(true)
    })

    it('rejects ordinary editor or viewer tokens on admin snapshot endpoint with 401', async () => {
      const editorToken = createAuthToken({ sub: 'ed', room: '*', role: 'editor' }, TEST_SECRET)
      const resEditor = await fetch(`${httpUrl}/doc/doc-test-1/snapshot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${editorToken}` },
      })
      expect(resEditor.status).toBe(401)

      const viewerToken = createAuthToken({ sub: 'vi', room: '*', role: 'viewer' }, TEST_SECRET)
      const resViewer = await fetch(`${httpUrl}/doc/doc-test-1/snapshot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerToken}` },
      })
      expect(resViewer.status).toBe(401)
    })

    it('enforces authentication on document history endpoint when auth is required', async () => {
      // 1. Unauthenticated request rejected with 401
      const resUnauth = await fetch(`${httpUrl}/doc/doc-history-1/history`)
      expect(resUnauth.status).toBe(401)

      // 2. Token scoped to another room rejected with 403
      const wrongRoomToken = createAuthToken({ sub: 'user1', room: 'other-room', role: 'viewer' }, TEST_SECRET)
      const resForbidden = await fetch(`${httpUrl}/doc/doc-history-1/history`, {
        headers: { Authorization: `Bearer ${wrongRoomToken}` },
      })
      expect(resForbidden.status).toBe(403)

      // 3. Token scoped to requested room accepted with 200
      const validToken = createAuthToken({ sub: 'user1', room: 'doc-history-1', role: 'viewer' }, TEST_SECRET)
      const resOk = await fetch(`${httpUrl}/doc/doc-history-1/history`, {
        headers: { Authorization: `Bearer ${validToken}` },
      })
      expect(resOk.status).toBe(200)
    })

    it('returns 404 for inactive room info without allocating Room state in memory', async () => {
      const initialRoomCount = rooms.size
      const res = await fetch(`${httpUrl}/rooms/non-existent-room-xyz/info`)
      expect(res.status).toBe(404)
      const data: any = await res.json()
      expect(data.error).toBe('ROOM_NOT_FOUND')
      // Invariant: No in-memory Room object was allocated!
      expect(rooms.size).toBe(initialRoomCount)
      expect(rooms.has('non-existent-room-xyz')).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. WebSocket Authentication, Origin, Scoping, and Limits (SEC-01, 03, 04)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('SEC-01, SEC-03, SEC-04: WebSocket Protocol Hardening', () => {
    let server: http.Server
    let wss: WebSocketServer
    let wsPort: number
    let wsBaseUrl: string

    beforeAll(async () => {
      server = http.createServer((_req, res) => res.end('ok'))
      wss = new WebSocketServer({
        server,
        handleProtocols: (protocols: Set<string>) => {
          if (protocols.has('converge.v1')) return 'converge.v1'
          if (protocols.has('converge')) return 'converge'
          for (const p of protocols) {
            if (!p.startsWith('converge.token.')) return p
          }
          for (const p of protocols) {
            if (p.startsWith('converge.token.')) return p
          }
          return protocols.values().next().value ?? false
        },
      })

      wss.on('connection', (ws, req) => {
        ws.on('error', () => {})
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${wsPort}`)
        const roomName = url.pathname.slice(1) || 'default'
        setupWSConnection(ws as any, req, roomName).catch(() => {})
      })

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          wsPort = (server.address() as AddressInfo).port
          wsBaseUrl = `ws://127.0.0.1:${wsPort}`
          resolve()
        })
      })
    })

    afterAll(async () => {
      for (const client of wss.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve())
        })
      })
    })

    it('rejects unauthenticated WebSocket connection with 4401 in auth-required mode', async () => {
      const ws = new WebSocket(`${wsBaseUrl}/room-auth-test`)
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      })
      const result = await closePromise
      expect(result.code).toBe(WS_CLOSE_UNAUTHORIZED)
    })

    it('rejects connection with invalid token signature with 4401', async () => {
      const invalidToken = 'eyJhbGciOiJIUzI1NiJ9.invalid-sig'
      const ws = new WebSocket(`${wsBaseUrl}/room-auth-test`, [`converge.token.${invalidToken}`])
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      })
      const result = await closePromise
      expect(result.code).toBe(WS_CLOSE_UNAUTHORIZED)
    })

    it('rejects connection with token scoped to a different room with 4403', async () => {
      const token = createAuthToken({ sub: 'user1', room: 'room-alpha', role: 'editor' }, TEST_SECRET)
      const ws = new WebSocket(`${wsBaseUrl}/room-beta`, [`converge.token.${token}`])
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      })
      const result = await closePromise
      expect(result.code).toBe(WS_CLOSE_FORBIDDEN)
    })

    it('accepts connection with valid token via Sec-WebSocket-Protocol and negotiates converge.v1 without echoing token', async () => {
      const token = createAuthToken({ sub: 'user1', room: 'room-alpha', role: 'editor' }, TEST_SECRET)
      // Client requests standard application subprotocol and token subprotocol
      const ws = new WebSocket(`${wsBaseUrl}/room-alpha`, ['converge.v1', `converge.token.${token}`])
      const openPromise = new Promise<{ opened: boolean; protocol: string }>((resolve) => {
        ws.on('open', () => resolve({ opened: true, protocol: ws.protocol }))
        ws.on('close', () => resolve({ opened: false, protocol: ws.protocol }))
      })
      const { opened, protocol } = await openPromise
      expect(opened).toBe(true)
      // Invariant: Server negotiated application protocol 'converge.v1'
      expect(protocol).toBe('converge.v1')
      // Invariant: Token is NOT selected as the negotiated protocol and NOT echoed
      expect(protocol).not.toContain(token)
      ws.close()
    })

    it('rejects attempt to pass auth token in query string (?token=...) to prevent URL logging', async () => {
      const token = createAuthToken({ sub: 'user1', room: 'room-alpha', role: 'editor' }, TEST_SECRET)
      // Client attempts to pass token in query parameter without subprotocol
      const ws = new WebSocket(`${wsBaseUrl}/room-alpha?token=${token}`)
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      const code = await closePromise
      // Invariant: Query parameter token is ignored and connection is rejected with 4401
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED)
    })

    it('rejects unauthenticated connection supplying arbitrary non-auth subprotocols', async () => {
      const ws = new WebSocket(`${wsBaseUrl}/room-alpha`, ['chat', 'random.protocol'])
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      const code = await closePromise
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED)
    })

    it('rejects disallowed Origin with 1008 Policy Violation', async () => {
      const token = createAuthToken({ sub: 'user1', room: 'room-origin', role: 'editor' }, TEST_SECRET)
      const ws = new WebSocket(`${wsBaseUrl}/room-origin`, [`converge.token.${token}`], {
        headers: { Origin: 'https://malicious-site.example.com' },
      })
      const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      })
      const result = await closePromise
      expect(result.code).toBe(WS_CLOSE_POLICY_VIOLATION)
    })

    it('accepts allowed Origin from allowlist', async () => {
      const token = createAuthToken({ sub: 'user1', room: 'room-origin', role: 'editor' }, TEST_SECRET)
      const ws = new WebSocket(`${wsBaseUrl}/room-origin`, [`converge.token.${token}`], {
        headers: { Origin: 'http://localhost:3000' },
      })
      const openPromise = new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true))
        ws.on('close', () => resolve(false))
      })
      const opened = await openPromise
      expect(opened).toBe(true)
      ws.close()
    })

    it('accepts trusted reverse proxy authentication headers', async () => {
      const ws = new WebSocket(`${wsBaseUrl}/room-proxy`, {
        headers: {
          'X-Proxy-Secret': TEST_PROXY_SECRET,
          'X-Forwarded-User': 'proxy-alice',
          'X-Forwarded-Roles': 'editor',
          'X-Forwarded-Room': 'room-proxy',
        },
      })
      const openPromise = new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true))
        ws.on('close', () => resolve(false))
      })
      const opened = await openPromise
      expect(opened).toBe(true)
      ws.close()
    })

    it('rejects reverse proxy request with incorrect proxy secret', async () => {
      const ws = new WebSocket(`${wsBaseUrl}/room-proxy`, {
        headers: {
          'X-Proxy-Secret': 'wrong-proxy-secret',
          'X-Forwarded-User': 'proxy-alice',
        },
      })
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      const code = await closePromise
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED)
    })

    it('rejects reverse proxy request with empty proxy secret (prevent timingSafeEqual(0,0) bypass)', async () => {
      const ws = new WebSocket(`${wsBaseUrl}/room-proxy`, {
        headers: {
          'X-Proxy-Secret': '',
          'X-Forwarded-User': 'spoofed-admin',
          'X-Forwarded-Roles': 'admin',
        },
      })
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      const code = await closePromise
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED)
    })

    it('rejects reverse proxy request with CRLF or control injection in username', () => {
      const config = {
        authRequired: true,
        authSecret: TEST_SECRET,
        adminApiKey: TEST_ADMIN_KEY,
        allowedOrigins: ['http://localhost:3000'],
        trustProxyAuth: true,
        proxySharedSecret: TEST_PROXY_SECRET,
        maxRooms: 1000,
        maxTotalConnections: 5000,
        maxClientsPerRoom: 100,
        maxPayloadBytes: 10485760,
        maxMessagesPerSec: 200,
      }
      const mockCrlfReq: any = {
        headers: {
          'x-proxy-secret': TEST_PROXY_SECRET,
          'x-forwarded-user': "alice\r\nX-Injected: true",
        },
      }
      expect(extractProxyIdentity(mockCrlfReq, config)).toBeNull()

      const mockNullReq: any = {
        headers: {
          'x-proxy-secret': TEST_PROXY_SECRET,
          'x-forwarded-user': "alice\0injected",
        },
      }
      expect(extractProxyIdentity(mockNullReq, config)).toBeNull()

      const mockWhitespaceReq: any = {
        headers: {
          'x-proxy-secret': TEST_PROXY_SECRET,
          'x-forwarded-user': '   ',
        },
      }
      expect(extractProxyIdentity(mockWhitespaceReq, config)).toBeNull()
    })

    it('rejects reverse proxy request with path traversal in X-Forwarded-Room', async () => {
      const ws = new WebSocket(`${wsBaseUrl}/room-proxy`, {
        headers: {
          'X-Proxy-Secret': TEST_PROXY_SECRET,
          'X-Forwarded-User': 'proxy-alice',
          'X-Forwarded-Room': '../../etc/passwd',
        },
      })
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      const code = await closePromise
      expect(code).toBe(WS_CLOSE_UNAUTHORIZED)
    })

    it('rejects path traversal in WebSocket room name with 4400', async () => {
      const token = createAuthToken({ sub: 'user1', room: '*', role: 'editor' }, TEST_SECRET)
      const ws = new WebSocket(`${wsBaseUrl}/..%2F..%2Fetc%2Fpasswd`, [`converge.token.${token}`])
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      const code = await closePromise
      expect(code).toBe(WS_CLOSE_BAD_REQUEST)
    })

    it('enforces read-only permissions for "viewer" role', async () => {
      const viewerToken = createAuthToken({ sub: 'viewer-bob', room: 'room-view', role: 'viewer' }, TEST_SECRET)
      const ws = new WebSocket(`${wsBaseUrl}/room-view`, [`converge.token.${viewerToken}`])

      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      // Attempt to send a MESSAGE_DURABLE_UPDATE
      const updateId = 'update-viewer-forbidden-1'
      const dummyPayload = new Uint8Array([1, 2, 3])
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_DURABLE_UPDATE)
      encoding.writeVarString(enc, updateId)
      encoding.writeVarUint8Array(enc, dummyPayload)

      ws.send(encoding.toUint8Array(enc))

      // Wait for ACK
      const ackPromise = new Promise<{ status: number; error: string }>((resolve) => {
        ws.on('message', (data: WebSocket.RawData) => {
          const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer)
          const dec = decoding.createDecoder(new Uint8Array(buf))
          const msgType = decoding.readVarUint(dec)
          if (msgType === MESSAGE_DURABLE_ACK) {
            const ackUpdateId = decoding.readVarString(dec)
            const status = decoding.readVarUint(dec)
            const hlc = decoding.readVarString(dec)
            const error = decoding.readVarString(dec)
            if (ackUpdateId === updateId) {
              resolve({ status, error })
            }
          }
        })
      })

      const ack = await ackPromise
      expect(ack.status).toBe(ACK_STATUS_FAILED)
      expect(ack.error).toContain('Read-only')

      ws.close()
    })

    it('enforces maximum clients per room limit', async () => {
      // MAX_CLIENTS_PER_ROOM is set to 2
      const token = createAuthToken({ sub: 'u', room: 'room-cap', role: 'editor' }, TEST_SECRET)

      const ws1 = new WebSocket(`${wsBaseUrl}/room-cap`, [`converge.token.${token}`])
      await new Promise<void>((resolve) => ws1.on('open', () => resolve()))

      const ws2 = new WebSocket(`${wsBaseUrl}/room-cap`, [`converge.token.${token}`])
      await new Promise<void>((resolve) => ws2.on('open', () => resolve()))

      await new Promise((r) => setTimeout(r, 50))

      // Third client should be rejected with 4429 (WS_CLOSE_TOO_MANY_REQUESTS)
      const ws3 = new WebSocket(`${wsBaseUrl}/room-cap`, [`converge.token.${token}`])
      const closePromise = new Promise<number>((resolve) => {
        ws3.on('close', (code) => resolve(code))
      })
      const code = await closePromise
      expect(code).toBe(WS_CLOSE_TOO_MANY_REQUESTS)

      ws1.close()
      ws2.close()
    })

    it('enforces message flood rate limiting', async () => {
      // MAX_MESSAGES_PER_SEC is set to 10
      const token = createAuthToken({ sub: 'flooder', room: 'room-flood', role: 'editor' }, TEST_SECRET)
      const ws = new WebSocket(`${wsBaseUrl}/room-flood`, [`converge.token.${token}`])

      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })

      // Send 25 rapid dummy sync messages to exceed rate limit (10/sec)
      for (let i = 0; i < 25; i++) {
        const enc = encoding.createEncoder()
        encoding.writeVarUint(enc, 0) // MESSAGE_SYNC
        encoding.writeVarUint(enc, 0) // syncStep1
        encoding.writeVarUint8Array(enc, new Uint8Array([0]))
        ws.send(encoding.toUint8Array(enc))
      }

      const closeCode = await closePromise
      expect(closeCode).toBe(WS_CLOSE_TOO_MANY_REQUESTS)
    })
  })
})
