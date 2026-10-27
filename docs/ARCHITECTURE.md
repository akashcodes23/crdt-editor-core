# Converge: Architecture & Systems Design

Converge is a local-first, collaborative distributed development environment built upon Conflict-free Replicated Data Types (CRDTs), Hybrid Logical Clocks (HLC), and multi-tier persistence.

---

## 1. High-Level System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Next.js Client Application                      │
│                                                                        │
│  ┌───────────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Monaco Multi-Tab IDE  │  │ File Tree CRDT  │  │ Chaos & Latency  │  │
│  │ (Y.Text per model)    │  │ (Y.Map Hierarch)│  │ Telemetry Engine │  │
│  └───────────▲───────────┘  └────────▲────────┘  └────────▲─────────┘  │
│              │                       │                    │            │
│  ┌───────────┴───────────────────────┴────────────────────┴─────────┐  │
│  │                Y.Doc Root & Local State Vector                    │  │
│  │                (IndexedDB Local Persistence)                      │  │
│  └───────────────────────────────────▲──────────────────────────────┘  │
└──────────────────────────────────────┼─────────────────────────────────┘
                                       │ WebSocket Wire Protocol
                                       │ (y-protocols sync + awareness)
┌──────────────────────────────────────▼─────────────────────────────────┐
│                    Converge Collaboration Gateway                      │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ WebSocket Room Registry & Connection Lifecycle Manager           │  │
│  │ (Per-socket UUID, Message Size Validation, Rate Limiting)        │  │
│  └──────┬────────────────────────────┬──────────────────────────────┘  │
│         │                            │                                 │
│  ┌──────▼─────────────────────┐  ┌───▼──────────────────────────────┐  │
│  │ CRDT Sync Engine           │  │ Ephemeral Awareness & Presence   │  │
│  │ (Step 1/2 State Vectors)   │  │ (Broadcast isolation, keepalive) │  │
│  └──────┬─────────────────────┘  └──────────────────────────────────┘  │
│         │                                                              │
│  ┌──────▼───────────────────────────────────────────────────────────┐  │
│  │ Operation Pipeline: HLC Generator (<time>-<count>-<nodeId>)       │  │
│  └──────┬────────────────────────────┬──────────────────────────────┘  │
└─────────┼────────────────────────────┼─────────────────────────────────┘
          │ Async Append               │ Sync / State Bind
┌─────────▼─────────────────────┐  ┌───▼─────────────────────────────────┐
│ PostgreSQL Cluster            │  │ In-Process LevelDB Cache            │
│ - operations (BYTEA, HLC)     │  │ (Sub-10ms room state recovery       │
│ - snapshots (Checkpoints)     │  │  across server restarts)            │
└───────────────────────────────┘  └─────────────────────────────────────┘
```

---

## 2. Core Subsystems

### 2.1 Synchronization Protocol (`packages/server/src/room.ts`)
* Implements the **State-Vector Diff Synchronization Protocol** (`y-protocols/sync`):
  * **Step 1 (Handshake)**: Client connecting sends its state vector $V_C$.
  * **Step 2 (Missing Updates)**: Server computes $U_S = \text{diff}(V_S, V_C)$ and sends back only updates the client has not observed. Client returns its missing diff to the server.
  * **Steady-State Updates**: Incremental binary updates broadcasted to connected peers using broadcast-except filtering.
* **Awareness Protocol (`y-protocols/awareness`)**:
  * Ephemeral client presence (cursor position, selection ranges, user display name, assigned client color).
  * Awareness updates are broadcasted to peers and purged deterministically upon client disconnection.

### 2.2 Dual-Tier Persistence
1. **Durable Operational Log (PostgreSQL)**:
   * Table: `operations`
   * Schema: `id BIGSERIAL`, `doc_id TEXT`, `client_id TEXT`, `hlc_timestamp TEXT`, `created_at TIMESTAMPTZ`, `update_blob BYTEA`.
   * Monotonic ordering guarantees replay determinism up to any point in time.
2. **Snapshot & Checkpoint Engine**:
   * Periodically folds operation delta streams into compacted binary snapshots (`doc_snapshots`).
   * Recovery combines the latest validated snapshot + delta log tail, eliminating full-log replays.
3. **Local Fast Recovery Cache (LevelDB)**:
   * LevelDB (`y-leveldb`) holds consolidated document state on the server filesystem for instant room initialization.

### 2.3 Hybrid Logical Clock (HLC)
* Located in `packages/server/src/hlc.ts`.
* Generates monotonic, lexically sortable timestamp strings formatted as:
  $$\text{HLC} = \langle \text{wallTime}_{36} \rangle - \langle \text{counter}_{36} \rangle - \langle \text{nodeId} \rangle$$
* If physical wall clock stalls or drifts backwards, the logical counter increments monotonically, preventing causality inversions.

---

## 3. Data Flow & Replay Semantics

### Document Synchronization
1. Client connects via `ws://HOST:PORT/:roomName`.
2. Connection is assigned a unique `connectionId`.
3. Server transmits `SyncStep1(Vector_Server)`.
4. Client responds with `SyncStep2(Diff_ServerMissing)` and `SyncStep1(Vector_Client)`.
5. Server sends `SyncStep2(Diff_ClientMissing)`.
6. Client and server are now in full Strong Eventual Consistency (SEC).

### Time-Travel Reconstruction
1. Client requests `GET /doc/:id/history?before=<HLC>`.
2. Server queries operations `WHERE doc_id = $1 AND hlc_timestamp <= $2 ORDER BY hlc_timestamp ASC`.
3. Client receives base64 binary updates, initializes an ephemeral in-memory `Y.Doc`, and replays updates sequentially.
4. Editor delta decorations inspect `yText._start` item linked list to color-code ranges by author client ID.

---

## 4. Architectural Boundaries & Non-Functional Requirements

| Metric / Concern | Design Target | Implementation Mechanism |
| :--- | :--- | :--- |
| **Consistency** | Strong Eventual Consistency (SEC) | Yjs State-based Sequence CRDT (Y.Text, Y.Map) |
| **Wire Efficiency** | Delta-only byte transmission | State Vector differential encoding |
| **Room Recovery** | $< 15\text{ ms}$ warm reboot | LevelDB snapshot binding |
| **Cold Audit Replay** | Deterministic causal order | PostgreSQL append-only HLC indexed log |
| **Process Resilience** | Zero data corruption on SIGTERM | Graceful shutdown hooks & LevelDB close |
