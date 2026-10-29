import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import type { IncomingMessage } from 'http'

export interface AuthClaims {
  sub: string
  room?: string
  rooms?: string[]
  role?: 'admin' | 'editor' | 'viewer'
  exp?: number
  iat?: number
}

export interface SecurityConfig {
  authRequired: boolean
  authSecret: string
  adminApiKey: string
  allowedOrigins: string[]
  trustProxyAuth: boolean
  proxySharedSecret: string
  maxRooms: number
  maxTotalConnections: number
  maxClientsPerRoom: number
  maxPayloadBytes: number
  maxMessagesPerSec: number
}

export const WS_CLOSE_POLICY_VIOLATION = 1008
export const WS_CLOSE_UNAUTHORIZED = 4401
export const WS_CLOSE_FORBIDDEN = 4403
export const WS_CLOSE_TOO_MANY_REQUESTS = 4429
export const WS_CLOSE_BAD_REQUEST = 4400

/**
 * Returns the current active security configuration.
 */
export function getSecurityConfig(): SecurityConfig {
  const isProd = process.env.NODE_ENV === 'production'
  const authRequired = process.env.AUTH_REQUIRED === 'true' || isProd
  const authSecret = process.env.CONVERGE_AUTH_SECRET || ''
  const adminApiKey = process.env.ADMIN_API_KEY || ''
  const trustProxyAuth = process.env.TRUST_PROXY_AUTH === 'true'
  const proxySharedSecret = process.env.PROXY_SHARED_SECRET || ''

  const rawOrigins =
    process.env.ALLOWED_ORIGINS ||
    process.env.ALLOWED_ORIGIN ||
    (isProd ? '' : '*')

  const allowedOrigins = rawOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  return {
    authRequired,
    authSecret,
    adminApiKey,
    allowedOrigins,
    trustProxyAuth,
    proxySharedSecret,
    maxRooms: parseInt(process.env.MAX_ROOMS || '1000', 10),
    maxTotalConnections: parseInt(process.env.MAX_TOTAL_CONNECTIONS || '5000', 10),
    maxClientsPerRoom: parseInt(process.env.MAX_CLIENTS_PER_ROOM || '100', 10),
    maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES || '10485760', 10), // 10MB
    maxMessagesPerSec: parseInt(process.env.MAX_MESSAGES_PER_SEC || '200', 10),
  }
}

/**
 * Validates that all mandatory production security configurations are present.
 * Fails closed if production is deployed with missing secrets or wildcard origins.
 */
export function validateProductionSecurityConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const config = getSecurityConfig()
  const isProd = process.env.NODE_ENV === 'production'

  if (isProd) {
    if (!config.authSecret && !config.trustProxyAuth) {
      errors.push('CRITICAL: CONVERGE_AUTH_SECRET must be set in production mode, or TRUST_PROXY_AUTH must be configured.')
    }
    if (config.authSecret && config.authSecret.length < 16) {
      errors.push('CRITICAL: CONVERGE_AUTH_SECRET must be at least 16 characters in production mode.')
    }
    if (config.trustProxyAuth && (!config.proxySharedSecret || config.proxySharedSecret.length < 16)) {
      errors.push('CRITICAL: PROXY_SHARED_SECRET must be set and at least 16 characters when TRUST_PROXY_AUTH is enabled.')
    }
    if (!config.adminApiKey || config.adminApiKey.length < 16) {
      errors.push('CRITICAL: ADMIN_API_KEY must be set and at least 16 characters in production mode to protect administrative endpoints.')
    }
    if (config.allowedOrigins.length === 0 || config.allowedOrigins.includes('*')) {
      errors.push('CRITICAL: ALLOWED_ORIGINS must be set to explicit trusted origins in production (wildcard "*" is forbidden).')
    }
  }

  return { valid: errors.length === 0, errors }
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) base64 += '='
  return Buffer.from(base64, 'base64').toString('utf8')
}

export const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Creates an HMAC-SHA256 signed capability token.
 */
