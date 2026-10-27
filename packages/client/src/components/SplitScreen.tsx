'use client'

import { useState } from 'react'
import { EditorPane } from './EditorPane'
import { HistoryPane } from './HistoryPane'

export function SplitScreen() {
  const [showHistory, setShowHistory] = useState(false)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* ── Action Bar for toggling History ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 12px', background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)' }}>
        <button 
          className="conn-btn" 
          onClick={() => setShowHistory(prev => !prev)}
          style={{ background: showHistory ? 'var(--accent-purple)' : 'transparent', color: showHistory ? 'white' : 'var(--text-secondary)', border: '1px solid var(--border-muted)' }}
        >
          {showHistory ? 'Close History' : '⏱️ View Time-Travel History'}
        </button>
      </div>

      <div className="split-screen" style={{ flex: showHistory ? 0.5 : 1 }}>
        <EditorPane
          clientLabel="user-a"
        displayName="User A"
        side="left"
      />
      <div className="split-divider" aria-hidden="true">
        <div className="split-divider-line" />
        <span className="split-divider-badge">CRDT</span>
        <div className="split-divider-line" />
      </div>
      <EditorPane
        clientLabel="user-b"
        displayName="User B"
        side="right"
      />
      </div>

      {showHistory && (
        <HistoryPane onClose={() => setShowHistory(false)} />
      )}
    </div>
  )
}
