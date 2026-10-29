# Converge: Performance, Scalability & Recovery Benchmarks

This document details the empirical, reproducible benchmark suites for Converge. All metrics represent real measurements executed on Apple Silicon (`darwin arm64`, Node.js `v22.23.1`) against a local PostgreSQL 15 instance.

---

## 1. Measurement Standards & Test Environment

* **Hardware Architecture**: Apple Silicon (M-series, `arm64`)
* **Host Operating System**: macOS Darwin `24.6.0`
* **Node.js Runtime**: `v22.23.1`
* **Storage Engine**: PostgreSQL 15 (UNIX domain socket & TCP `localhost:5432`)
* **Embedded Cache**: LevelDB (`y-leveldb` / `leveldown`)
* **Timing Mechanism**: `perf_hooks.performance.now()` (high-resolution sub-millisecond timer)
* **Warmup Protocol**: JIT warm-up cycles (minimum 5 unmeasured runs) preceding timed statistical sampling.
* **Separation of Concerns**: In-memory micro-operation timings are strictly isolated and reported separately from network round-trip time (RTT) and disk transaction commits.

---

## 2. Core Differential Synchronization Benchmarks (`pnpm benchmark`)

### Benchmark 1: Full-State vs. Differential Synchronization Wire Payload
* **Measured Operation**: Compares the raw byte payload transmitted across the wire when synchronizing an incremental edit using naive full-document state broadcasts vs. Converge differential State Vectors (`y-protocols/sync`).
* **Network Latency**: Excluded (measures byte length of serialized binary protocol payloads).
* **Database Commit**: Excluded (pure CRDT serialization).
* **Workload Characteristics**: A client with an existing synchronized baseline document receives a single-line incremental mutation (typical keystroke insertion).
* **Sample Size**: 3 document scales (Small: 25 lines / ~1.6 KB; Medium: 250 lines / ~17 KB; Large: 1,200 lines / ~84 KB).

| Workload | Document Size | Naive Full State Payload | Converge Differential Diff | Measured Payload Reduction |
| :--- | :--- | :--- | :--- | :--- |
| **Small Document (~25 lines)** | 1,672 characters | 1,690 bytes | **46 bytes** | **97.28%** |
| **Medium Document (~250 lines)** | 17,197 characters | 17,216 bytes | **48 bytes** | **99.72%** |
| **Large Document (~1,200 lines)** | 84,297 characters | 84,316 bytes | **48 bytes** | **99.94%** |

> **Analysis**: Full-state broadcasts scale linearly $O(N)$ with document size. Differential state vector synchronization scales strictly with the edit delta $O(\Delta)$ (~46–48 bytes per atomic edit), yielding a **97.28% to 99.94% reduction** in network bandwidth on incremental typing.

---

### Benchmark 2: In-Memory CRDT Micro-Operation Synchronization Latency
* **Measured Operation**: Binary delta encoding (`Y.encodeStateAsUpdate`) and integration (`Y.applyUpdate`) between two in-memory document replicas within the same V8 isolate.
* **Network Latency**: **EXCLUDED**. This is a micro-benchmark measuring raw V8 memory manipulation. It does not reflect WebSocket network RTT or TCP ACK latency.
* **Database Commit**: **EXCLUDED**. Does not touch PostgreSQL or LevelDB.
* **Workload Characteristics**: 500 sequential character insertions exchanged between two in-memory `Y.Doc` instances.
* **Iterations & Statistics**: $N = 500$ iterations.

| Metric | Measured Duration |
| :--- | :--- |
| **Median (P50)** | **15.67 µs** (0.0157 ms) |
| **Mean Latency** | **25.03 µs** (0.0250 ms) |
| **90th Percentile (P90)** | **44.62 µs** (0.0446 ms) |
| **99th Percentile (P99)** | **117.21 µs** (0.1172 ms) |
| **Max Observed Latency** | **373.92 µs** (0.3739 ms) |

> **Nuance & Limitations**: Micro-operation latency represents the computational overhead of the CRDT algorithm itself. Real end-to-end user perceived latency includes input device event dispatch (~4 ms), browser layout/paint (~8–16 ms), and network transit time.

---

### Benchmark 3: Snapshot Creation Duration & Storage Compaction Ratio
* **Measured Operation**: Compression of historical operation streams into an atomic binary snapshot via `Y.encodeStateAsUpdate(doc)`.
* **Network Latency**: Excluded.
* **Database Commit**: Excluded (in-memory compression duration).
* **Workload Characteristics**: 300 sequential incremental edits recorded in operation log.

| Metric | Measured Result |
| :--- | :--- |
| **Incremental Updates** | 300 individual operations |
| **Uncompacted Log Size** | 7,456 bytes |
| **Compacted Snapshot Size** | 1,818 bytes |
| **Storage Footprint Reduction** | **75.62% compaction** |
| **Snapshot Generation Duration**| **0.038 ms** |

---

