'use client'

import dynamic from 'next/dynamic'

// SplitScreen imports Yjs, y-websocket, y-indexeddb and Monaco — all of which
// access `window` / `navigator` / `indexedDB` at module load time.
// Next.js App Router still SSR-evaluates 'use client' boundaries during
// static prerendering, so we must disable SSR for the entire editor tree.
const SplitScreen = dynamic(
  () => import('@/components/SplitScreen').then((m) => m.SplitScreen),
  { ssr: false, loading: () => <div className="editor-loading">Initialising CRDT editor…</div> }
)

export default function HomePage() {
  return (
    <div className="app-shell">
      {/* ── Top header ─────────────────────────────────────────── */}
      <header className="app-header">
        <div className="app-logo">
          <div className="app-logo-mark">Σ</div>
          <span className="app-logo-text">
            CRDT <span>Editor</span>
          </span>
        </div>
        <div className="app-header-tags">
          <span className="app-tag app-tag--yjs">Yjs</span>
          <span className="app-tag app-tag--monaco">Monaco</span>
          <span className="app-tag app-tag--crdt">Offline-First</span>
        </div>
      </header>

      {/* ── Demo instructions ───────────────────────────────────── */}
      <div className="demo-bar" role="note" aria-label="Demo instructions">
        <div className="demo-step">
          <span className="demo-step-num">1</span>
          Type in either pane — edits sync live
        </div>
        <div className="demo-step-sep" />
        <div className="demo-step">
          <span className="demo-step-num">2</span>
          Click <strong>&quot;Go Offline&quot;</strong> on User B
        </div>
        <div className="demo-step-sep" />
        <div className="demo-step">
          <span className="demo-step-num">3</span>
          Type in both panes simultaneously
        </div>
        <div className="demo-step-sep" />
        <div className="demo-step">
          <span className="demo-step-num">4</span>
          Click <strong>&quot;Reconnect&quot;</strong> — watch the merge
        </div>
      </div>

      {/* ── Split-screen editor ─────────────────────────────────── */}
      <main style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <SplitScreen />
      </main>
    </div>
  )
}
