# ⚡ Converge

> **A local-first collaborative development environment exploring conflict-free replicated data types (CRDTs), fault-tolerant synchronization, durable operation history, time-travel debugging, and distributed-systems observability.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org/)
[![Yjs](https://img.shields.io/badge/CRDT-Yjs-orange.svg)](https://yjs.dev/)
[![Monaco](https://img.shields.io/badge/Editor-Monaco-brightgreen.svg)](https://microsoft.github.io/monaco-editor/)
[![PostgreSQL](https://img.shields.io/badge/Storage-PostgreSQL%20%2B%20LevelDB-blueviolet.svg)](https://www.postgresql.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 🌟 Overview

**Converge** is an industry-grade collaborative development platform designed to tackle real distributed systems challenges:
- **Strong Eventual Consistency (SEC)**: Guarantees that concurrent edits across disconnected peers converge deterministically to the identical state without centralized lock contention.
- **Differential State Synchronization**: Empirically measured to reduce wire payloads by **97.28% to 99.94%** relative to naive full-state broadcasts by exchanging binary State Vectors and incremental update diffs.
- **Hybrid Logical Clocks (HLC)**: Implements strictly monotonic, lexically sortable Lamport clocks preserving causal ordering across NTP clock skews.
- **Hierarchical CRDT Workspace**: Cycle-safe collaborative file and folder explorer with immutable UUID document identity, preventing orphan islands under concurrent moves.
- **Deterministic Time-Travel History**: Point-in-time document reconstruction by replaying append-only binary operations stored in PostgreSQL stamped with HLC timestamps.
- **Network Partition & Chaos Simulation**: Built-in split-brain testing mechanism with real-time diverged character tracking and linear diff merge-flash animations.

---

## 🏗️ Architecture

```
                                  ┌────────────────────────┐
                                  │   Next.js Client A     │
                                  │   (Monaco + Y.Doc)     │
                                  │      (IndexedDB)       │
                                  └───────────┬────────────┘
                                              │ WebSocket
                                              ▼
┌──────────────────────┐          ┌────────────────────────┐
│  PostgreSQL Storage  │◄─────────┤  Node.js WS Server     │
│  (Append-Only HLC)   │  Stream  │  (Custom Wire Protocol)│
└──────────────────────┘          └───────────┬────────────┘
                                              │ LevelDB Cache
                                              ▼
                                  ┌────────────────────────┐
                                  │   Next.js Client B     │
                                  │   (Monaco + Y.Doc)     │
                                  │      (IndexedDB)       │
                                  └────────────────────────┘
```

---

## 🚀 Key Features

### 1. Multi-File Collaborative Workspace
* **Hierarchical File Tree**: Full folder and file lifecycle (creation, deletion, in-place renaming, folder reparenting).
* **Cycle Prevention**: Topological sanitizer breaks cyclic parent loops to root if peers execute simultaneous cross-moves.
* **Dynamic Monaco Models**: Switching tabs switches Monaco text models and language modes (`typescript`, `javascript`, `python`, `json`, `markdown`) without resetting undo history or cursor position.

### 2. Dual-Tier Persistence & Fast Recovery
* **PostgreSQL (Audit & Time-Travel)**: Stores every atomic binary operation as `BYTEA` stamped with a Hybrid Logical Clock (`<time36>-<counter36>-<nodeId>`).
* **LevelDB (Hot Room Recovery)**: Embedded in-process key-value store using `y-leveldb` for rapid state restoration on room initialization.
* **Snapshot Compaction**: Folds historical operation streams into compacted binary snapshots, reducing cold recovery latency by **3.75x** (0.20 ms vs 0.76 ms).
* **IndexedDB (Browser Offline-First)**: Persists document state locally in the user's browser, enabling offline editing with automatic reconciliation on reconnect.

### 3. Distributed Chaos Lab & Telemetry
* **Chaos Mode**: Simulates sudden network partitions with a 30-second countdown.
* **Telemetry HUD**: Live inspection of Lamport Vector Clocks and byte-level comparison of delta sync vs full state reload.
* **Merge Flash**: Visual highlight highlighting reconciled ranges when disconnected peers merge back into the swarm.

---

## 📊 Measured Performance Benchmarks

All metrics represent real measurements executed on Apple Silicon (`darwin arm64`, Node.js `v22.23.1`). Full methodology and percentile distributions documented in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

### 1. Wire Payload Reduction (Full vs. Differential Sync)
| Workload | Document Size | Full State Payload | Differential Diff | Measured Payload Reduction |
| :--- | :--- | :--- | :--- | :--- |
| **Small Document (~25 lines)** | 1,672 characters | 1,690 bytes | 46 bytes | **97.28%** |
| **Medium Document (~250 lines)** | 17,197 characters | 17,216 bytes | 48 bytes | **99.72%** |
| **Large Document (~1,200 lines)** | 84,297 characters | 84,316 bytes | 48 bytes | **99.94%** |

### 2. Micro-Operation Latency & Database Performance
| Metric | Measured Result |
| :--- | :--- |
| **In-Memory CRDT Sync Latency (Median)** | **14.12 µs** (Mean: 37.97 µs, P90: 39.46 µs) |
| **Cold Recovery Speedup (Snapshot vs Replay)** | **3.75x faster** (Median: 0.20 ms vs 0.76 ms) |
| **Storage Compaction Ratio** | **75.62% reduction** (7,456 bytes $\to$ 1,818 bytes) |
| **PostgreSQL Single-Row Write Latency** | **0.29 ms** (P50: 0.20 ms, P95: 0.48 ms) |
| **50-Replica In-Memory Swarm Convergence** | **13.13 ms** across 50 in-memory peer replicas |

---

## 🛠️ Getting Started

### Prerequisites
* **Node.js** >= 18
* **pnpm** >= 8
* **Docker** or native **PostgreSQL 15**

### 1. Clone & Install
```bash
git clone https://github.com/akashcodes23/crdt-editor-core.git
cd crdt-editor-core
pnpm install
```

### 2. Start PostgreSQL
```bash
docker compose up -d
```

### 3. Run Development Environment
```bash
pnpm dev
```
* **Frontend**: [http://localhost:3000](http://localhost:3000)
* **WebSocket / HTTP Server**: `http://localhost:1234` (`ws://localhost:1234`)

### 4. Run Convergence Tests
```bash
pnpm test
```

### 5. Run Performance Benchmarks
```bash
pnpm benchmark
```

---

## 🧪 Testing Standard

Run the formal verification suite (31 unit & integration tests):

```bash
pnpm --filter server test
```

```
PASS src/__tests__/compaction-races-and-recovery.test.ts
PASS src/__tests__/hlc-semantics.test.ts
PASS src/__tests__/distributed-correctness.test.ts
PASS src/__tests__/workspace-invariants.test.ts
PASS src/__tests__/hlc-and-recovery.test.ts
PASS src/__tests__/crdt-convergence.test.ts

Test Suites: 6 passed, 6 total
Tests:       31 passed, 31 total
Snapshots:   0 total
Time:        0.633 s
```

---

## 📚 Technical Documentation

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): Distributed systems design, wire protocols, and recovery pipeline.
* [`docs/RECOVERY.md`](docs/RECOVERY.md): Persistence, compaction, historical replay, and recovery contract.
* [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md): Reproducible performance measurements, methodology, and hardware specification.
* [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md): CRDT workspace tree representation, cycle-breaking invariants, and concurrency policies.
* [`docs/ENGINEERING_ROADMAP.md`](docs/ENGINEERING_ROADMAP.md): Technical roadmap across all phases.
* [`docs/TESTING_STRATEGY.md`](docs/TESTING_STRATEGY.md): Invariant specifications and verification criteria.
* [`docs/KNOWN_LIMITATIONS.md`](docs/KNOWN_LIMITATIONS.md): Candid technical debt and architectural trade-offs.
* [`SECURITY.md`](SECURITY.md): Threat model, security boundaries, and disclosure policy.

---

## 📄 License

MIT © [Akash Patil](https://github.com/akashcodes23)