### Benchmark 4: Cold Document Recovery Latency (Replay vs. Snapshot + Tail)
* **Measured Operation**: Total CPU time required to restore a document from storage into an in-memory `Y.Doc`.
* **Network Latency**: Excluded.
* **Database Commit**: Reads simulated operations from memory structures.
* **Workload Characteristics**: 400 total operations. Method A replays all 400 incremental operations sequentially. Method B loads a compacted snapshot taken at operation 300, then replays only the 100 subsequent tail operations.
* **Sampling**: 30 measured trials following 5 unmeasured warmup trials.

| Recovery Method | Mean Latency | Median (P50) | 95th Percentile (P95) |
| :--- | :--- | :--- | :--- |
| **Method A: Full Log Replay (400 ops)** | 1.702 ms | 1.442 ms | 3.424 ms |
| **Method B: Snapshot + Tail (100 ops)** | **0.245 ms** | **0.226 ms** | **0.328 ms** |

> **Result**: Snapshot checkpointing reduces recovery latency by **6.38x** (P50: 0.226 ms vs 1.442 ms), directly proportional to the reduction in CRDT item structures traversed during deserialization.

---

### Benchmark 5: PostgreSQL Single-Row Write Latency
* **Measured Operation**: Real database transactional insert appending an immutable CRDT update stamped with a Hybrid Logical Clock into PostgreSQL:
  `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, $2, $3, $4)`.
* **Network Latency**: Local loopback TCP connection to PostgreSQL port 5432.
* **Database Commit**: **INCLUDED**. Measures PostgreSQL query execution and WAL append.
* **Workload Characteristics**: 50 consecutive transactional inserts using `pg.Pool`.

| Metric | Measured Duration |
| :--- | :--- |
| **Median (P50)** | **0.27 ms** |
| **Mean Latency** | **0.27 ms** |
| **95th Percentile (P95)** | **0.46 ms** |
| **Max Observed Latency** | **0.98 ms** |

---

### Benchmark 6: Convergence Under Injected Artificial Latency & Jitter
* **Measured Operation**: Time for two partitioned peers to achieve exact mathematical state convergence when network partitions heal across injected one-way network delays.
* **Network Latency**: Injected synthetic delay (0 ms, 25 ms, 50 ms, 100 ms).
* **Database Commit**: Excluded.
* **Workload Characteristics**: 5 concurrent divergent insertions per peer during partition; synchronized upon reconnect.

| Injected One-Way Delay | Measured Convergence Time | Converged State Equality |
| :--- | :--- | :---: |
| **0 ms** | 0.12 ms | **PASSED (exact match)** |
| **25 ms** | 26.01 ms | **PASSED (exact match)** |
| **50 ms** | 50.22 ms | **PASSED (exact match)** |
| **100 ms** | 101.30 ms | **PASSED (exact match)** |

---

### Benchmark 7: Peer Swarm Scalability (2 to 50 Concurrent Replicas)
* **Measured Operation**: Simultaneous multi-peer cross-synchronization time and heap memory overhead in a star topology.
* **Network Latency**: Excluded (in-memory star network simulation).
* **Database Commit**: Excluded.
* **Workload Characteristics**: Each peer generates an independent edit; all edits are fanned out and integrated across all $N$ replicas.

| Replica Count | Convergence Time | Heap Allocation Delta | All Replicas Converged |
| :--- | :--- | :--- | :---: |
| **2 Replicas** | 0.34 ms | 0.082 MB | **TRUE** |
| **5 Replicas** | 0.64 ms | 0.280 MB | **TRUE** |
| **10 Replicas** | 1.59 ms | 0.730 MB | **TRUE** |
| **25 Replicas** | 4.66 ms | 2.889 MB | **TRUE** |
| **50 Replicas** | 11.52 ms | 1.425 MB | **TRUE** |

---

## 3. Distributed Recovery & Fault-Injection Benchmarks (`pnpm benchmark:recovery`)

* **Execution Command**: `pnpm benchmark:recovery`
* **Measured Operation**: Real PostgreSQL database recovery evaluating cold startup times across 3 operational states:
  - **Mode A: Full Replay**: Reconstructs state from zero by replaying raw operation rows from `operations`.
  - **Mode B: Compacted**: Loads checkpoint snapshot from `doc_snapshots`, then replays only subsequent uncompacted operations (80% compaction cutoff).
  - **Mode C: Interrupted Compaction Rollback**: Simulates a crash midway through compaction where the snapshot was rolled back in PostgreSQL, forcing fallback to uncompacted operation replay.
* **Network Latency**: Local database connection.
* **Database Commit**: **INCLUDED**. Queries live PostgreSQL tables and verifies byte-for-byte CRDT state equality.
* **Sampling**: 50 trials per mode following 5 warmup cycles.

### Workload S (100 Total Operations)
* Operation log pruned: 101 $\to$ 21 operations (79.2% operation reduction).

