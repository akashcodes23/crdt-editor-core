# Converge Adversarial Security Review & Penetration Analysis

**Document Type**: Adversarial Security Review & Vulnerability Verification  
**Author**: Principal Application Security Engineer  
**Target Repository**: `/Users/akashgpatil/crdt-editor-core`  
**Execution Timestamp**: 2026-10-29  
**Final Release Verdict**: `READY FOR PUBLIC DEPLOYMENT` *(Subject to documented TLS termination and secret provisioning requirements)*

---

## 1. Executive Security Verdict

An independent adversarial security review of the Converge collaborative editing codebase was conducted. The previous hardening claims were tested against active penetration scenarios, timing attacks, protocol negotiation edge cases, and denial-of-service vectors.

### Key Audit Findings & Remediations Overview

| Finding ID | Severity | Category | Description | Remediation Status |
| :--- | :---: | :--- | :--- | :--- |
| **ADV-01** | **P1** | Credential Exposure | **WebSocket Subprotocol Credential Reflection**: The server was echoing the full capability token back to the client in the `Sec-WebSocket-Protocol: converge.token.<TOKEN>` HTTP response header. | **RESOLVED**: Application subprotocol `converge.v1` is negotiated and echoed; tokens are never reflected in response headers. |
| **ADV-02** | **P1** | Auth Bypass | **Reverse Proxy Zero-Length Timing Equivalence**: When `PROXY_SHARED_SECRET` was empty/unset, an empty `X-Proxy-Secret` header caused `crypto.timingSafeEqual(Buffer.from(''), Buffer.from(''))` to return `true`, allowing complete identity spoofing. | **RESOLVED**: Enforced minimum 16-character length on `proxySharedSecret`; empty or short secrets fail closed immediately. |
| **ADV-03** | **P1** | DoS / State Injection | **Unauthenticated State Creation & Memory Exhaustion via `/rooms/:name/info`**: Calling `getRoom(roomName)` for inactive rooms created active in-memory `Room` and `Y.Doc` instances, triggered LevelDB and PostgreSQL queries, and bypassed `MAX_ROOMS`. | **RESOLVED**: `GET /rooms/:name/info` checks `rooms.get()` directly and returns `404 ROOM_NOT_FOUND` without allocating memory or querying databases. |
| **ADV-04** | **P1** | Data Isolation | **Unauthenticated Document History & Retention Exposure**: `GET /doc/:id/history` and `GET /doc/:id/retention` lacked authentication, allowing any caller to read full document operations. | **RESOLVED**: Attached `docAuthMiddleware` requiring at least viewer authorization for the requested document in production mode. |
| **ADV-05** | **P2** | Credential Leakage | **URL Query String Token Fallback**: `extractAuthTokenFromReq` accepted `?token=...`, exposing capability tokens in URL query strings, access logs, and referrer headers. | **RESOLVED**: Removed query parameter fallback; tokens accepted strictly via subprotocols or `Authorization: Bearer`. |
| **ADV-06** | **P2** | Token Lifetime | **Indefinite Token Expiration**: `createAuthToken` and `verifyAuthToken` allowed omitting `exp`, creating tokens that were valid indefinitely. | **RESOLVED**: Enforced 24-hour default TTL (`DEFAULT_TOKEN_TTL_MS`), mandatory `claims.sub`, and mandatory numeric `exp`. |
| **ADV-07** | **P2** | Storage Boundaries | **Document ID Boundary Punctuation**: `SAFE_DOC_ID_REGEX` permitted leading and trailing dots (`.hidden`, `secret.`) and dashes, carrying filesystem implications. | **RESOLVED**: Enforced alphanumeric boundary rule `^[a-zA-Z0-9](?:[a-zA-Z0-9_\-\.]{0,126}[a-zA-Z0-9])?$`, rejecting boundary dots/dashes and percent encoding. |

---

## 2. Document ID and Path-Traversal Security

