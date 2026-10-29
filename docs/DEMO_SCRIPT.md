# Converge: Live Demonstration Script (60–90 Seconds)

**Target Audience**: Staff Engineers, Technical Hiring Managers, Distributed Systems Reviewers  
**Demonstration Length**: ~75–90 seconds  
**Objective**: Show real-time CRDT synchronization, atomic durable acknowledgements, split-brain partition recovery, and Web Worker-based Semantic Guard AST conflict attribution.

---

## 1. Prerequisites & Setup

### 1.1 Environment Requirements
* **Node.js**: $\ge 18$ (`node -v`)
* **pnpm**: $\ge 8$ (`pnpm -v`)
* **PostgreSQL**: PostgreSQL 15 running on `localhost:5432`

### 1.2 Start Database
Start PostgreSQL using either Docker Compose or macOS Homebrew:
```bash
# Option A: Docker Compose
docker compose up -d

# Option B: Native PostgreSQL
brew services start postgresql@15
```

### 1.3 Verify Environment File
```bash
# Ensure .env exists (copy default template if not present)
cp -n .env.example .env
```

### 1.4 Launch Development Servers
From the repository root:
```bash
pnpm dev
```
Wait until both services report ready:
* Server: `http://localhost:1234` (`[postgres] DB initialized: operations, snapshots, and durable_acks tables ready.`)
* Client: `http://localhost:3000` (`Ready in ~1300ms`)

---

## 2. Opening Independent Clients

Converge provides two methods to demonstrate collaborative editing:

### Option A: Built-in Split-Screen (Recommended for Single-Window Demos)
Open a single browser window to:
```
http://localhost:3000
```
* The interface immediately renders two isolated collaborative peers side-by-side:
  * **Left Pane**: `User A` (distinct Yjs client ID, isolated IndexedDB cache)
  * **Right Pane**: `User B` (distinct Yjs client ID, isolated IndexedDB cache)

### Option B: Dual Independent Browser Windows (Multi-Monitor / Side-by-Side)
1. Open Window 1 (Standard Chrome): `http://localhost:3000`
2. Open Window 2 (Incognito or Second Browser): `http://localhost:3000`
3. Both windows connect to the authoritative WebSocket room (`ws://localhost:1234/demo`).

---

## 3. Step-by-Step Demonstration Sequence (75–90s)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 00:00 - 00:20 │ Phase 1: Real-Time CRDT Sync & Durability ACK Status        │
│ 00:20 - 00:50 │ Phase 2: Partition Chaos, Split-Brain, & Reconnect Merge    │
│ 00:50 - 00:75 │ Phase 3: Semantic Guard AST Conflict Attribution            │
│ 00:75 - 00:90 │ Phase 4: Deterministic Time-Travel History Replay           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Real-Time CRDT Sync & Durability Acknowledgements (00:00 – 00:20)
1. **Focus on User A (Left Pane)**:
   * Select `src/index.ts` from the file explorer or tabs.
   * Type a new comment on line 1: `// Live collaborative edit by User A`
2. **Observe User B (Right Pane)**:
   * Edits appear **character-by-character** with zero observable lag (< 1 ms local delta sync).
   * User A's remote cursor caret and selection overlay are clearly rendered in User B's editor.
3. **Inspect the Durability Badge (Pane Header)**:
   * In User A's header, note the transition: `Saving (1)…` $\to$ `✓ Saved`.
   * This proves the edit was not just applied in memory, but committed to PostgreSQL WAL with an immutable Hybrid Logical Clock (HLC) and LevelDB hot storage.
4. **Inspect the Vector Clock Sidebar (Far Right)**:
   * Expand the right sidebar to show monotonic Lamport clocks per client ID (`#<clientID>`).
   * Note the **Differential Payload telemetry**: `Delta: 48 bytes` vs `Full Doc: ~17 KB` (**99.7% payload reduction**).

---

### Phase 2: Network Partition Chaos & Split-Brain Merge (00:20 – 00:50)
1. **Disconnect User B**:
   * In User B's pane header (Right), click **"Go Offline"** (or click **"Chaos Mode"** for a 30-second automated countdown).
   * User B's status changes to red (`Disconnected`).