export function createAuthToken(claims: AuthClaims, secret: string): string {
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error('Cannot mint token: secret must be at least 16 characters')
  }
  if (!claims || typeof claims !== 'object') {
    throw new Error('Cannot mint token without claims object')
  }
  if (!claims.sub || typeof claims.sub !== 'string' || claims.sub.trim().length === 0) {
    throw new Error('Cannot mint token without valid sub (subject)')
  }
  const now = Date.now()
  const payload: AuthClaims = {
    ...claims,
    sub: claims.sub.trim(),
    role: claims.role || 'editor',
    iat: claims.iat || now,
    exp: typeof claims.exp === 'number' ? claims.exp : now + DEFAULT_TOKEN_TTL_MS,
  }
  const payloadB64 = base64UrlEncode(JSON.stringify(payload))
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `${payloadB64}.${signature}`
}

/**
 * Verifies an HMAC-SHA256 signed capability token with constant-time comparison.
 */
export function verifyAuthToken(
  token: string,
  secret: string
): { valid: boolean; claims?: AuthClaims; error?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'MISSING_TOKEN' }
  }
  if (!secret || typeof secret !== 'string') {
    return { valid: false, error: 'SERVER_MISCONFIGURED: No auth secret configured' }
  }

  const parts = token.split('.')
  if (parts.length !== 2) {
    return { valid: false, error: 'MALFORMED_TOKEN' }
  }

  const [payloadB64, signature] = parts
  if (!payloadB64 || !signature) {
    return { valid: false, error: 'MALFORMED_TOKEN' }
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

  const sigBuf = Buffer.from(signature)
  const expBuf = Buffer.from(expectedSig)

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'INVALID_SIGNATURE' }
  }

  try {
    const claims = JSON.parse(base64UrlDecode(payloadB64)) as AuthClaims
    if (!claims || typeof claims !== 'object') {
      return { valid: false, error: 'INVALID_PAYLOAD' }
    }
    if (!claims.sub || typeof claims.sub !== 'string' || claims.sub.trim().length === 0) {
      return { valid: false, error: 'MISSING_SUBJECT' }
    }
    if (typeof claims.exp !== 'number') {
      return { valid: false, error: 'MISSING_EXPIRATION' }
    }
    if (claims.exp < Date.now()) {
      return { valid: false, error: 'TOKEN_EXPIRED' }
    }
    if (claims.role && !['admin', 'editor', 'viewer'].includes(claims.role)) {
      return { valid: false, error: 'INVALID_ROLE' }
    }
    return { valid: true, claims }
  } catch {
    return { valid: false, error: 'INVALID_PAYLOAD' }
  }
}

// Strict document ID: 1-128 chars, alphanumeric start/end, contains only [a-zA-Z0-9_\-\.]
const SAFE_DOC_ID_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_\-\.]{0,126}[a-zA-Z0-9])?$/

/**
 * Validates that a document/room identifier is well-formed and safe against path traversal.
 */
export function isValidDocId(docId: string): boolean {
  if (!docId || typeof docId !== 'string') return false
  if (
    docId.length < 1 ||
    docId.length > 128 ||
    docId === '.' ||
    docId === '..' ||
    docId.startsWith('.') ||
    docId.endsWith('.') ||
    docId.startsWith('-') ||
    docId.endsWith('-') ||
    docId.includes('..') ||
    docId.includes('/') ||
    docId.includes('\\') ||
    docId.includes('\0') ||
    docId.includes('%')
  ) {
    return false
  }
  return SAFE_DOC_ID_REGEX.test(docId)
}

/**
 * Validates WebSocket or HTTP Origin against allowed origins.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[]
): { allowed: boolean; reason?: string } {
  // If origin is absent (non-browser client like curl, CLI tool, internal test)
  if (!origin) {
    if (process.env.REJECT_ABSENT_ORIGIN === 'true') {
      return { allowed: false, reason: 'ORIGIN_REQUIRED' }
    }
    return { allowed: true }
  }

  // If allowlist contains wildcard (non-production development)
  if (allowedOrigins.includes('*')) {
    return { allowed: true }
  }

  // Exact match
  if (allowedOrigins.includes(origin)) {
    return { allowed: true }
  }

  return { allowed: false, reason: `ORIGIN_DISALLOWED: ${origin}` }
}

/**
 * Verifies whether a set of claims permits access to a requested room.
 */