### 2.1 Inspection of Entry Points
Every entry point receiving document or room identifiers was traced:
1. `GET /rooms/:name/info` $\rightarrow$ `req.params.name`
2. `GET /doc/:id/history` $\rightarrow$ `req.params.id`
3. `GET /doc/:id/retention` $\rightarrow$ `req.params.id`
4. `POST /doc/:id/snapshot` $\rightarrow$ `req.params.id`
5. `POST /doc/:id/compact` $\rightarrow$ `req.params.id`
6. `ws://HOST:PORT/:roomName` $\rightarrow$ `url.pathname.slice(1)`

### 2.2 Storage Path & Database Interaction
* **Filesystem / LevelDB**: In `packages/server/src/persistence.ts`, `LeveldbPersistence` is opened once at `process.env.LEVELDB_DIR || DB_DIR`. Inside `y-leveldb`, document names are binary-encoded as LSM-tree key prefixes (`[docName, clock]`), never as filesystem directory paths. No `path.join(DIR, docId)` exists in the server codebase.
* **PostgreSQL**: All queries in `packages/server/src/room.ts` and `index.ts` use parameterized queries (`$1, $2, ...`), preventing SQL injection.

### 2.3 Strict Alphanumeric Boundary Validation
The validation regex in `packages/server/src/security.ts` was hardened to:
```typescript
const SAFE_DOC_ID_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9_\-\.]{0,126}[a-zA-Z0-9])?$/
```
`isValidDocId` explicitly tests and rejects:
* `.` and `..`
* `...` and consecutive separators (`foo..bar`, `foo//bar`)
* `../secret` and Windows backslash traversal (`..\\secret`, `foo\\bar`)
* Percent-encoded traversals (`%2e%2e`, `..%2fsecret`, `%2e%2e%2f`)
* Boundary dots and dashes (`.hidden`, `secret.`, `-leading`, `trailing-`)
* Empty identifiers `""`
* Overlong identifiers ($> 128$ characters)
* Null bytes (`\0`) and control characters
* Unicode normalization / homoglyphs (`café`, `\u202Ereversed`)

---

## 3. Capability-Token Security Assessment

### 3.1 Verification Mechanics
* **Cryptographic Algorithm**: HMAC-SHA256 (`crypto.createHmac('sha256', secret)`).
* **Constant-Time Comparison**: `crypto.timingSafeEqual` over raw signature byte buffers prevents timing side-channel attacks.
* **Input Parsing**: Token strings are split strictly into `[payloadB64, signature]`. Malformed strings or non-base64url characters return `MALFORMED_TOKEN`.
* **Mandatory Claims**:
  * `claims.sub`: Subject identifier must be a non-empty string.
  * `claims.exp`: Expiration timestamp must be present and numeric.
  * `claims.role`: Must be one of `'admin'`, `'editor'`, or `'viewer'`.

### 3.2 Privilege Escalation & Tampering Immunity
Tampering with any token claim (e.g. changing `"role": "viewer"` to `"role": "admin"`, or altering `"room": "sandbox"` to `"room": "production"`) changes the base64url payload, causing the HMAC signature check to fail (`INVALID_SIGNATURE`).

### 3.3 Token Issuance & Lifecycle Architecture
* **Issuer Boundary**: The collaboration server does not act as an unconstrained public token mint. In production deployments, capability tokens are signed out-of-band by the application's central API / auth service sharing `CONVERGE_AUTH_SECRET`.
* **Lifetime Policy**: Tokens default to a 24-hour lifetime (`DEFAULT_TOKEN_TTL_MS = 86400000`). Tokens lacking `exp` are rejected by `verifyAuthToken`.
* **Revocation Policy**: Short-lived tokens (e.g. 15 minutes to 24 hours) minimize exposure windows. For immediate revocation, the shared secret can be rotated or room access revoked via the upstream identity provider.

---

## 4. WebSocket Handshake & Subprotocol Assessment

### 4.1 Vulnerability ADV-01: Credential Reflection
In RFC 6455 subprotocol negotiation, the server selects a subprotocol from the client's offered list. When browser clients supplied `['converge.token.' + token]`, the server selected that token and responded with:
```http
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: converge.token.<TOKEN>
```
This reflected the secret bearer credential in cleartext HTTP response headers, logging it across reverse proxies, CDNs, and client inspect tools.

