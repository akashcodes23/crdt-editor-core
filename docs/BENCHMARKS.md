# Converge: Performance & Scalability Benchmarks (Audited)

This document contains empirical, reproducible benchmark measurements for the Converge collaborative core. 

---

## 1. Test Environment & Measurement Standards

* **Platform**: Apple Silicon (`darwin arm64`)
* **Node.js Runtime**: `v22.23.1`
* **Package Manager**: `pnpm 12.15.0`
* **Database**: PostgreSQL 15 (Local UNIX domain socket connection)
* **Measurement API**: High-resolution timer (`perf_hooks.performance.now()`)
* **Warmup Protocol**: JIT compilation warm-up cycles (5 unmeasured runs) preceding timed trials.
* **Execution Command**: `pnpm benchmark`

---

## 2. Empirical Benchmark Measurements

### Benchmark 1: Full-State vs. Differential Synchronization Wire Payload
* **Scope**: Evaluates the network wire payload comparison between retransmitting the full document state vs. transmitting a State-Vector differential update (`y-protocols/sync`).
* **Workload**: Client maintains a synchronized baseline document. Server appends a single incremental line edit (typical user keystroke), and computes the required wire transmission.
* **Limitations**: Excludes WebSocket RFC 6455 framing (2–10 bytes) and initial document join payload. Applies specifically to incremental edits on an already-synchronized session.

| Workload | Document Size | Naive Full State Payload | Converge Differential Diff | Measured Payload Reduction |
| :--- | :--- | :--- | :--- | :--- |
| **Small Document (~25 lines)** | 1,672 characters | 1,690 bytes | **46 bytes** | **97.28%** |
| **Medium Document (~250 lines)** | 17,197 characters | 17,216 bytes | **48 bytes** | **99.72%** |
| **Large Document (~1,200 lines)** | 84,297 characters | 84,316 bytes | **48 bytes** | **99.94%** |

> **Audit Analysis**: Full-state broadcasts scale linearly $O(N)$ with document size. Differential updates scale strictly with the edit delta $O(\Delta)$ (46–48 bytes per line edit), yielding a **97.28% to 99.94% wire payload reduction** on incremental edits.

---

### Benchmark 2: In-Memory CRDT Micro-Operation Synchronization Latency
* **Scope**: Measures in-memory binary delta encoding (`encodeStateAsUpdate`) and remote replica integration (`applyUpdate`) within the same V8 isolate.
* **Workload**: $N = 500$ sequential character edits exchanged between two in-memory `Y.Doc` instances.
* **Limitations**: Does NOT include WebSocket network transmission, TCP ACKs, or cross-machine network latency.

| Metric | Measured Duration |
| :--- | :--- |
| **Median (P50)** | **14.12 µs** (0.0141 ms) |
| **Mean Latency** | **37.97 µs** (0.0380 ms) |
| **90th Percentile (P90)** | **39.46 µs** (0.0395 ms) |
| **99th Percentile (P99)** | **674.83 µs** (0.6748 ms) |
| **Max Observed Latency** | **3.00 ms** (V8 GC pause event) |

---

### Benchmark 3: Snapshot Creation Duration & Log Compaction Ratio
* **Scope**: Evaluates storage compaction ratio when folding historical incremental binary operations into an atomic document snapshot.
* **Workload**: 300 sequential character insertions recorded in operation log.

| Metric | Measured Value |
| :--- | :--- |
| **Incremental Updates** | 300 individual operations |
| **Uncompacted Log Size** | 7,456 bytes |
| **Compacted Snapshot Size** | 1,818 bytes |
| **Storage Footprint Reduction** | **75.62% compaction** |
| **Snapshot Generation Duration**| **0.086 ms** |

---

### Benchmark 4: Cold Document Recovery Latency (Full Replay vs. Snapshot + Tail)
* **Scope**: Compares document reconstruction latency when replaying from raw append-only operation log vs. restoring from a checkpoint snapshot + tail delta operations.
* **Workload**: 400 total operations. Method A replays all 400 operations. Method B applies a snapshot taken at operation 300, then replays only the 100 subsequent tail operations.
* **Measurement Protocol**: 30 trials measured after 5 unmeasured JIT warm-up cycles.

| Recovery Method | Mean Latency | Median (P50) | 95th Percentile (P95) |
| :--- | :--- | :--- | :--- |
| **Method A: Full Log Replay (400 ops)** | 0.835 ms | 0.761 ms | 1.062 ms |
| **Method B: Snapshot + Tail (100 ops)** | **0.212 ms** | **0.203 ms** | **0.314 ms** |

> **Audit Analysis**: Restoring from a compacted snapshot reduces median recovery duration from 0.761 ms to 0.203 ms (**3.75x speedup**), directly proportional to the 4x reduction in applied CRDT item structures.

---

### Benchmark 5: PostgreSQL Operation Append Latency
* **Scope**: Transaction write latency when inserting immutable CRDT updates stamped with Hybrid Logical Clocks into PostgreSQL.
* **Workload**: 50 consecutive transactional inserts into `operations (doc_id, client_id, hlc_timestamp, update_blob)`.
* **Environment**: Local PostgreSQL connection pool (`pg.Pool`), default autocommit mode.

| Metric | Measured Duration |
| :--- | :--- |
| **Median (P50)** | **0.20 ms** |
| **Mean Write Latency** | **0.29 ms** |
| **95th Percentile (P95)** | **0.48 ms** |
| **Max Write Latency** | **2.00 ms** |

---

### Benchmark 6: Convergence Under Injected Artificial Latency & Jitter
* **Scope**: Validates deterministic eventual consistency across artificial round-trip network delays.
* **Workload**: Concurrent partition edits on two peers with injected delays (0ms, 25ms, 50ms, 100ms).

| Injected Delay | Measured Convergence Time | Convergence Equality Verified |
| :--- | :--- | :--- |
| **0 ms** | 0.10 ms | **TRUE** |
| **25 ms** | 26.19 ms | **TRUE** |
| **50 ms** | 51.17 ms | **TRUE** |
| **100 ms** | 101.38 ms | **TRUE** |

---

### Benchmark 7: Peer Swarm Scalability (2 to 50 Concurrent Replicas)
* **Scope**: Evaluates memory overhead and convergence time as the number of concurrent peer replicas in a room scales from 2 to 50 in a hub-and-spoke star topology within a single Node.js isolate.
* **Workload**: Each replica performs an independent concurrent edit; all edits are synchronized across the swarm.
* **Limitations**: Tests sequence CRDT state vector merge complexity; does NOT simulate network socket descriptors or OS buffer saturation.

| Replica Count | Convergence Time | Heap Allocation Delta | All Replicas Converged |
| :--- | :--- | :--- | :--- |
| **2 Replicas** | 0.47 ms | 0.082 MB | **TRUE** |
| **5 Replicas** | 1.33 ms | 0.282 MB | **TRUE** |
| **10 Replicas** | 2.49 ms | 0.716 MB | **TRUE** |
| **25 Replicas** | 6.26 ms | 2.875 MB | **TRUE** |
| **50 Replicas** | 13.13 ms | 1.485 MB | **TRUE** |

---

## 3. How to Reproduce

Run the automated benchmark suite from the root directory:

```bash
pnpm benchmark
```
