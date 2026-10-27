# Converge: Multi-File CRDT Workspace Data Model & Invariants

This document formalizes the data representation, concurrency policies, and invariants of the multi-file collaborative workspace in Converge.

---

## 1. Document & Identity Representation

Traditional collaborative text editors map a document directly to a single shared string. Converge structures an entire workspace as a composite CRDT graph inside a root `Y.Doc`.

### 1.1 Stable File Identity vs Mutable Paths
In filesystem hierarchies, paths like `/src/components/Button.tsx` are mutable references subject to concurrent renaming, folder moves, and deletions. 

**Core Design Rule**: File identities are **immutable UUIDs** (`node.id`), never file paths:
- Content is bound to `doc.getText('file:' + nodeId)`.
- If Node `f1` is renamed from `Button.tsx` to `PrimaryButton.tsx`, or moved from `/src` to `/lib`, its underlying `Y.Text` identity remains unchanged.
- Concurrent edits to `file:f1` are unaffected by simultaneous folder moves or renames.

### 1.2 Schema Definition

```typescript
export interface WorkspaceNode {
  id: string              // Immutable UUID (e.g., "file-171890-a3f8")
  name: string            // Display name (e.g., "index.ts", "components")
  type: 'file' | 'folder' // Node type
  parentId: string | null // Reference to parent folder UUID, or null for Root
  createdAt: number       // Epoch timestamp
}
```

The workspace directory is represented as:
$$\text{WorkspaceMap} = \text{doc.getMap<WorkspaceNode>}('workspace:files')$$

---

## 2. Invariant Specifications

### Invariant 1: Strong Eventual Convergence
For any two replicas $R_A$ and $R_B$, exchanging missing updates guarantees that the set of nodes and the contents of each file converge to identical state:
$$\text{WorkspaceMap}(R_A) = \text{WorkspaceMap}(R_B) \quad \land \quad \text{Content}(f, R_A) = \text{Content}(f, R_B) \quad \forall f$$

### Invariant 2: Acyclicity & Cycle-Safe Materialization
A directory tree must form a directed forest rooted at `null`. No folder $N$ may have an ancestor chain containing $N$.

* **Local Move Pre-Validation**:
  Before applying `moveNode(nodeId, targetParentId)`, the local replica traverses the parent chain of `targetParentId`. If `nodeId` is an ancestor of `targetParentId`, the move is rejected locally.
* **Concurrent Split-Brain Move Conflict Resolution**:
  If Peer A concurrently moves $F_1 \to F_2$ while Peer B moves $F_2 \to F_1$:
  - Upon synchronization, $F_1.\text{parentId} = F_2$ and $F_2.\text{parentId} = F_1$ (a cyclic loop disconnected from root).
  - The deterministic tree sanitizer (`sanitizeTreeHierarchy`) detects the loop during topological materialization and breaks the cyclic edge by resetting the cyclic child's parent to `null` (root).
  - **Guarantee**: No files or folders vanish into disconnected islands, and no infinite loops occur during rendering.

### Invariant 3: Collision-Free Duplicate Names
If Peer A and Peer B independently create files with identical names (e.g. `config.json`) in the same directory:
- Both files receive distinct UUIDs: `file-uuid-A` and `file-uuid-B`.
- Both files and their respective contents are preserved without overwrite.

---

## 3. Verified Automated Test Suite

| Test Suite | Scenario | Result |
| :--- | :--- | :--- |
| `workspace-invariants.test.ts` | Concurrent file creation across peers | **PASS** |
| `workspace-invariants.test.ts` | Concurrent file rename and content edit | **PASS** |
| `workspace-invariants.test.ts` | Local acyclic folder parenting check | **PASS** |
| `workspace-invariants.test.ts` | Concurrent cyclic moves deterministically broken to root | **PASS** |
| `workspace-invariants.test.ts` | Duplicate file names preserve distinct UUID identities | **PASS** |
| `distributed-correctness.test.ts` | 3-Client network partition and heal | **PASS** |
| `distributed-correctness.test.ts` | Duplicate update delivery idempotency | **PASS** |
| `distributed-correctness.test.ts` | Out-of-order update delivery | **PASS** |
| `distributed-correctness.test.ts` | Hybrid Logical Clock causal chains & NTP regression | **PASS** |
| `hlc-and-recovery.test.ts` | Strict HLC monotonicity & snapshot tail recovery | **PASS** |
| `crdt-convergence.test.ts` | Concurrent inserts, deletes, and rapid sequential edits | **PASS** |
| `hlc-semantics.test.ts` | Clock regression, tie-breaking, causality, and parsing errors | **PASS** |
| `compaction-races-and-recovery.test.ts` | Concurrent write preservation, compaction mutex, rollback safety, and 410 retention contract | **PASS** |

Total: **31 passing unit & integration tests** across 6 test suites.  
For persistence, compaction, and recovery invariants, see [RECOVERY.md](./RECOVERY.md).

---

## 4. Current Limitations & Future Work

1. **Trash / Soft-Delete Archive**:
   Deleting a folder currently deletes its node record. While child `Y.Text` instances persist in the CRDT history, a dedicated "Trash / Recovered Files" explorer pane would enhance enterprise usability.
2. **Path Alias Resolution in Language Server**:
   TypeScript syntax checking is local to each Monaco model; cross-file type resolution for local relative imports (e.g. `import from './util'`) requires Monaco language service worker path mapping.