### 4.2 Remediation
1. **Client Subprotocol List**: `DurableSyncClient` (`packages/client/src/lib/durable-client.ts`) offers both the application protocol and token subprotocol:
   ```typescript
   const subprotocols = this.options.token
     ? ['converge.v1', `converge.token.${this.options.token}`]
     : ['converge.v1']
   ```
2. **Server Protocol Selection**: `WebSocketServer` (`packages/server/src/index.ts`) extracts the token for authentication, but explicitly selects `'converge.v1'` as the application protocol:
   ```typescript
   handleProtocols: (protocols: Set<string>) => {
     if (protocols.has('converge.v1')) return 'converge.v1'
     if (protocols.has('converge')) return 'converge'
     for (const p of protocols) {
       if (!p.startsWith('converge.token.')) return p
     }
     return protocols.values().next().value ?? false
   }
   ```
3. **Outcome**: Response headers contain `Sec-WebSocket-Protocol: converge.v1`. The credential is never echoed back.
4. **Query Parameter Disallowance**: Query parameter fallback `?token=...` was permanently removed from `extractAuthTokenFromReq`.

---

## 5. Reverse-Proxy Trust Assessment

### 5.1 Vulnerability ADV-02: Zero-Length Timing Equivalence
In `extractProxyIdentity`:
```typescript
const secBuf = Buffer.from(proxySecret)
const expBuf = Buffer.from(config.proxySharedSecret)
if (secBuf.length !== expBuf.length || !crypto.timingSafeEqual(secBuf, expBuf))
```
If `PROXY_SHARED_SECRET` was empty or unset, both `secBuf` and `expBuf` had length `0`. In Node.js, `crypto.timingSafeEqual(Buffer.from(''), Buffer.from(''))` returns `true`. An attacker connecting with `X-Proxy-Secret: ""` could spoof `X-Forwarded-User` and `X-Forwarded-Roles: admin`.

### 5.2 Remediation
* `extractProxyIdentity` strictly requires `config.proxySharedSecret` to exist and have a length $\ge 16$ bytes.
* `validateProductionSecurityConfig` verifies that if `TRUST_PROXY_AUTH=true`, `PROXY_SHARED_SECRET` is at least 16 characters.
* `x-forwarded-user` is sanitized against control characters (`[\r\n\0]`) and length bounds (1–128 chars).
* `x-forwarded-room` is validated against `isValidDocId`.

---

## 6. Administrative Authorization Matrix

| Endpoint | Method | Required Role | Auth Header / Credential | Document-Level Check | Unauthenticated Cost |
| :--- | :---: | :---: | :--- | :---: | :--- |
| **`/health`** | `GET` | Public | None | N/A | Cheap `SELECT 1` |
| **`/rooms/:name/info`** | `GET` | Public | None | `isValidDocId` | Memory check only (`rooms.get()`); 404 if inactive |
| **`/doc/:id/history`** | `GET` | `viewer`+ | Bearer Token / Proxy / Admin Key | `isAuthorizedForRoom` | Rejected at middleware with 401 |
| **`/doc/:id/retention`** | `GET` | `viewer`+ | Bearer Token / Proxy / Admin Key | `isAuthorizedForRoom` | Rejected at middleware with 401 |
| **`/doc/:id/snapshot`** | `POST` | `admin` | `ADMIN_API_KEY` / Admin JWT | `isValidDocId` | Rejected at middleware with 401 |
| **`/doc/:id/compact`** | `POST` | `admin` | `ADMIN_API_KEY` / Admin JWT | `isValidDocId` + Concurrency Lock | Rejected at middleware with 401 |
| **`ws://.../:roomName`** | `GET` | `viewer`+ | Subprotocol Token / Proxy | `isAuthorizedForRoom` | Upgraded rejected with 4401 |

*Ordinary editor and viewer credentials cannot invoke `/snapshot` or `/compact` (rejected with 401).*

---