2. **Simulate Concurrent Divergent Edits (Split-Brain)**:
   * In **User A (Left)**, edit line 6:
     ```typescript
     console.log('User A: Engine operational')
     ```
     *(User A remains online; status reports `✓ Saved`)*.
   * In **User B (Right)**, edit line 6 differently while offline:
     ```typescript
     console.log('User B: Offline local mutation')
     ```
   * Observe User B's status badge: changes to **`Unconfirmed (1)`** with yellow indicator:
     `OFFLINE: Queued for sync on reconnect`.
   * A purple pill appears in User B's header showing `1 unseen edit`.
3. **Reconnect & Observe Deterministic Convergence**:
   * Click **"Reconnect"** on User B.
   * Within milliseconds, both editors merge deterministically according to Yjs sequence CRDT rules.
   * A **green merge-flash** briefly illuminates the reconciled character ranges.
   * Both editors now show identical contents without cursor jumping or lost data.
   * User B's status transitions from `Unconfirmed (1)` $\to$ `✓ Saved`.

---

### Phase 3: Semantic Guard AST Conflict Detection (00:50 – 00:75)
*Standard CRDTs guarantee that text converges (syntactic consistency), but cannot detect compile-time errors that survive clean text merges.*

1. **Perform Concurrent Refactoring**:
   * In **User A (Left)**, open `src/vectorClock.ts`.
   * Rename the method `tick(): void` to `advance(): void`:
     ```typescript
     advance(): void {
       const current = this.clock.get(this.nodeId) || 0
     ```
   * In **User B (Right)**, open `src/index.ts`.
   * Add a call to the old method name:
     ```typescript
     clock.tick()
     ```
2. **Observe CRDT Text Convergence**:
   * Both files merge cleanly without syntax errors or text collisions.
3. **Observe Semantic Guard Attribution**:
   * Within ~200 ms, the background Web Worker parses the merged AST using TypeScript language services.
   * The status badge in the pane header updates from `🛡️ Clean` to:
     ```
     ⚠️ Semantic Conflict (1)
     ```
   * Hover over the badge to view the diagnostic:
     > `Property 'tick' does not exist on type 'VectorClock'. Did you mean 'advance'?`
     > `Attribution: CONFIRMED_CONCURRENT_CONFLICT`
   * This proves the platform detected a post-convergence semantic conflict and attributed it to concurrent edits rather than a local typing error.

---

### Phase 4: Deterministic Time-Travel History Replay (00:75 – 00:90)
1. **Open Time-Travel Drawer**:
   * In the top action bar, click **`⏱️ View Time-Travel History`**.
   * The historical drawer opens, displaying the operation count and HLC timestamp range.
2. **Scrub History**:
   * Drag the slider backwards across previous HLC timestamps.
   * Watch the Monaco editor reconstruct earlier states of the document by replaying atomic binary updates from PostgreSQL.
3. **Conclude**:
   * Close the history drawer to return to the live session.

---

## 4. Expected Outcomes & Invariants

| Action | Expected Visual Outcome | Distributed System Invariant |
| :--- | :--- | :--- |
| **Typing edit** | Instant remote reflection + `✓ Saved` badge | Strong Eventual Consistency + PostgreSQL WAL commit |
| **Going offline** | Red `Disconnected` badge + `Unconfirmed` count | Monotonically tracked pending update ID queue |
| **Concurrent edits** | Diverged edit count badge | Independent local CRDT branch evolution |
| **Reconnecting** | Green merge-flash + identical text in both panes | Commutative, associative CRDT merge |
| **Semantic rename conflict** | Red `⚠️ Semantic Conflict (1)` badge | Web Worker AST static analysis off main UI thread |
| **Time-travel scrub** | Point-in-time document reconstruction | Strict HLC monotonic operation replay |

---

## 5. Troubleshooting & Edge Cases

* **PostgreSQL Connection Error (`[postgres] DB initialization failed`)**:
  * Ensure PostgreSQL is listening on port 5432: `pg_isready -h localhost -p 5432`.
  * Check credentials in `.env`: default is `postgresql://crdt:password@localhost:5432/crdthistory`.
* **Port Conflict on 1234 or 3000**:
  * Identify process: `lsof -i :1234` or `lsof -i :3000`.
  * Kill stale process: `kill -9 <PID>`.
* **Editor Shows "Connecting…" Indefinitely**:
  * Verify the server process is running: `curl http://localhost:1234/health` should return `{"status":"ok","database":"healthy"}`.
* **LevelDB Lock Error**:
  * If the server was forcefully terminated, delete stale lockfiles: `rm -rf packages/server/data/leveldb/LOCK`.
