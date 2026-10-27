'use client'

import type { ConnectionStatus, ChaosState } from '@/hooks/useYDoc'

interface ConnectionStatusBadgeProps {
  status: ConnectionStatus
  chaos: ChaosState
  onDisconnect: () => void
  onReconnect: () => void
  onStartChaos: () => void
  label: string
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
}: ConnectionStatusBadgeProps) {
  const slug       = label.toLowerCase().replace(/\s+/g, '-')
  const isOnline   = status === 'connected'
  const isOffline  = status === 'disconnected'

  return (
    <div className="conn-status">
      {/* Animated status dot */}
      <div className={`conn-dot conn-dot--${status}`} />

      {/* Status pill */}
      <span className={`conn-pill conn-pill--${status}`}>
        {isOnline ? 'Online' : status === 'connecting' ? 'Connecting…' : 'Offline'}
      </span>

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
