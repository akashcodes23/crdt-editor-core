import type { VectorClockEntry } from '@/hooks/useVectorClock'
import type { SyncBytes } from '@/hooks/useYDoc'

interface VectorClockSidebarProps {
  entries: VectorClockEntry[]
  localClientId: number | null
  userName: string
  syncBytes?: SyncBytes | null
}

export function VectorClockSidebar({
  entries,
  localClientId,
  userName,
  syncBytes,
}: VectorClockSidebarProps) {
  return (
    <aside className="vc-sidebar">
      <h3 className="vc-title">
        <span className="vc-icon">⟨V⟩</span> Vector Clock
      </h3>
      <p className="vc-subtitle">
        {userName} · ID&nbsp;
        <code className="vc-id">{localClientId ?? '—'}</code>
      </p>

      <div className="vc-entries">
        {entries.length === 0 ? (
          <p className="vc-empty">No operations yet</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.clientID}
              className={`vc-entry ${entry.isLocal ? 'vc-entry--local' : ''}`}
            >
              <div className="vc-entry-header">
                <span className="vc-client-id" title={`clientID: ${entry.clientID}`}>
                  {entry.isLocal ? '▶ ' : ''}
                  {entry.clientID.slice(0, 6)}…
                </span>
                <span className="vc-clock-badge">
                  c={entry.clock}
                </span>
              </div>
              {/* Clock progress bar — visual diff at a glance */}
              <div className="vc-bar-track">
                <div
                  className="vc-bar-fill"
                  style={{
                    width: `${Math.min(100, (entry.clock / Math.max(...entries.map((e) => e.clock), 1)) * 100)}%`,
                    background: entry.isLocal
                      ? 'linear-gradient(90deg, #6ee7b7, #3b82f6)'
                      : 'linear-gradient(90deg, #a78bfa, #ec4899)',
                  }}
                />
              </div>
            </div>
          ))
        )}
      </div>

      {syncBytes && (
        <div className="vc-sync-bytes">
          <div className="vc-sync-bytes-label">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            Last Reconnect Sync
          </div>
          <div className="vc-sync-bytes-row">
            <span className="vc-sync-desc">Delta transfer</span>
            <span className="vc-sync-metric">{syncBytes.delta} B</span>
          </div>
          <div className="vc-sync-bytes-row">
            <span className="vc-sync-desc">Full state</span>
            <span className="vc-sync-metric">{syncBytes.full} B</span>
          </div>
          {syncBytes.full > 0 && (
            <div className="vc-sync-bytes-row" style={{ marginTop: 6, paddingTop: 4, borderTop: '1px dotted rgba(255,255,255,0.1)' }}>
              <span className="vc-sync-desc">Savings</span>
              <span className="vc-sync-metric vc-sync-metric--savings">
                {Math.round((1 - syncBytes.delta / syncBytes.full) * 100)}%
              </span>
            </div>
          )}
        </div>
      )}

      <div className="vc-footer">
        <span className="vc-footer-label">Yjs State Vector</span>
        <span className="vc-footer-hint">Updates every keystroke</span>
      </div>
    </aside>
  )
}