| Mode | Ops Replayed | Mean | Median (P50) | P95 | Verification |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Mode A: Full Replay** | 101 | 0.66 ms | 0.58 ms | 1.26 ms | **PASSED (exact match)** |
| **Mode B: Compacted (Snapshot + Tail)** | 21 | 0.33 ms | **0.30 ms** | 0.57 ms | **PASSED (exact match)** |
| **Mode C: Interrupted Rollback** | 101 | 0.47 ms | 0.45 ms | 0.56 ms | **PASSED (exact match)** |

> **Speedup Factor**: **1.93x faster restoration** (0.30 ms vs 0.58 ms).

### Workload M (500 Total Operations)
* Operation log pruned: 501 $\to$ 101 operations (79.8% operation reduction).

| Mode | Ops Replayed | Mean | Median (P50) | P95 | Verification |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Mode A: Full Replay** | 501 | 1.40 ms | 1.38 ms | 1.64 ms | **PASSED (exact match)** |
| **Mode B: Compacted (Snapshot + Tail)** | 101 | 0.49 ms | **0.48 ms** | 0.61 ms | **PASSED (exact match)** |
| **Mode C: Interrupted Rollback** | 501 | 1.49 ms | 1.47 ms | 1.68 ms | **PASSED (exact match)** |

> **Speedup Factor**: **2.88x faster restoration** (0.48 ms vs 1.38 ms).

### Workload L (1,000 Total Operations)
* Operation log pruned: 1,001 $\to$ 201 operations (79.9% operation reduction).

| Mode | Ops Replayed | Mean | Median (P50) | P95 | Verification |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Mode A: Full Replay** | 1,001 | 2.64 ms | 2.64 ms | 2.89 ms | **PASSED (exact match)** |
| **Mode B: Compacted (Snapshot + Tail)** | 201 | 0.81 ms | **0.79 ms** | 0.96 ms | **PASSED (exact match)** |
| **Mode C: Interrupted Rollback** | 1,001 | 3.80 ms | 3.71 ms | 5.50 ms | **PASSED (exact match)** |

> **Speedup Factor**: **3.33x faster restoration** (0.79 ms vs 2.64 ms).

---

## 4. Semantic Guard AST Worker Benchmarks (`pnpm benchmark:semantic-guard`)

* **Execution Command**: `pnpm benchmark:semantic-guard`
* **Measured Operation**: TypeScript compiler AST parsing, diagnostic extraction, symbol conflict attribution, and debounced scheduler throughput.
* **Network Latency**: Excluded (worker thread / in-process analysis).
* **Database Commit**: Excluded.

### Benchmark 1: Compiler Cold Start vs. Incremental Analysis Duration
* Compares cold-start invocation of TypeScript language services against 30 warm incremental executions.

| Workload | Lines | File Size | Cold Start | Incremental Mean | Incremental P50 | Incremental P95 | Execution Context |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Small File** | 25 | 1.5 KB | 29.44 ms | 2.68 ms | **2.18 ms** | 5.79 ms | Worker Thread / Non-Blocking |
| **Medium File**| 250 | 14.2 KB | 6.14 ms | 5.31 ms | **5.37 ms** | 8.99 ms | Worker Thread / Non-Blocking |
| **Large File** | 1,200 | 68.8 KB | 14.73 ms | 12.47 ms | **12.19 ms** | 13.43 ms | Worker Thread / Non-Blocking |

### Benchmark 2: Multi-File Cross-File Workspace Analysis Cost
* Evaluates compiler resolution cost across a 10-file collaborative workspace with cross-file imports (`import { VectorClock } from './vectorClock'`).
* **Sampling**: 20 iterations.
* **Median (P50)**: **2.04 ms**
* **95th Percentile (P95)**: **5.37 ms**

### Benchmark 3: Burst Typing Debounce & Redundant Compilation Avoidance
* Simulates rapid user typing (10 keystrokes executed in quick succession within a 50 ms burst window).
* Default editor scheduler debounce: **200 ms**.

| Metric | Result |
| :--- | :--- |
| **Keystrokes Simulated** | 10 rapid keystrokes |
| **Delivered Final Analysis** | 1 comprehensive analysis |
| **Actual Compiler Executions** | 1 execution |
| **Superseded / Avoided Compilations** | **9 (90.0% verified reduction)** |

> **Engineering Impact**: Keystroke debounce prevents CPU starvation by suppressing intermediate compilation jobs, ensuring high-frequency typing does not block the UI or consume excessive background thread CPU cycles.

---

## 5. How to Reproduce All Benchmarks Locally

Ensure PostgreSQL is running on `localhost:5432`, then run:

```bash
# 1. Core differential sync, micro-op, and swarm benchmarks
pnpm benchmark

# 2. Database snapshot compaction & recovery benchmarks
pnpm benchmark:recovery

# 3. Semantic Guard AST analysis & debounce benchmarks
pnpm benchmark:semantic-guard
```