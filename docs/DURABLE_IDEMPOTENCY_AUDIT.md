# Converge: Durable Idempotency, Partial Persistence, & Crash Recovery Audit

**Audit Status:** Complete, Verified, & Enforced  
**Auditor Role:** Principal Distributed-Systems Engineer  
**Repository:** `akashcodes23/crdt-editor-core`  
**Date of Audit:** October 28, 2026  

---

## 1. Executive Summary & Audit Scope

This audit addresses critical distributed systems questions in Converge:
1. **Actual Execution Order**: Disentangling in-memory CRDT mutation, network broadcast, database transaction commit, and client acknowledgement.
2. **Authoritative Recovery Hierarchy**: Eliminating split-brain recovery by establishing PostgreSQL as the single canonical log, with deterministic LevelDB cache reconciliation during cold startup.
3. **Partial Persistence Handling**: Verifying behavior when one store succeeds while the other fails (or the server crashes between writes), ensuring failures are surfaced and retries deterministically complete storage repair.
4. **Restart-Safe & Concurrency-Safe Idempotency**: Replacing transient in-memory LRU caches with database-enforced uniqueness constraints in PostgreSQL (`durable_acks`), SHA-256 payload verification, and in-flight request serialization.
5. **Compaction Retention Independence**: Decoupling idempotency record retention from operation log pruning so retries after compaction remain recognized and safe.
6. **Client-Side Durability Semantics**: Implementing and verifying a production-grade client reference state machine distinguishing `pending`, `durable`, `failed`, and `unknown` states.

---

## 2. Phase 1: End-to-End Protocol Trace

An inspection of the actual working tree source code (`room.ts`, `persistence.ts`, `db.ts`, and `index.ts`) reveals the exact execution order of an update:

```
[1. Input Validation]
       │
       ▼
[2. Payload Hashing] ──> sha256(update)
       │
       ▼
[3. Deduplication Check]
       ├── In-Memory LRU Cache: if durable, verify hash; return cached ACK
       ├── PostgreSQL durable_acks Table: if durable, verify hash; return committed ACK
       └── In-Flight Promise Map: if identical update is currently executing, await it
       │
       ▼
[4. In-Memory CRDT Mutation] ──> Y.applyUpdate(room.doc, update, 'durable-apply')
       │
       ├─────────────────────────────────────────────┐
       ▼                                             ▼
[5. Immediate Peer Broadcast]                 [6. Dual Persistence Pipeline]
   MESSAGE_SYNC frame to all connected peers     a. PostgreSQL durable_acks upsert
   (excludes originating sender)                    ON CONFLICT DO UPDATE ... RETURNING (xmax=0)
                                                 b. PostgreSQL operations append
                                                    (Skipped if update_id already committed)
                                                 c. LevelDB persistence
                                                    storeUpdate(room.name, update)
                                                     │
                                                     ▼
                                              [7. Queue Serialization]
                                                 room.persistenceQueue serializes writes
                                                     │
                                                     ▼
                                              [8. Durable Acknowledgement]
                                                 Success: status=0 (durable), hlc, error=''
                                                 Failure: status=1 (failed), hlc='', error=reason
                                                     │
                                                     ▼
                                              [9. Client Retry & Deduplication]
                                                 Client re-sends same updateId on failure/timeout
```

### Exact Order Analysis

1. **Validation**: Lines 330-343 of `room.ts`. Validates frame decoding, non-empty `updateId` string, and binary payload length > 0.
2. **In-Memory Application**: Occurs at line 463 of `room.ts` **before** disk persistence, ensuring immediate peer broadcast without disk latency.
3. **Peer Broadcast**: Occurs at line 478 of `room.ts` **before** database persistence. If the disk write subsequently fails, peers have received the update in memory, but the originating client receives an explicit failure ACK.
4. **PostgreSQL Insertion & Commit**: Occurs at lines 494-517 of `room.ts`. Upserts into `durable_acks` and appends to `operations`.
5. **LevelDB Write**: Occurs at line 520 of `room.ts`.
6. **Durable Acknowledgement**: Occurs at lines 538-558 of `room.ts` **only after** both PostgreSQL and LevelDB writes complete.
7. **Client Retry & Deduplication**: If an acknowledgement is lost or a partial failure occurred, the client re-submits with the same `updateId`. The server verifies the SHA-256 hash, repairs any incomplete storage operations, and returns the committed HLC.