export function isAuthorizedForRoom(
  claims: AuthClaims | undefined,
  requestedRoom: string,
  requiredRole: 'viewer' | 'editor' | 'admin' = 'editor'
): { authorized: boolean; reason?: string } {
  if (!claims) {
    return { authorized: false, reason: 'NO_CLAIMS' }
  }

  // Admin role has unrestricted access across all rooms
  if (claims.role === 'admin') {
    return { authorized: true }
  }

  if (requiredRole === 'admin') {
    return { authorized: false, reason: 'ADMIN_ROLE_REQUIRED' }
  }

  // Check room scope
  const isRoomAllowed =
    claims.room === '*' ||
    claims.room === requestedRoom ||
    (Array.isArray(claims.rooms) && claims.rooms.includes(requestedRoom))

  if (!isRoomAllowed) {
    return { authorized: false, reason: `UNAUTHORIZED_ROOM: Token not authorized for room "${requestedRoom}"` }
  }

  // Check role hierarchy: viewer < editor < admin
  if (requiredRole === 'editor' && claims.role === 'viewer') {
    return { authorized: false, reason: 'WRITE_PERMISSION_DENIED: Viewer is read-only' }
  }

  return { authorized: true }
}

/**
 * Extracts auth credentials from WebSocket upgrade request without relying on query strings.
 */
export function extractAuthTokenFromReq(req: IncomingMessage): string | null {
  // 1. Check Sec-WebSocket-Protocol for converge.token.<TOKEN>
  const subprotocols = req.headers['sec-websocket-protocol']
  if (subprotocols) {
    const list = subprotocols.split(',').map((s) => s.trim())
    for (const p of list) {
      if (p.startsWith('converge.token.')) {
        return p.slice('converge.token.'.length)
      }
    }
  }

  // 2. Check Authorization: Bearer <TOKEN>
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim()
  }

  // Security: Query parameters (?token=...) are explicitly REJECTED to prevent
  // token exposure in browser history, proxy access logs, and referrer headers.
  return null
}

/**
 * Extracts validated user identity from trusted reverse proxy headers.
 */
export function extractProxyIdentity(req: IncomingMessage, config: SecurityConfig): AuthClaims | null {
  if (!config.trustProxyAuth) return null
  if (!config.proxySharedSecret || config.proxySharedSecret.length < 16) return null

  const proxySecret = req.headers['x-proxy-secret']
  if (!proxySecret || typeof proxySecret !== 'string') return null
  const secBuf = Buffer.from(proxySecret)
  const expBuf = Buffer.from(config.proxySharedSecret)
  if (secBuf.length !== expBuf.length || !crypto.timingSafeEqual(secBuf, expBuf)) {
    return null
  }

  const rawUser = req.headers['x-forwarded-user']
  if (!rawUser || typeof rawUser !== 'string') return null
  const user = rawUser.trim()
  if (user.length < 1 || user.length > 128 || /[\r\n\0]/.test(user)) return null

  const rawRoles = req.headers['x-forwarded-roles']
  const roles = typeof rawRoles === 'string' ? rawRoles.toLowerCase() : 'editor'
  const rawRoom = req.headers['x-forwarded-room']
  const room = typeof rawRoom === 'string' ? rawRoom.trim() : '*'

  if (room !== '*' && !isValidDocId(room)) {
    return null
  }

  return {
    sub: user,
    role: roles.includes('admin') ? 'admin' : roles.includes('viewer') ? 'viewer' : 'editor',
    room,
  }
}

