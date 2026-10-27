# Converge: Known Limitations & Technical Debt

This document candidly outlines architectural boundaries, trade-offs, and current engineering limitations.

---

## 1. Verified Current Limitations

### 1.1 Single-Server Room In-Memory Registry
* **Impact**: All active WebSocket connections for a given room must connect to the same server process.
* **Trade-off**: Simplifies concurrency by maintaining an authoritative in-memory `Y.Doc` instance per room.
* **Mitigation / Next Step**: Implement cross-instance pub/sub (Redis Pub/Sub) with sticky routing or stateless snapshot backends.

### 1.2 Uncompacted PostgreSQL Operation Log
* **Impact**: Every atomic update keystroke writes a row to PostgreSQL table `operations`. Documents with high edit volume will accumulate thousands of rows, increasing cold history query latency.
* **Mitigation**: Introduce snapshot checkpoints (`doc_snapshots`) and log compaction boundaries (Phase 4).

### 1.3 Syntactic vs Semantic Convergence
* **Limitation**: CRDTs guarantee that every replica converges to identical characters (syntactic convergence). They do NOT guarantee that merged code is syntactically valid or compiles without error (semantic correctness).
* **Example**: Concurrent variable rename by User A and reference by User B merges without conflicts, but fails runtime evaluation.
* **Mitigation**: Introduce AST-based semantic analysis diagnostics (Phase 6).

### 1.4 Native Dependency Build (Leveldown / LevelDB)
* **Limitation**: `y-leveldb` relies on `leveldown` which includes C++ native bindings. In containerized environments, build tooling (`python3`, `make`, `g++`) must be present during dependency compilation.

### 1.5 WebSocket Wire Protocol Authentication
* **Limitation**: WebSocket connection accepts room parameter directly from URL path without cryptographically signed JWT tokens or session cookies.
* **Mitigation**: Implement token validation in the connection upgrade handshake before registering room membership.
