# Converge: Engineering Roadmap

This roadmap tracks implementation milestones from single-file proof-of-concept to an industry-grade, fault-tolerant distributed collaboration system.

---

## Milestone Status

| Phase | Description | Priority | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Baseline Audit, Static Verification, Architecture Documentation | P0 | **COMPLETED** |
| **Phase 1** | Engineering Foundation: CI, Config Validation, Graceful Shutdown, Security Model | P0 | **IN PROGRESS** |
| **Phase 2** | Multi-File Collaborative Workspace (CRDT File Tree, Tabs, Model Lifecycle) | P1 | **PLANNED** |
| **Phase 3** | Distributed Systems Correctness & Failure Injection Test Harness | P1 | **PLANNED** |
| **Phase 4** | Durable Snapshots, Checkpoints, and Operation Log Compaction | P1 | **PLANNED** |
| **Phase 5** | Distributed Scaling Evaluation & Redis Pub/Sub Adapter | P2 | **PLANNED** |
| **Phase 6** | AST-Based Semantic Conflict Detection (TypeScript/JS Merge Analysis) | P2 | **PLANNED** |
| **Phase 7** | Sandboxed In-Browser Execution & Terminal Streaming | P3 | **BACKLOG** |
| **Phase 8** | Interactive Chaos Engineering Lab & Live Latency Injector | P2 | **PLANNED** |

---

## Detailed Milestone Objectives

### Phase 1: Engineering Foundation
- [x] Baseline audit of existing client, server, and test suites.
- [ ] Implement environment variable validation (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PORT`, `HOST`) with Zod/typed schemas.
- [ ] Implement structured server logging with request/correlation IDs and sanitized payloads.
- [ ] Implement graceful shutdown handling (`SIGTERM`, `SIGINT`) flushing LevelDB instances and closing PostgreSQL pools safely.
- [ ] Add GitHub Actions CI workflow covering linting, typechecking, server unit tests, and production frontend build.
- [ ] Add `SECURITY.md` establishing vulnerability disclosure and threat model boundaries.

### Phase 2: Multi-File Collaborative Workspace
- [ ] Shared `Y.Map` file tree representation storing file nodes, parent relationships, and file metadata.
- [ ] Invariant enforcement: Prevent filesystem cycles (a folder cannot be moved into its descendant).
- [ ] Tabbed Monaco editor with active tab tracking and dynamic language mode detection (`typescript`, `javascript`, `json`, `markdown`, `css`).
- [ ] Non-destructive document switching (Monaco editor models bound to separate `Y.Text` instances).
- [ ] Unit tests for concurrent file creation, renaming, moves, and deletions.

### Phase 3: Distributed Systems Correctness
- [ ] Isolated headless integration test harness spawning test WebSocket server and mock clients.
- [ ] Test scenarios: Split-brain network partitions, out-of-order deliveries, duplicated updates, client dropouts during sync.
- [ ] Awareness cleanup validation after unexpected connection drops.

### Phase 4: Durable Snapshots & Log Compaction
- [ ] Postgres snapshot schema: `doc_snapshots (id, doc_id, snapshot_blob, hlc_cutoff, created_at)`.
- [ ] Snapshot generation trigger: Compact after $N$ operations or time interval.
- [ ] Fast recovery procedure: Load latest snapshot $\to$ apply delta operations with `hlc > hlc_cutoff`.
- [ ] Crash resilience test during snapshot generation.