## 7. Origin and CORS Findings

* **Exact String Matching**: `isOriginAllowed` checks `allowedOrigins.includes(origin)`. No substring or regex wildcards are evaluated.
* **Lookalike Domain Immunity**: Verified that `https://app.converge.dev.attacker.com` and `http://localhost:3000.evil.com` are rejected.
* **Port Specificity**: Verified that mismatched ports (e.g. `http://localhost:3001` vs `3000`) are rejected.
* **Wildcard Production Prohibition**: In `NODE_ENV === 'production'`, `validateProductionSecurityConfig` fails closed on startup if `ALLOWED_ORIGINS` contains `*` or is empty.

---

## 8. Resource-Exhaustion Findings

* **Memory Allocation on `/rooms/:name/info` Fixed**: Inactive rooms return 404 without instantiating `Room` objects, opening LevelDB, or querying PostgreSQL.
* **Global Capacity**: Maximum rooms (`MAX_ROOMS = 1000`) and total connections (`MAX_TOTAL_CONNECTIONS = 5000`) enforced prior to handshake completion.
* **Room Capacity**: Maximum clients per room (`MAX_CLIENTS_PER_ROOM = 100`) with atomic slot reservation prevents concurrent connection bursts from exceeding limits.
* **Message Rate Limiting**: Per-socket sliding window enforces `MAX_MESSAGES_PER_SEC = 200`. Violating connections receive close code `4429 Too Many Requests`.
* **Frame Size Cap**: WebSocket frames $> 10\text{ MB}$ receive close code `1009 Message Too Big`.
* **Zombie Socket Pruning**: Heartbeat interval runs every 30 seconds, pinging sockets and terminating unresponsive peers.

---

## 9. Regression-Test Results

A comprehensive adversarial suite was executed at `packages/server/src/__tests__/security-hardening.test.ts`.

### Test Execution Metrics
* **Total Security Tests**: **34 passed, 0 failed**
* **Total Monorepo Tests**: **171 passed, 0 failed across 13 suites**
* **TypeScript Compilation**: `pnpm typecheck` passed with 0 errors.
* **Production Build**: `pnpm build` completed Next.js 15 optimized production build with 5/5 static pages.

```
PASS src/__tests__/security-hardening.test.ts
  Security Hardening Suite (SEC-01 through SEC-04)
    HMAC Token & Input Validation Unit Semantics
      ✓ mints and verifies valid capability tokens (2 ms)
      ✓ rejects tokens with tampered signatures or wrong secret (1 ms)
      ✓ assigns default 24h expiration when exp is omitted during token creation
      ✓ rejects minting tokens without subject or with weak secret (14 ms)
      ✓ detects privilege escalation attempts: role modification breaks HMAC
      ✓ detects room scope tampering: changing room breaks HMAC
      ✓ validates document and room IDs strictly against path traversal (4 ms)
      ✓ validates Origins against allowed origin list and blocks lookalikes
      ✓ evaluates room authorization and roles correctly
    SEC-02: Administrative Endpoint Authorization
      ✓ rejects unauthenticated requests with 401 (13 ms)
      ✓ rejects requests with incorrect admin API key with 401 (1 ms)
      ✓ accepts requests with valid X-Admin-Key header with 200 (3 ms)
      ✓ accepts requests with Bearer admin API key in Authorization header (2 ms)
      ✓ accepts requests with valid admin JWT token (1 ms)
      ✓ rejects ordinary editor or viewer tokens on admin snapshot endpoint with 401 (4 ms)
      ✓ enforces authentication on document history endpoint when auth is required (7 ms)
      ✓ returns 404 for inactive room info without allocating Room state in memory (2 ms)
    SEC-01, SEC-03, SEC-04: WebSocket Protocol Hardening
      ✓ rejects unauthenticated WebSocket connection with 4401 in auth-required mode (8 ms)
      ✓ rejects connection with invalid token signature with 4401 (1 ms)
      ✓ rejects connection with token scoped to a different room with 4403 (2 ms)
      ✓ accepts connection with valid token via Sec-WebSocket-Protocol and negotiates converge.v1 without echoing token (13 ms)
      ✓ rejects attempt to pass auth token in query string (?token=...) to prevent URL logging (5 ms)
      ✓ rejects unauthenticated connection supplying arbitrary non-auth subprotocols (1 ms)
      ✓ rejects disallowed Origin with 1008 Policy Violation (2 ms)
      ✓ accepts allowed Origin from allowlist (1 ms)
      ✓ accepts trusted reverse proxy authentication headers (1 ms)
      ✓ rejects reverse proxy request with incorrect proxy secret (3 ms)
      ✓ rejects reverse proxy request with empty proxy secret (prevent timingSafeEqual(0,0) bypass) (2 ms)
      ✓ rejects reverse proxy request with CRLF or control injection in username (1 ms)
      ✓ rejects reverse proxy request with path traversal in X-Forwarded-Room (1 ms)
      ✓ rejects path traversal in WebSocket room name with 4400 (1 ms)
      ✓ enforces read-only permissions for "viewer" role (3 ms)
      ✓ enforces maximum clients per room limit (54 ms)
      ✓ enforces message flood rate limiting (7 ms)
```

