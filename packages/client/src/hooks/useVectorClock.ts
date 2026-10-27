'use client'

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { decodeStateVectorToMap } from '@/lib/yjs'

export interface VectorClockEntry {
  clientID: string
  clock: number
  isLocal: boolean
}

/**
 * Subscribes to doc updates and returns the decoded vector clock
 * as a sorted array of { clientID, clock, isLocal } entries.
 */
export function useVectorClock(
  doc: Y.Doc | null,
  localClientId: number | null
): VectorClockEntry[] {
  const [entries, setEntries] = useState<VectorClockEntry[]>([])

  useEffect(() => {
    if (!doc) return

    function refresh() {
      if (!doc) return
      const sv = Y.encodeStateVector(doc)
      const map = decodeStateVectorToMap(sv)
      const sorted: VectorClockEntry[] = []
      map.forEach((clock, clientIdStr) => {
        sorted.push({
          clientID: clientIdStr,
          clock,
          isLocal: clientIdStr === String(localClientId),
        })
      })
      // Local entry first, then ascending by numeric clientID
      sorted.sort((a, b) => {
        if (a.isLocal) return -1
        if (b.isLocal) return 1
        return Number(a.clientID) - Number(b.clientID)
      })
      setEntries(sorted)
    }

    doc.on('update', refresh)
    refresh() // initial render

    return () => {
      doc.off('update', refresh)
    }
  }, [doc, localClientId])

  return entries
}
