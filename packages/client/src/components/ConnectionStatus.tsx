'use client'

import type { ConnectionStatus, ChaosState } from '@/hooks/useYDoc'
import type { SaveState } from '@/lib/durable-client'

interface ConnectionStatusBadgeProps {
  status: ConnectionStatus
  chaos: ChaosState
  onDisconnect: () => void
  onReconnect: () => void
  onStartChaos: () => void
  label: string
  saveState?: SaveState
  onRetryFailed?: () => void
}

/** Circumference for r=12: 2π×12 ≈ 75.4 */
const RING_C = 75.4

export function ConnectionStatusBadge({
  status,
  chaos,
  onDisconnect,
  onReconnect,
  onStartChaos,
  label,
  saveState,
  onRetryFailed,
}: ConnectionStatusBadgeProps) {
  const slug       = label.toLowerCase().replace(/\s+/g, '-')
  const isOnline   = status === 'connected'
  const isOffline  = status === 'disconnected'

  return (
    <div className="conn-status">
      {/* Animated status dot */}
      <div className={`conn-dot conn-dot--${status}`} />

      {/* Transport status pill */}
      <span className={`conn-pill conn-pill--${status}`}>
        {isOnline ? 'Online' : status === 'connecting' ? 'Connecting…' : 'Offline'}
      </span>

      {/* Persistence status pill */}
      {saveState && (
        <span
          className={`save-pill save-pill--${saveState.overallStatus}`}
          title={
            saveState.overallStatus === 'durable'
              ? `All ${saveState.durableCount} updates persisted${saveState.latestConfirmedHlc ? ` (HLC: ${saveState.latestConfirmedHlc})` : ''}`
              : saveState.overallStatus === 'pending'
              ? `${saveState.pendingCount} update(s) in-flight awaiting durable confirmation`
              : saveState.overallStatus === 'unknown'
              ? `${saveState.unknownCount} update(s) unconfirmed (connection dropped)`
              : `${saveState.failedCount} update(s) failed persistence`
          }
        >
          {saveState.overallStatus === 'durable' && '✓ Saved'}
          {saveState.overallStatus === 'pending' && `Saving (${saveState.pendingCount})…`}
          {saveState.overallStatus === 'unknown' && `Unconfirmed (${saveState.unknownCount})`}
          {saveState.overallStatus === 'failed' && `Save Failed (${saveState.failedCount})`}
        </span>
      )}

      {/* Manual retry save button if there are failed or unconfirmed updates while online */}
      {isOnline && onRetryFailed && saveState && (saveState.failedCount > 0 || saveState.unknownCount > 0) && (
        <button
          id={`btn-retry-save-${slug}`}
          className="conn-btn conn-btn--retry-save"
          onClick={onRetryFailed}
          title="Retry persisting unconfirmed or failed updates"
        >
          ↻ Retry Save
        </button>
      )}

      {/* Chaos countdown ring */}
      {chaos.active && (
        <div className="chaos-countdown" title={`Auto-reconnect in ${chaos.countdown}s`}>
          <svg viewBox="0 0 32 32" className="chaos-ring" aria-hidden="true">
            <circle cx="16" cy="16" r="12" className="chaos-ring-bg" />
            <circle
              cx="16" cy="16" r="12"
              className="chaos-ring-fill"
              style={{ strokeDashoffset: RING_C * (chaos.countdown / 30) }}
            />
          </svg>
          <span className="chaos-countdown-num">{chaos.countdown}s</span>
        </div>
      )}

      {/* Diverged chars badge — shown while offline */}
      {isOffline && chaos.divergedChars > 0 && (
        <span 
          className="chaos-diverge-badge" 
          title="Characters typed while offline"
          style={{ color: '#fbbf24', fontSize: '11px', display: 'block', marginTop: '2px' }}
        >
          {chaos.divergedChars} unseen edit{chaos.divergedChars !== 1 ? 's' : ''}
        </span>
      )}

      {/* ── Action buttons ───────────────────────────────────────────── */}

      {/* Normal online → show Offline + ⚡ Chaos */}
      {isOnline && !chaos.active && (
        <>
          <button
            id={`btn-disconnect-${slug}`}
            className="conn-btn conn-btn--disconnect"
            onClick={onDisconnect}
            title="Disconnect (manual offline)"
          >
            Offline
          </button>
          <button
            id={`btn-chaos-${slug}`}
            className="conn-btn conn-btn--chaos"
            onClick={onStartChaos}
            title="Chaos Mode: auto-reconnect in 30s"
          >
            ⚡ Chaos
          </button>
        </>
      )}

      {/* Offline + no chaos → manual reconnect */}
      {isOffline && !chaos.active && (
        <button
          id={`btn-reconnect-${slug}`}
          className="conn-btn conn-btn--reconnect"
          onClick={onReconnect}
          title="Reconnect WebSocket"
        >
          Reconnect
        </button>
      )}

      {/* Chaos active → early reconnect option */}
      {chaos.active && (
        <button
          id={`btn-chaos-reconnect-${slug}`}
          className="conn-btn conn-btn--reconnect"
          onClick={onReconnect}
          title="Reconnect now (skip countdown)"
        >
          Now
        </button>
      )}
    </div>
  )
}
