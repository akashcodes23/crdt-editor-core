# Converge: Testing Strategy

This document defines the formal verification and testing methodology for Converge across all layers of the stack.

---

## 1. Testing Pyramid

```
                ┌───────────────────────┐
                │ End-to-End Workflows  │
                │  (Multi-client tests) │
                └───────────┬───────────┘
                            │
              ┌─────────────┴─────────────┐
              │  Distributed Integration  │
              │  (Partitions, Reconnects) │
              └─────────────┬─────────────┘
                            │
            ┌───────────────┴───────────────┐
            │       Unit Verification       │
            │  (CRDT Invariants, HLC, Tree) │
            └───────────────────────────────┘
```

---

## 2. Invariant Specifications

### 2.1 CRDT Strong Eventual Consistency (SEC)
* **Invariant**: For any two replicas $R_A$ and $R_B$, if both have observed the same set of operations $O = \{o_1, o_2, \dots, o_n\}$, then:
  $$\text{State}(R_A) = \text{State}(R_B)$$
  regardless of the order in which individual operations were received or applied.
* **Test Coverage**:
  - `Test 1`: Concurrent inserts at identical index (e.g. position 0).
  - `Test 2`: Concurrent deletions of identical characters.
  - `Test 3`: Simultaneous insert on Replica A and delete on Replica B.
  - `Test 4`: Identical text inserted offline on both replicas.
  - `Test 5`: High-frequency interleaved edits (100+ operations).

### 2.2 Hybrid Logical Clock (HLC)
* **Invariant 1 (Monotonicity)**: For any node $i$, if an event $e_2$ occurs after $e_1$, then $\text{HLC}(e_2) > \text{HLC}(e_1)$.
* **Invariant 2 (Lexical Sortability)**: The string representation must be strictly order-preserving via ASCII character sorting.

### 2.3 Workspace File Tree
* **Invariant 1 (Acyclicity)**: No directory node $N$ can have an ancestor path containing $N$.
* **Invariant 2 (Unique Identity)**: Every file/folder possesses an immutable UUID independent of its mutable path or parent folder.
* **Invariant 3 (Deterministic Move Conflict Resolution)**: If concurrent moves create a cycle (e.g. moving Folder A into B while moving B into A), the operation with the higher logical clock wins, preserving a tree structure.

---

## 3. Test Execution Commands

| Scope | Command | Purpose |
| :--- | :--- | :--- |
| **Server Unit Tests** | `pnpm --filter server test` | Runs Jest suite for CRDT convergence and HLC logic |
| **Server Typecheck** | `pnpm --filter server typecheck` | Validates TypeScript types with `tsc --noEmit` |
| **Client Typecheck** | `pnpm --filter client typecheck` | Validates Next.js React components and Monaco hooks |
| **Client Production Build** | `pnpm --filter client build` | Verifies Next.js compiler, SSR guards, and bundling |