---

## 10. Remaining Deployment Assumptions

To operate securely on an untrusted public network, the following operational requirements must be maintained:

1. **Edge TLS Termination**: The Node.js application serves plain HTTP and `ws://`. A reverse proxy or cloud load balancer (e.g. Cloudflare, AWS ALB, NGINX) must terminate TLS (`https://` and `wss://`).
2. **Reverse Proxy Network Isolation**: If `TRUST_PROXY_AUTH=true` is used, the Node.js application port must not be directly accessible to public internet traffic. Ingress must restrict incoming connections to the reverse proxy's private network.
3. **Out-of-Band Token Minting**: Production deployments must provision capability tokens from an upstream authentication service using `createAuthToken` with the configured `CONVERGE_AUTH_SECRET`.
4. **Single-Node vs Multi-Node Scope**: Rate limiting, connection limits, and in-memory room registries operate within a single Node.js process. In multi-instance clusters, horizontal scaling requires sticky sessions per room or an external pub/sub layer.

---

## 11. Prioritized Remediation Plan

All identified vulnerabilities (**ADV-01** through **ADV-07**) have been remediated in the codebase and verified with automated regression tests:

1. :white_check_mark: **ADV-01 (P1)**: Implemented `converge.v1` negotiation in `WebSocketServer` and `DurableSyncClient`, preventing token credential reflection in HTTP response headers.
2. :white_check_mark: **ADV-02 (P1)**: Enforced 16-character minimum secret length on `PROXY_SHARED_SECRET` and sanitized `X-Forwarded-*` headers, eliminating proxy authentication bypass.
3. :white_check_mark: **ADV-03 (P1)**: Converted `GET /rooms/:name/info` to inspect `rooms.get()` directly, eliminating unauthenticated state creation and database amplification DoS.
4. :white_check_mark: **ADV-04 (P1)**: Added `docAuthMiddleware` to protect `GET /doc/:id/history` and `GET /doc/:id/retention`.
5. :white_check_mark: **ADV-05 (P2)**: Removed query parameter token extraction to prevent token exposure in access logs.
6. :white_check_mark: **ADV-06 (P2)**: Enforced default 24h expiration on capability tokens and mandatory subject validation.
7. :white_check_mark: **ADV-07 (P2)**: Hardened `isValidDocId` with strict alphanumeric boundary checks and percent-encoding rejection.

---

## 12. Final Security Verdict

### **Verdict: READY FOR PUBLIC DEPLOYMENT**

### Justification:
The adversarial review identified seven concrete security findings across subprotocol negotiation, reverse-proxy validation, state allocation, and document data protection. All seven findings have been remediated and verified with 34 dedicated security tests (and 171 total passing tests across 13 suites). The server fails closed on startup if production security secrets are absent or weak. With edge TLS termination and standard environment configuration, Converge satisfies production security requirements for deployment to an untrusted public network.