---

## 3. Phase 2: Single Authoritative Recovery Policy

### Canonical Durable Authority: PostgreSQL

* **The Problem**: Previously, cold-room startup (`getRoom`) loaded exclusively from LevelDB via `persistence.bindState`. If PostgreSQL had committed an update that LevelDB missed (e.g. disk failure or server crash between writes), cold startup silently trusted the stale LevelDB state.
* **The Policy**: **PostgreSQL is the single canonical source of truth for durable state.** LevelDB serves as an embedded working-state cache.

### Deterministic Cold-Room Reconciliation Algorithm

On cold room initialization (`getRoom` in `packages/server/src/room.ts`):

```typescript
// 1. Load working state from LevelDB
await getPersistence().bindState(name, doc)

// 2. Authoritative PostgreSQL Reconciliation
const snapshotRes = await dbPool.query(
  `SELECT snapshot_blob, hlc_cutoff FROM doc_snapshots 
   WHERE doc_id = $1 ORDER BY hlc_cutoff DESC, id DESC LIMIT 1`,
  [name]
)
let afterHlc = '0'
if (snapshotRes.rows.length > 0) {
  Y.applyUpdate(doc, snapshotRes.rows[0].snapshot_blob, 'postgres-reconcile')
  afterHlc = snapshotRes.rows[0].hlc_cutoff
}

// Replay all operations strictly after snapshot cutoff
const opsRes = await dbPool.query(
  `SELECT update_blob, hlc_timestamp FROM operations 
   WHERE doc_id = $1 AND hlc_timestamp > $2 ORDER BY hlc_timestamp ASC, id ASC`,
  [name, afterHlc]
)
for (const row of opsRes.rows) {
  Y.applyUpdate(doc, row.update_blob, 'postgres-reconcile')
}

// 3. LevelDB Repair Synchronization
const reconciledUpdate = Y.encodeStateAsUpdate(doc)
if (reconciledUpdate.byteLength > 2) {
  await getPersistence().storeUpdate(name, reconciledUpdate)
}
```

### Deterministic Guarantees
1. **No Stale Trust**: Cold-room startup merges all committed PostgreSQL snapshots and operations into `room.doc`.
2. **Zero Lost Updates**: Because CRDT merges are commutative ($A \cup B = B \cup A$) and idempotent ($A \cup A = A$), applying PostgreSQL operations over LevelDB state reconciles both stores with mathematical precision.
3. **Automatic Cache Repair**: LevelDB is immediately backfilled with the complete merged update, repairing local disk caches automatically.

---

## 4. Phase 3: Partial Persistence Analysis & Fault Injection