/**
 * Administrative endpoint protection middleware for Express.
 * Requires valid ADMIN_API_KEY or admin JWT token.
 */
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const config = getSecurityConfig()

  // In test / dev mode, if auth not required and no admin key configured, allow
  if (!config.authRequired && !config.adminApiKey) {
    const docId = req.params.id || req.params.name
    if (docId && !isValidDocId(docId)) {
      return res.status(400).json({ error: 'INVALID_DOCUMENT_ID', message: 'Document ID must be alphanumeric (1-128 chars)' })
    }
    return next()
  }

  // Validate docId param if present
  const docId = req.params.id || req.params.name
  if (docId && !isValidDocId(docId)) {
    return res.status(400).json({ error: 'INVALID_DOCUMENT_ID', message: 'Document ID must be alphanumeric (1-128 chars)' })
  }

  // 1. Check API key via Authorization header: Bearer <KEY> or X-Admin-Key
  const authHeader = req.headers.authorization
  const xAdminKey = req.headers['x-admin-key']

  let candidateKey = ''
  if (typeof xAdminKey === 'string') {
    candidateKey = xAdminKey
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    candidateKey = authHeader.slice(7).trim()
  }

  if (config.adminApiKey && candidateKey) {
    const keyBuf = Buffer.from(candidateKey)
    const adminBuf = Buffer.from(config.adminApiKey)
    if (keyBuf.length === adminBuf.length && crypto.timingSafeEqual(keyBuf, adminBuf)) {
      return next()
    }
  }

  // 2. Alternatively check JWT token with admin role
  if (candidateKey && config.authSecret) {
    const tokenRes = verifyAuthToken(candidateKey, config.authSecret)
    if (tokenRes.valid && tokenRes.claims?.role === 'admin') {
      return next()
    }
  }

  // Unauthorized
  return res.status(401).json({
    error: 'UNAUTHORIZED',
    message: 'Administrative authorization required for this endpoint.',
  })
}

/**
 * Document-level read/query authorization middleware for Express history/retention routes.
 * Enforces docId format and requires viewer authorization when auth is required.
 */
export function docAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const config = getSecurityConfig()
  const docId = req.params.id || req.params.name || 'demo'

  if (!isValidDocId(docId)) {
    return res.status(400).json({ error: 'INVALID_DOCUMENT_ID', message: 'Document ID must be alphanumeric (1-128 chars)' })
  }

  // In test / dev mode when auth is not required, permit access
  if (!config.authRequired) {
    return next()
  }

  let claims: AuthClaims | null = null
  if (config.trustProxyAuth) {
    claims = extractProxyIdentity(req, config)
  }

  if (!claims) {
    const token = extractAuthTokenFromReq(req)
    if (token && config.authSecret) {
      const verifyRes = verifyAuthToken(token, config.authSecret)
      if (verifyRes.valid) {
        claims = verifyRes.claims || null
      }
    }
  }

  // Admin API key also grants access
  const authHeader = req.headers.authorization
  const xAdminKey = req.headers['x-admin-key']
  const candidateKey = typeof xAdminKey === 'string' ? xAdminKey : authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  if (config.adminApiKey && candidateKey) {
    const keyBuf = Buffer.from(candidateKey)
    const adminBuf = Buffer.from(config.adminApiKey)
    if (keyBuf.length === adminBuf.length && crypto.timingSafeEqual(keyBuf, adminBuf)) {
      return next()
    }
  }

  if (!claims) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authentication required to access document data.',
    })
  }

  const authRes = isAuthorizedForRoom(claims, docId, 'viewer')
  if (!authRes.authorized) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: authRes.reason || 'Not authorized for this document.',
    })
  }

  return next()
}

/**
 * Per-connection sliding window rate limiter.
 */
export class ConnectionRateLimiter {
  private messageTimestamps: number[] = []
  private readonly windowMs: number = 1000
  private consecutiveErrors: number = 0

  constructor(
    private maxPerSec: number = 200,
    private maxConsecutiveErrors: number = 5
  ) {}

  public recordMessage(): boolean {
    const now = Date.now()
    const cutoff = now - this.windowMs
    while (this.messageTimestamps.length > 0 && this.messageTimestamps[0] < cutoff) {
      this.messageTimestamps.shift()
    }
    if (this.messageTimestamps.length >= this.maxPerSec) {
      return false // Limit exceeded
    }
    this.messageTimestamps.push(now)
    return true
  }

  public recordError(): boolean {
    this.consecutiveErrors++
    return this.consecutiveErrors <= this.maxConsecutiveErrors
  }

  public resetErrors(): void {
    this.consecutiveErrors = 0
  }
}
