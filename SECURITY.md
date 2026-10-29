# Security Policy & Hardening Specification

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

---

## 1. Security Model & Deployment Profiles

Converge enforces distinct security policies depending on deployment environment:

| Feature / Control | Local Development (`NODE_ENV !== 'production'`) | Production / Untrusted Network (`NODE_ENV === 'production'`) |
| :--- | :--- | :--- |
| **Authentication Requirement** | Permissive if `AUTH_REQUIRED !== 'true'` | **Enforced (Fail-Closed on Startup)** |
| **Mandatory Environment Secrets** | Optional (defaults for tests/local) | `CONVERGE_AUTH_SECRET`, `ADMIN_API_KEY`, `ALLOWED_ORIGINS` |
| **Origin / CORS Policy** | Permissive (`*` allowed for local dev) | Strict Explicit Allowlist (Wildcard `*` causes startup abort) |
| **Doc / Room ID Validation** | Strictly Enforced (`^[a-zA-Z0-9_\-\.]{1,128}$`) | Strictly Enforced (`^[a-zA-Z0-9_\-\.]{1,128}$`) |
| **Connection & Frame Limits** | Default sliding window & frame limits | Explicit capacity bounds, per-socket rate limits, payload caps |

---

## 2. Authentication & Authorization Architecture

### 2.1 WebSocket Capability Tokens (Browser-Safe Handshake)
Standard browser `WebSocket` APIs cannot attach custom HTTP headers during connection establishment. Placing authentication tokens in URL query strings (e.g., `ws://host/room?token=XYZ`) exposes credentials in browser history, proxy access logs, and referrer headers.

Converge uses the standardized **`Sec-WebSocket-Protocol`** negotiation mechanism:
```http
GET /my-document HTTP/1.1
Host: converge.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Protocol: converge.token.<HMAC_SHA256_TOKEN>
```
The server validates the token in constant time during connection upgrade and echoes `converge.token.<TOKEN>` back to complete the negotiation.

#### Token Structure & Claims
Tokens are formatted as `<base64url(claims)>.<hmac_sha256_signature>`:
```json
{
  "sub": "user_12345",
  "room": "doc_alpha",
  "role": "editor",
  "iat": 1730174400000,
  "exp": 1730178000000
}
```
* **`sub`**: Subject user identifier.
* **`room` / `rooms`**: Explicit document scope. A token scoped to `doc_alpha` is rejected if connecting to `doc_beta` (`4403 Forbidden`). A token with `"room": "*"` has global scope.
* **`role`**:
  * `'admin'`: Unrestricted document access and compaction/snapshot privileges.
  * `'editor'`: Read/write access; can submit updates and broadcast awareness.
  * `'viewer'`: Read-only access; state-vector sync and awareness are permitted, but durable update submissions are rejected (`ACK_STATUS_FAILED`).

### 2.2 Trusted Reverse-Proxy Authentication Mode
For enterprise deployments behind authenticating reverse proxies (e.g., Cloudflare Access, Envoy, Traefik, AWS ALB with OIDC):
* Set `TRUST_PROXY_AUTH=true` and configure a shared secret `PROXY_SHARED_SECRET`.
* The reverse proxy strips client-supplied `X-*` headers and forwards authenticated identity:
  * `X-Proxy-Secret`: Must match `PROXY_SHARED_SECRET` (checked in constant time).
  * `X-Forwarded-User`: Authenticated user subject.
  * `X-Forwarded-Roles`: `admin`, `editor`, or `viewer`.
  * `X-Forwarded-Room`: Document authorization scope (or `*`).

### 2.3 Administrative Endpoint Authorization
All compaction and checkpoint triggers require explicit admin authorization:
* `POST /doc/:id/snapshot`
* `POST /doc/:id/compact`

Protected via `adminAuthMiddleware`:
* Validated against `ADMIN_API_KEY` via `X-Admin-Key: <KEY>` or `Authorization: Bearer <KEY>`.
* Alternatively, an HMAC token with `"role": "admin"` is accepted via `Authorization: Bearer <TOKEN>`.
* Unauthenticated calls return `401 Unauthorized`. Missing admin permissions return `403 Forbidden`.

