'use client'

import { useEffect, useState } from 'react'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import { colorFromClientId } from '@/lib/colors'

export interface RemoteCursorState {
  clientID: number
  name: string
  color: string
  cursor: { index: number; length: number } | null
}

/**
 * Subscribes to Awareness updates and returns an array of remote peer states.
 * The local client is excluded from the returned list.
 */
export function useAwareness(
  provider: WebsocketProvider | null,
  localName: string
): RemoteCursorState[] {
  const [remoteStates, setRemoteStates] = useState<RemoteCursorState[]>([])

  useEffect(() => {
    if (!provider) return

    const awareness = provider.awareness as Awareness
    const localClientId = provider.doc.clientID

    // Set our own local state so remote peers can render our cursor
    awareness.setLocalState({
      user: {
        name: localName,
        color: colorFromClientId(localClientId),
        clientID: localClientId,
      },
      cursor: null,
    })

    function updateStates() {
      const states = awareness.getStates() as Map<
        number,
        {
          user?: { name: string; color: string; clientID: number }
          cursor?: { index: number; length: number } | null
        }
      >

      const remotes: RemoteCursorState[] = []
      states.forEach((state, clientId) => {
        if (clientId === localClientId) return
        if (!state.user) return
        remotes.push({
          clientID: clientId,
          name: state.user.name,
          color: state.user.color,
          cursor: state.cursor ?? null,
        })
      })
      setRemoteStates(remotes)
    }

    awareness.on('change', updateStates)
    updateStates()

    return () => {
      awareness.off('change', updateStates)
      awareness.setLocalState(null)
    }
  }, [provider, localName])

  return remoteStates
}

/**
 * Update the local cursor position in Awareness.
 * Call this from Monaco's onDidChangeCursorSelection.
 */
export function setAwarenessCursor(
  provider: WebsocketProvider | null,
  cursor: { index: number; length: number } | null
): void {
  if (!provider) return
  const awareness = provider.awareness as Awareness
  const current = awareness.getLocalState() as Record<string, unknown> | null
  awareness.setLocalState({
    ...(current ?? {}),
    cursor,
  })
}
