# Converge: Known Limitations & Architectural Boundaries

This document candidly outlines architectural boundaries, trade-offs, and current engineering limitations.

---

## 1. Verified Active Boundaries & Architectural Trade-offs

### 1.1 Single-Server Room In-Memory Registry
* **Impact**: All active WebSocket connections for a given collaborative room must connect to the same server process.
* **Trade-off**: Maintains an authoritative in-memory `Y.Doc` instance per room, serializing persistence queues and guaranteeing sequential database transactions without distributed lock contention.
* **Production Path**: Deploy an authenticating API gateway with sticky room routing (consistent hashing by `doc_id`), or introduce a cross-instance broadcast layer (e.g., Redis Pub/Sub).

### 1.2 Edge TLS Termination & Reverse-Proxy Deployment
* **Impact**: The Node.js server serves HTTP and unencrypted WebSockets (`ws://`) directly. It does not terminate TLS natively.
* **Design Context**: Production deployments expect TLS termination at an edge gateway, ingress controller, or reverse proxy (e.g. Cloudflare, AWS ALB, NGINX, Caddy). When deployed behind a proxy, `TRUST_PROXY_AUTH=true` requires an HMAC-SHA256 signature (`X-Auth-Signature`) over forwarded identity headers using `PROXY_SHARED_SECRET`.
* **Production Path**: Deploy behind a TLS-terminating load balancer or reverse proxy. Do not expose unencrypted HTTP/WS directly to untrusted public networks without TLS termination.

### 1.3 Node-Based Integration Testing vs Headless Browser Driving
* **Impact**: The automated test suite (`pnpm test`, 171 tests across 13 suites) executes network-level integration tests using real `WebSocket` connections, real PostgreSQL ACID transactions, LevelDB disk persistence, and real Monaco editor document models. It does not spin up headless browser instances (Playwright/Puppeteer) to drive browser DOM cursor rendering.
* **Design Context**: Validates protocol framing, byte-level Yjs convergence, transactional durability, client state machines, and crash recovery with rapid test cycle times (~5.7s for 171 tests) without requiring external browser binary downloads or display servers.
* **Production Path**: Add a Playwright browser E2E test suite running in a dedicated browser-enabled CI runner for visual Monaco cursor and DOM paint verification.

### 1.4 Native Dependency Compilation (Leveldown / LevelDB)
* **Limitation**: `y-leveldb` relies on `leveldown`, which compiles C++ native bindings.
* **Impact**: In minimal containerized Docker environments (e.g. Alpine), build essentials (`python3`, `make`, `g++`) must be installed during `pnpm install`.

---

## 2. Resolved Architectural Deficiencies

* **[RESOLVED] Perimeter & Application-Level Authentication**: Implemented HMAC-SHA256 capability tokens (`?token=`), role-based authorization (`admin`, `editor`, `viewer`), administrative API key authentication (`ADMIN_API_KEY`), Origin allowlisting, and proxy header cryptographic verification (`X-Auth-Signature`).
* **[RESOLVED] Bounded Log Compaction**: Transactional snapshot checkpointing (`doc_snapshots`) and log pruning are fully implemented via `POST /doc/:id/compact` and verified by recovery benchmarks.
* **[RESOLVED] Semantic vs Syntactic Conflict Attribution**: TypeScript AST static analysis running in a dedicated Web Worker (`SemanticGuard`) detects and attributes concurrent compile-time merge conflicts.
* **[RESOLVED] PostgreSQL Dual-Write Inconsistency**: Repaired via atomic PostgreSQL transactions (`BEGIN ... COMMIT`) binding operation rows and durable idempotency records (`durable_acks`) with database uniqueness constraints.
* **[RESOLVED] Monaco Persistence State Visibility**: `DurableSyncClient` is fully integrated into Monaco (`useYDoc`, `EditorPane`, `ConnectionStatusBadge`), providing real-time visibility into `✓ Saved`, `Saving (N)…`, `Unconfirmed (N)`, and `Save Failed (N)`.