---

## 3. Network Hardening & Resource Protection

### 3.1 Origin Validation & CORS Allowlisting
* **WebSocket**: Validates `Origin` header during connection upgrade against `ALLOWED_ORIGINS` (`isOriginAllowed`). Disallowed origins are rejected with WebSocket close code `1008 Policy Violation`.
* **HTTP / REST**: CORS middleware dynamically validates the `Origin` header. Requests from unauthorized origins are rejected before route processing.
* **Fail-Closed Guarantee**: In `NODE_ENV === 'production'`, wildcard `*` or empty origins in `ALLOWED_ORIGINS` aborts server boot.

### 3.2 Input Sanitization & Path Traversal Mitigation
* Document and room identifiers are validated with regex `^[a-zA-Z0-9_\-\.]{1,128}$` (`isValidDocId`).
* Directory traversals (`../`, `..`, `/`, `\`), null bytes, query injection, and identifiers exceeding 128 characters are rejected immediately:
  * HTTP endpoints return `400 Bad Request` (`INVALID_DOCUMENT_ID`).
  * WebSockets close with `4400 Bad Request`.

### 3.3 Resource Bounds & DoS Defenses
* **Max Payload Size**: Incoming WebSocket frames are bounded to `MAX_PAYLOAD_BYTES` (default: 10 MB). Frames exceeding this trigger close code `1009 Message Too Big`.
* **Global Capacity**: Maximum rooms (`MAX_ROOMS`, default: 1,000) and global concurrent connections (`MAX_TOTAL_CONNECTIONS`, default: 5,000). Excess connections trigger `4429 Too Many Requests`.
* **Per-Room Client Bounds**: Maximum clients per room (`MAX_CLIENTS_PER_ROOM`, default: 100). Reserved slots prevent concurrent race conditions from exceeding room capacity.
* **Per-Connection Message Rate Limiting**: Sliding 1,000 ms window (`ConnectionRateLimiter`) limits inbound message flood to `MAX_MESSAGES_PER_SEC` (default: 200/sec). Exceeding limits triggers close code `4429 Too Many Requests`.
* **Decode Error Tracking**: Malformed binary frames and framing errors are capped at 5 consecutive occurrences before the socket is terminated with close code `1002 Protocol Error`.

---

## 4. WebSocket Close Code Reference

| Code | Standard / Custom | Description |
| :--- | :--- | :--- |
| **`1000`** | Standard RFC 6455 | Normal Closure (graceful client/server disconnect) |
| **`1001`** | Standard RFC 6455 | Going Away (server shutdown sequence) |
| **`1002`** | Standard RFC 6455 | Protocol Error / Consecutive Decode Errors |
| **`1008`** | Standard RFC 6455 | Policy Violation (Disallowed WebSocket Origin) |
| **`1009`** | Standard RFC 6455 | Message Too Big (frame exceeds `MAX_PAYLOAD_BYTES`) |
| **`4400`** | Custom Converge | Bad Request (malformed room or document identifier) |
| **`4401`** | Custom Converge | Unauthorized (missing, invalid, or expired capability token) |
| **`4403`** | Custom Converge | Forbidden (token not authorized for requested room) |
| **`4429`** | Custom Converge | Too Many Requests (message rate limit or capacity reached) |

---

## 5. Security Regression Test Suite

All security invariants are continuously verified in CI by `packages/server/src/__tests__/security-hardening.test.ts`:
* 24 automated security tests covering token minting/verification, tampering detection, room scoping, role authorization, admin endpoint protection, path traversal defenses, origin validation, room capacity limits, and message rate limits.

---

## 6. Reporting a Vulnerability

If you discover a security vulnerability in Converge, please report it privately:
* Email: [akashgpatil23.05@gmail.com](mailto:akashgpatil23.05@gmail.com)
* Please include reproduction steps, environment details, and potential impact.
* We will acknowledge receipt within 48 hours and coordinate a fix prior to public disclosure.
