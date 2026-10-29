# ⚡ Converge

> **An industrial-grade, local-first collaborative development environment built around Conflict-Free Replicated Data Types (CRDTs), dual-tier ACID persistence, fault-tolerant WebSocket synchronization, point-in-time time-travel recovery, and Web Worker-based semantic conflict detection.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org/)
[![Yjs](https://img.shields.io/badge/CRDT-Yjs-orange.svg)](https://yjs.dev/)
[![Monaco](https://img.shields.io/badge/Editor-Monaco-brightgreen.svg)](https://microsoft.github.io/monaco-editor/)
[![PostgreSQL](https://img.shields.io/badge/Storage-PostgreSQL%20%2B%20LevelDB-blueviolet.svg)](https://www.postgresql.org/)
[![Tests](https://img.shields.io/badge/Tests-171%20Passing-success.svg)](packages/server/src/__tests__)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌟 Overview

**Converge** is a production-grade distributed collaborative code editor engineered to solve fundamental challenges in real-time systems: strong eventual consistency without centralized locks, transactional durability across dual-tier storage engines, sub-millisecond CRDT synchronization, and semantic conflict detection that catches compile-time errors surviving clean text merges.

Designed as an advanced software engineering portfolio project, Converge combines mathematical rigor (Yjs sequence CRDTs and Hybrid Logical Clocks) with production operational guarantees (PostgreSQL ACID transactions, LevelDB working cache recovery, HMAC-SHA256 capability tokens, and Monaco editor integration).

---

## 💡 Engineering Problems Converge Solves

| Challenge | Naive Collaborative Architecture | Converge Distributed Design |
| :--- | :--- | :--- |
| **Concurrent Convergence** | Centralized Operational Transformation (OT) requires an authoritative master lock, creating network bottlenecks and single-point-of-failure contention. | **Strong Eventual Consistency (SEC)** via Yjs CRDTs. Replicas merge concurrently without locks, converging deterministically to identical states regardless of packet arrival order. |
| **Network Bandwidth** | Retransmitting full document state snapshots on every keystroke scales $O(N)$ with document length, causing high latency on large files. | **Differential State Vectors**: Peers exchange minimal incremental binary diffs ($O(\Delta)$), achieving **97.28% to 99.94% wire payload reductions** (46–48 bytes per edit). |
| **Post-Merge Semantic Errors** | CRDTs guarantee text convergence (syntactic consistency), but cannot detect compile-time errors created when clean text merges break code logic (e.g. concurrent rename vs. function call). | **Semantic Guard**: An off-main-thread Web Worker running TypeScript AST analysis that detects and attributes concurrent compile-time merge conflicts (`CONFIRMED_CONCURRENT_CONFLICT`) within 200 ms. |
| **Persistence Dual-Write Inconsistency** | Writing to an in-memory CRDT and database separately causes state drift if a crash occurs between writes, leading to lost updates. | **Atomic Transaction Pipeline**: In-flight mutations are bound to an atomic PostgreSQL transaction inserting operation records and durable idempotency tokens (`durable_acks`) with unique constraints before hot cache storage. |
| **Unbounded Operation Logs** | Infinite append-only operation logs lead to slow cold starts and unbounded storage growth over time. | **Transactional Compaction**: Snapshot checkpoints fold historical operation streams, reducing cold restore latency by **1.93x–3.75x** with a **75.62% storage compaction ratio**. |
| **Network Disconnect Ambiguity** | Clients lose network connectivity during an edit and have no way of knowing whether their changes committed or were lost. | **4-State Durability Handshake**: Distinguishes `pending`, `durable`, `failed`, and `unknown` states, replaying unconfirmed updates automatically upon reconnection. |

---

## 🏗️ Architecture

```
                                  ┌──────────────────────────────────────────────┐
                                  │           Next.js 15 Client (Browser)        │
                                  │                                              │
                                  │  ┌─────────────────┐    ┌─────────────────┐  │
                                  │  │  Monaco Editor  │◄───┤ DurableSync-    │  │
                                  │  │  (Model & Caret)│    │ Client (Y.Doc)  │  │
                                  │  └─────────────────┘    └────────┬────────┘  │
                                  │           │                      │           │
                                  │           ▼                      ▼           │
                                  │  ┌─────────────────┐    ┌─────────────────┐  │
                                  │  │ Semantic Guard  │    │ IndexedDB Cache │  │
                                  │  │ (Web Worker)    │    │ (Offline-First) │  │
                                  │  └─────────────────┘    └─────────────────┘  │
                                  └──────────────────────────┬───────────────────┘
                                                             │ WebSocket (Custom Protocol)
                                                             │ Handshake: Subprotocol Token
                                                             ▼
                                  ┌──────────────────────────────────────────────┐
                                  │           Node.js Authority Server           │
                                  │                                              │
                                  │  ┌────────────────────────────────────────┐  │
                                  │  │  Security Context & Rate Limiter       │  │
                                  │  │  • Origin Allowlist  • HMAC-SHA256     │  │
                                  │  │  • Role Hierarchy    • Doc ID Guard    │  │
                                  │  └──────────────────┬─────────────────────┘  │
                                  │                     │                        │
                                  │  ┌──────────────────▼─────────────────────┐  │
                                  │  │  Authoritative Room Memory Registry    │  │
                                  │  │  • In-Memory Y.Doc   • In-Flight Mutex │  │
                                  │  │  • Peer Broadcast    • HLC Generator   │  │
                                  │  └──────────┬──────────────────┬──────────┘  │
                                  └─────────────┼──────────────────┼─────────────┘
                                                │                  │
                         Stream Writes & Replay │                  │ Hot Cache Restore
                                                ▼                  ▼
                         ┌─────────────────────────────┐    ┌─────────────────────┐
                         │      PostgreSQL Engine      │    │  LevelDB Storage    │
                         │  (Canonical ACID History)   │    │  (Fast Local Cache) │
                         │                             │    │                     │
                         │  • operations (WAL)         │    │  • y-leveldb        │
                         │  • doc_snapshots            │    │  • in-process K/V   │
                         │  • durable_acks             │    │                     │
                         └─────────────────────────────┘    └─────────────────────┘
```

---

## 🔄 Synchronization & Persistence Model

### 1. Differential State Synchronization
Converge utilizes Yjs sequence CRDTs. Rather than broadcasting full document trees, replicas maintain Lamport Vector Clocks and exchange compact binary state vectors:
1. **Step 1 Handshake**: The newly connected client sends its local state vector to the room authority.
2. **Step 2 Diffing**: The server calculates the missing delta operations and transmits only the un-applied update slice.
3. **Incremental Broadcast**: Subsequent user keystrokes are framed into binary update packets and broadcast to all connected room peers in $O(\Delta)$ wire space.

### 2. Dual-Tier Persistence Architecture
* **Tier 1: Canonical PostgreSQL Store (Source of Truth)**:
  * Every mutation is stored as a raw binary `BYTEA` operation stamped with a strictly monotonic Hybrid Logical Clock (`<time36>-<counter36>-<nodeId>`).
  * Enforces database uniqueness on `(doc_id, update_id)` to guarantee idempotent replay across server restarts.
* **Tier 2: In-Process LevelDB Hot Cache (Rapid Recovery)**:
  * Embedded key-value store using `y-leveldb` for sub-millisecond local room initialization.
  * On server boot, a room loads its LevelDB cache and reconciles with the authoritative PostgreSQL transaction log to guarantee zero data loss.

---

## 🛡️ Durable Acknowledgements & Failure Recovery

Standard WebSocket collaboration systems fire-and-forget edits in memory. If a node crashes before disk persistence, edits are silently dropped. Converge introduces a formal **Durable Update Protocol**:

```
[User Keystroke]
       │
       ▼
[DurableSyncClient: submitUpdate()]
       │
       ├─► Generates client-scoped updateId: "up-<clientID>-<timestamp>-<seq>"
       ├─► Status: 'pending' (starts ACK timeout countdown)
       ▼
[WebSocket: MESSAGE_DURABLE_UPDATE]
       │
       ▼
[Server: handleDurableUpdate()]
       │
       ├── 1. Deduplication check in recent memory cache
       ├── 2. PostgreSQL check in durable_acks
       ├── 3. In-flight mutex (serializes concurrent duplicate submissions)
       ├── 4. In-memory CRDT apply & peer broadcast
       │
       ▼
[PostgreSQL Atomic Transaction]
       │
       ├── BEGIN
       ├── INSERT INTO operations (...) ON CONFLICT (doc_id, update_id) DO NOTHING
       ├── INSERT INTO durable_acks (...) ON CONFLICT (doc_id, update_id) DO UPDATE SET status = 'durable'
       └── COMMIT
       │
       ▼
[LevelDB: storeUpdate()]
       │
       ├── Both Succeeded: Send ACK_STATUS_DURABLE (hlc)
       └── Partial Failure: UPDATE durable_acks SET status = 'failed'
                            Send ACK_STATUS_FAILED ('LEVELDB_FAILED')
```

### Client Durability States
* **`pending`**: Edit applied locally in Monaco and transmitted to the server; awaiting durable acknowledgement.
* **`durable`**: Server confirmed atomic commit to PostgreSQL WAL with an authoritative HLC timestamp. Monaco UI displays `✓ Saved`.
* **`failed`**: Server rejected the update (e.g. read-only permission violation, schema error).
* **`unknown`**: Connection dropped while an ACK was in flight. The outcome is ambiguous until reconnection, where the client automatically replays all unconfirmed updates using their original logical `updateId`.

---

## 🧠 Semantic Guard: Real-Time AST Conflict Detection

CRDTs ensure text convergence, but have no semantic awareness of programming languages. If **User A** renames a function declaration from `tick()` to `advance()`, while **User B** concurrently introduces a call to `tick()`, standard CRDTs merge the text cleanly without syntax errors. However, the code is semantically broken.

### How Semantic Guard Solves This:
1. **Isolated Web Worker**: Runs TypeScript language services in a dedicated background worker (`packages/client/src/lib/semantic-guard/semantic-guard.worker.ts`) off the browser main UI thread.
2. **Causal Conflict Attribution**: Compares post-convergence compiler diagnostics against recent remote edits. If an AST error references a symbol modified by a remote peer during a concurrent branch, it is categorized as a **`CONFIRMED_CONCURRENT_CONFLICT`**.
3. **Debounced Scheduler**: A 200 ms debounce window supersedes intermediate keystrokes during rapid typing bursts, **suppressing 90.0% of redundant AST compilation cycles**.
4. **Editor Visualizations**: Surfaces actionable conflict pills in the pane header (`⚠️ Semantic Conflict (1)`) and displays diagnostic squiggles in Monaco.

> **Scope & Limitations**: Semantic Guard performs full AST and type checking within the multi-file collaborative workspace. It does not load external `@types/*` from `node_modules` in this lightweight browser worker.

---

## 📊 Measured Performance Benchmarks

All metrics represent real, empirical measurements executed on Apple Silicon (`darwin arm64`, Node.js `v22.23.1`) against local PostgreSQL 15. Full methodology and percentile distributions documented in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

### 1. Wire Payload Reduction (Full State vs. Differential Sync)
*Excludes RFC 6455 framing; measures raw binary CRDT payload across single incremental edit.*

| Workload | Document Size | Naive Full State Payload | Converge Differential Diff | Measured Payload Reduction |
| :--- | :--- | :--- | :--- | :--- |
| **Small Document (~25 lines)** | 1,672 characters | 1,690 bytes | **46 bytes** | **97.28%** |
| **Medium Document (~250 lines)** | 17,197 characters | 17,216 bytes | **48 bytes** | **99.72%** |
| **Large Document (~1,200 lines)** | 84,297 characters | 84,316 bytes | **48 bytes** | **99.94%** |

### 2. Micro-Operation vs. Database Commit Timings
*Micro-operation sync measures V8 in-memory delta encoding/merging; database write measures live PostgreSQL transaction WAL commit.*

| Operation | Scope | Median (P50) | P95 | Statistical Notes |
| :--- | :--- | :---: | :---: | :--- |
| **In-Memory CRDT Sync** | V8 isolate memory only (no network, no disk) | **15.67 µs** | 44.62 µs (P90) | $N = 500$ sequential character edits |
| **PostgreSQL Write Latency** | Transaction commit + WAL append (`pg.Pool`) | **0.27 ms** | 0.46 ms | 50 consecutive transactional inserts |
| **Semantic Guard AST Analysis** | Small TypeScript file (~25 lines) in worker | **2.18 ms** | 5.79 ms | 30 warm incremental compilations |
| **Keystroke Burst Suppression** | Redundant compiler runs avoided during typing | **90.0% reduction** | — | 10 rapid keystrokes $\to$ 1 AST compilation |

### 3. Cold Recovery & Compaction Benchmarks (`pnpm benchmark:recovery`)
*Compares raw log replay vs. snapshot-assisted recovery from PostgreSQL storage across 50 trials.*

| Workload | Log Size | Full Log Replay (P50) | Snapshot + Tail (P50) | Speedup Factor | Exact State Match |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Workload S (100 ops)** | 100 ops | 0.58 ms | **0.30 ms** | **1.93x faster** | **100% Exact** |
| **Workload M (500 ops)** | 500 ops | 1.38 ms | **0.48 ms** | **2.88x faster** | **100% Exact** |
| **Workload L (1000 ops)** | 1,000 ops | 2.64 ms | **0.79 ms** | **3.33x faster** | **100% Exact** |

---

## 🛠️ Local Setup & Getting Started

### Prerequisites
* **Node.js**: $\ge 18$
* **pnpm**: $\ge 8$
* **Docker** or native **PostgreSQL 15**

### 1. Clone & Install
```bash
git clone https://github.com/akashcodes23/crdt-editor-core.git
cd crdt-editor-core
pnpm install
```

### 2. Configure Environment
Copy the environment template:
```bash
cp .env.example .env
```
*(The default configuration connects to `postgresql://crdt:password@localhost:5432/crdthistory` with local security defaults).*

### 3. Start PostgreSQL
```bash
# Option A: Docker Compose
docker compose up -d

# Option B: Native PostgreSQL (macOS Homebrew)
brew services start postgresql@15
createdb crdthistory
```

### 4. Run Development Servers
```bash
pnpm dev
```
* **Frontend**: [http://localhost:3000](http://localhost:3000) (Dual-pane collaborative split-screen)
* **Collaboration Server**: `http://localhost:1234` (`ws://localhost:1234`)

### 5. Run Live Demonstration
Follow the 75-second walkthrough in [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) to demonstrate real-time sync, offline partition recovery, and Semantic Guard conflict detection.

---

## 🧪 Testing & Verification Standard

Run the automated verification suite (**171 tests across 13 suites**, covering CRDT convergence, PostgreSQL ACID transactions, LevelDB partial-write recovery, HLC semantics, Monaco E2E sync, and security hardening):

```bash
# 1. Typecheck entire workspace
pnpm typecheck

# 2. Run all 13 test suites
pnpm test

# 3. Production package build
pnpm build
```

```
PASS src/__tests__/security-hardening.test.ts (34 tests)
PASS src/__tests__/websocket-clients-integration.test.ts (6 tests)
PASS src/__tests__/durability-fault-injection.test.ts (19 tests)
PASS src/__tests__/durable-client-monaco-e2e.test.ts (6 tests)
PASS src/__tests__/semantic-guard-worker.test.ts (6 tests)
PASS src/__tests__/postgres-transaction-durability.test.ts (6 tests)
PASS src/__tests__/compaction-races-and-recovery.test.ts (14 tests)
PASS src/__tests__/semantic-guard.test.ts (12 tests)
PASS src/__tests__/hlc-semantics.test.ts (18 tests)
PASS src/__tests__/crdt-convergence.test.ts (18 tests)
PASS src/__tests__/distributed-correctness.test.ts (8 tests)
PASS src/__tests__/hlc-and-recovery.test.ts (12 tests)
PASS src/__tests__/workspace-invariants.test.ts (12 tests)

Test Suites: 13 passed, 13 total
Tests:       171 passed, 171 total
Snapshots:   0 total
Time:        5.173 s
```

### Run Benchmarks
```bash
# Core differential sync & swarm benchmarks
pnpm benchmark

# Cold recovery & snapshot compaction benchmarks
pnpm benchmark:recovery

# Semantic Guard AST analysis & debounce benchmarks
pnpm benchmark:semantic-guard
```

---

## 🔒 Security Architecture & Deployment Assumptions

Converge implements application-level security hardening:
* **HMAC-SHA256 Capability Tokens**: Passed via WebSocket subprotocols (`['converge.v1', 'converge.token.<TOKEN>']`). The server negotiates `converge.v1`, ensuring credentials are **never reflected** in HTTP response headers.
* **Zero Query String Tokens**: Tokens in URL query strings (`?token=...`) are explicitly rejected to prevent leakage in server access logs and browser history.
* **Role-Based Authorization (RBAC)**: `viewer` clients are strictly read-only and prohibited from submitting updates (`packages/server/src/room.ts#L360-L380`). `editor` and `admin` roles control write and compaction APIs.
* **Directory Traversal Mitigation**: Document identifiers are validated with regex `^[a-zA-Z0-9](?:[a-zA-Z0-9_\-\.]{0,126}[a-zA-Z0-9])?$`. Slashes, null bytes, URI encodings, and `..` sequences are rejected with `400 BAD REQUEST`.
* **Fail-Closed Production Guard**: `validateProductionSecurityConfig()` prevents the server from booting in `NODE_ENV=production` if secrets are missing, short, or configured with wildcard origins.

### Deployment Assumptions
* **Edge TLS Termination Required**: The Node.js application process deliberately serves unencrypted HTTP/WS (`http://` and `ws://`). For production deployment on public networks, it must be deployed behind an edge reverse proxy (NGINX, Caddy, Cloudflare, or AWS ALB) that terminates TLS (`https://` and `wss://`). See [`SECURITY.md`](SECURITY.md).

---

## ⚠️ Known Limitations & Architectural Boundaries

* **Single-Server Room Coordinator**: All active WebSocket connections for a given collaborative room must connect to the same server process. Horizontal multi-node scaling requires sticky room routing (consistent hashing by `doc_id`) or a cross-instance broadcast layer (Redis Pub/Sub).
* **Headless Browser Test Boundary**: Automated tests execute against live Monaco models, WebSockets, and PostgreSQL in Node.js. Visual DOM cursor paint verification via Playwright is documented with a complete implementation plan in [`docs/BROWSER_TESTING_PLAN.md`](docs/BROWSER_TESTING_PLAN.md).
* **Native C++ Bindings**: LevelDB (`leveldown`) compiles native C++ binaries during installation. Containerized Alpine builds require `make`, `python3`, and `g++`.

---

## 📚 Technical Documentation Directory

* [`docs/FINAL_RELEASE_GATE.md`](docs/FINAL_RELEASE_GATE.md): Independent Staff Engineer release gate audit and verified quality gates.
* [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md): 75-second step-by-step live demonstration script.
* [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md): Empirical benchmark methodology, percentile distributions, and recovery metrics.
* [`docs/DURABILITY_CONTRACT.md`](docs/DURABILITY_CONTRACT.md): ACID persistence contract, partial-write recovery, and HLC acknowledgement semantics.
* [`docs/BROWSER_TESTING_PLAN.md`](docs/BROWSER_TESTING_PLAN.md): Headless browser testing gap analysis and Playwright E2E specification.
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): Distributed systems design, wire framing, and persistence pipelines.
* [`docs/SECURITY_HARDENING_REPORT.md`](docs/SECURITY_HARDENING_REPORT.md): Application security hardening, HMAC tokens, and rate limits.
* [`docs/ADVERSARIAL_SECURITY_REVIEW.md`](docs/ADVERSARIAL_SECURITY_REVIEW.md): Principal security engineer adversarial review and threat model analysis.
* [`docs/SEMANTIC_GUARD.md`](docs/SEMANTIC_GUARD.md): TypeScript AST static analysis and concurrent conflict attribution engine.
* [`docs/RECOVERY.md`](docs/RECOVERY.md): Persistence, log compaction, historical replay, and recovery contract.
* [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md): Hierarchical CRDT workspace representation and cycle-breaking invariants.
* [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md): Candid technical debt, trade-offs, and operational boundaries.
* [`SECURITY.md`](SECURITY.md): Threat model, security boundaries, and vulnerability disclosure policy.

---

## 📄 License

MIT © [Akash Patil](https://github.com/akashcodes23)