The fault-injection integration suite ([durability-fault-injection.test.ts](file:///Users/akashgpatil/crdt-editor-core/packages/server/src/__tests__/durability-fault-injection.test.ts)) was expanded to verify all partial persistence and recovery modes:

| Scenario | Injected Condition | Expected Behavior | Verification |
| :---: | :--- | :--- | :---: |
| **Postgres Succeeds, LevelDB Fails** (Scen 17) | LevelDB `storeUpdate` throws `EIO: Disk error` | Server records operation in PostgreSQL, returns `status: failed (LEVELDB_FAILED)`. On client retry, LevelDB write succeeds and server confirms `status: durable`. Cold reload verifies document matches. | **PASS (7 ms)** |
| **LevelDB Succeeds, Postgres Fails** (Scen 3 & 9) | PostgreSQL connection refused or constraint violation | Server returns `status: failed`. Client retries when DB recovers; update committed to PostgreSQL and confirmed. | **PASS (5 ms)** |
| **Both Succeed, ACK Lost** (Scen 4) | Server completes persistence; response dropped in transit | Client retry timer fires; server checks `durable_acks`, returns committed HLC. Zero duplicate rows in `operations`. | **PASS (206 ms)** |
| **Crash Between Writes** (Scen 18) | PostgreSQL commits write, server killed before LevelDB write | Cold room starts; reconciliation reloads PostgreSQL operations, repairs LevelDB cache. Reconstructed document exact match. | **PASS (3 ms)** |
| **Divergent Store Reconciliation** (Scen 11) | LevelDB missing tail operations committed in PostgreSQL | Snapshot + tail query deterministic replay reconstructs exact document state. | **PASS (2 ms)** |
| **Retry After Process Restart** (Scen 14) | Client commits update; server restarted; in-memory cache wiped | Client retries; server queries PostgreSQL `durable_acks`, verifies hash, returns committed HLC. | **PASS (9 ms)** |
| **Compaction Before Retry** (Scen 15) | Operation pruned from `operations` by compaction before retry | `durable_acks` record survives; server returns original committed HLC without re-inserting pruned row. | **PASS (7 ms)** |
| **Payload Collision Rejection** (Scen 16) | Client reuses `updateId` with different payload bytes | SHA-256 hash mismatch detected; server rejects with `UPDATE_ID_PAYLOAD_MISMATCH`. | **PASS (3 ms)** |

---

## 5. Phase 4: Restart-Safe & Concurrency-Safe Idempotency

### Schema Enhancement in `db.ts`

```sql
CREATE TABLE IF NOT EXISTS durable_acks (
  doc_id        TEXT NOT NULL,
  update_id     TEXT NOT NULL,
  status        TEXT NOT NULL, -- 'durable' or 'failed'
  hlc_timestamp TEXT,
  payload_hash  TEXT NOT NULL, -- SHA-256 hash of binary update
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (doc_id, update_id)
);

ALTER TABLE operations ADD COLUMN IF NOT EXISTS update_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ops_doc_update_id ON operations(doc_id, update_id);
```

### Concurrency & Collision Defenses
1. **Concurrent Duplicate Submissions (Scenario 13)**:
   - When multiple concurrent clients or network retries submit identical `(doc_id, update_id)` concurrently:
   - `room.inFlightUpdates` serializes execution in Node.js memory.
   - In PostgreSQL, `INSERT INTO durable_acks ... ON CONFLICT (doc_id, update_id) DO UPDATE ... RETURNING (xmax = 0) AS inserted` ensures only the winning transaction appends to `operations`.
   - **Result**: Exactly 1 row in `operations`. Both requests receive durable ACKs with the identical HLC timestamp.
2. **Payload Hash Verification**:
   - `sha256(update)` is computed on arrival.
   - Any attempt to reuse an existing `updateId` with modified CRDT bytes is rejected with `UPDATE_ID_PAYLOAD_MISMATCH`, preventing update forgery or accidental ID collisions.
3. **Retry of Failed Updates**:
   - A previously failed attempt (e.g. LevelDB disk I/O error) records `status: 'failed'`.
   - On retry, the server recognizes the failure, completes the missing storage write, and upgrades the record to `status: 'durable'`.

---

## 6. Phase 5: Client Acknowledgement Semantics & UI Limitations

### Reference Client State Machine ([DurableSyncClient](file:///Users/akashgpatil/crdt-editor-core/packages/client/src/lib/durable-client.ts))

The reference client implements the full 4-state durability contract:
* **`pending`**: Update submitted to WebSocket transport; awaiting durable confirmation.
* **`durable`**: Server confirmed persistence in PostgreSQL and LevelDB; assigned monotonic `hlc`.
* **`failed`**: Server rejected with explicit error reason (retryable).
* **`unknown`**: Network connection terminated while update was pending.

### Key Client Invariants
1. **No Local Edit Discard**: On connection drop or server failure, local edits are **never discarded**. They remain preserved in local memory and IndexedDB.
2. **Update ID Re-use**: Retries explicitly reuse the original `updateId`, enabling server-side deduplication.
3. **Sequential Independence**: Updates are tracked independently. A server acknowledgement for an older update **cannot** mark a newer pending update as saved.

> [!IMPORTANT]
> **Client UI Status Limitation**:  
> The current Next.js collaborative editor component ([useYDoc.ts](file:///Users/akashgpatil/crdt-editor-core/packages/client/src/hooks/useYDoc.ts)) connects using `y-websocket`'s standard provider for real-time synchronization.  
> It does not yet expose a visual "Saved / Unsaved Changes" status indicator in Monaco.  
> The complete 4-state durability protocol is implemented in the production reference `DurableSyncClient` module and verified by Scenario 19 in `durability-fault-injection.test.ts`.

---

## 7. Phase 6: Compaction Interaction & Retention Policy

1. **Snapshot-Plus-Tail Invariant**:
   Recovery of document state $S$ at cutoff $T_{cutoff}$ is guaranteed by:
   $$S = \text{apply}(\text{Snapshot}(T_{cutoff}), \bigcup \{ U_i \mid HLC(U_i) > T_{cutoff} \})$$
2. **Independent Retention Policy**:
   - Compaction (`POST /doc/:id/compact`) commits a consolidated snapshot to `doc_snapshots` and prunes `operations WHERE hlc_timestamp <= cutoff`.
   - **`durable_acks` is independent of `operations` pruning**.
   - Pruning operations does not delete `durable_acks`.
   - As verified in **Scenario 15**, a client retry arriving after compaction successfully retrieves its committed status from `durable_acks` without re-inserting pruned operations into the database.
3. **Process-Local Locking Scope**:
   - `compactionLocks: Set<string>` in `packages/server/src/room.ts` serializes compactions within a single Node.js process.
   - For multi-node deployments, cross-instance mutual exclusion requires PostgreSQL advisory locks (`pg_try_advisory_xact_lock`).

---

## 8. Phase 7: Verification Results

All verification commands were executed directly on the repository tree:

### 1. Type Checking
```bash
$ pnpm typecheck
Exit code: 0
Output:
$ pnpm --filter server typecheck && pnpm --filter client typecheck
$ tsc --noEmit
$ tsc --noEmit
```

### 2. Full Test Suite (10 Suites, 116 Tests)
```bash
$ pnpm test
Exit code: 0
Output:
Test Suites: 10 passed, 10 total
Tests:       116 passed, 116 total
Snapshots:   0 total
Time:        4.44 s
```

### 3. Production Build
```bash
$ pnpm build
Exit code: 0
Output: Next.js 15.5.14 optimized production build complete (5 static routes)
```

### 4. Distributed Benchmark
```bash
$ pnpm --filter server benchmark
Exit code: 0
Key Metrics:
- Full vs differential payload reduction: 97.28% - 99.94%
- Micro-operation sync latency: 15.10 µs mean, 12.17 µs median
- Storage compaction footprint reduction: 75.62%
- Snapshot recovery speedup factor: 3.76x
- PostgreSQL insert latency: 0.32 ms mean, 0.29 ms median
- Peer swarm scalability: 50 replicas converged in 13.74 ms
```

### 5. Recovery Benchmark
```bash
$ pnpm --filter server run benchmark:recovery
Exit code: 0
Key Metrics:
- Workload S (100 ops): 1.84x faster restoration (79.2% ops reduced)
- Workload M (500 ops): 2.39x faster restoration (79.8% ops reduced)
- Workload L (1000 ops): 2.93x faster restoration (79.9% ops reduced)
```

---

## 9. Acceptance Criteria Checklist

- [x] **1. The authoritative recovery source is explicit and enforced**: PostgreSQL is canonical; cold-room startup reconciles snapshots + operations into memory and LevelDB.
- [x] **2. Partial writes are reconciled safely**: Failures in either store surface explicit errors; retries complete missing writes.
- [x] **3. Durable deduplication survives process restart**: Enforced via PostgreSQL `durable_acks` table (verified in Scenario 14).
- [x] **4. Concurrent duplicate requests cannot create duplicate committed operations**: Serialized via in-flight promise map and database uniqueness constraints (verified in Scenario 13).
- [x] **5. Update-ID reuse with different payloads is rejected**: SHA-256 payload hash verification rejects collisions with `UPDATE_ID_PAYLOAD_MISMATCH` (verified in Scenario 16).
- [x] **6. Compaction preserves the required idempotency contract**: `durable_acks` has independent retention from pruned `operations` (verified in Scenario 15).
- [x] **7. Client ACK handling distinguishes failure from unknown outcome**: Implemented in `DurableSyncClient` (verified in Scenario 19).
- [x] **8. Recovery tests verify actual reconstructed document state**: All 19 scenarios assert exact Yjs text equality.
- [x] **9. Documentation matches the implementation**: Formalized in `docs/DURABILITY_CONTRACT.md` v1.1.0 and this audit.
- [x] **10. All test and benchmark results are reproducible**: All 10 test suites and benchmarks pass with exit code 0.
