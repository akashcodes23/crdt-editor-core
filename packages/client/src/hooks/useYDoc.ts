'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WS_URL, ROOM_NAME } from '@/lib/yjs'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface ChaosState {
  active: boolean
  countdown: number   // 30 → 0
  divergedChars: number
}

export interface SyncBytes {
  delta: number  // bytes of ops we were missing (what was actually sent)
  full: number   // bytes of full doc state (what naive resync would send)
}

export interface UseYDocResult {
  doc: Y.Doc | null
  provider: WebsocketProvider | null
  status: ConnectionStatus
  disconnect: () => void
  reconnect: () => void
  startChaos: () => void
  chaos: ChaosState
  mergeFlashRange: { start: number; end: number } | null
  clearMergeFlash: () => void
  syncBytes: SyncBytes | null
}

const CHAOS_SECONDS = 30

export function useYDoc(clientLabel: string): UseYDocResult {
  const docRef         = useRef<Y.Doc | null>(null)
  const providerRef    = useRef<WebsocketProvider | null>(null)
  const idbRef         = useRef<IndexeddbPersistence | null>(null)
  const chaosTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const offlineListRef = useRef<((u: Uint8Array) => void) | null>(null)
  const firstUpdateRef = useRef<((u: Uint8Array) => void) | null>(null)

  const [status,          setStatus]          = useState<ConnectionStatus>('connecting')
  const [chaos,           setChaos]           = useState<ChaosState>({ active: false, countdown: CHAOS_SECONDS, divergedChars: 0 })
  const [mergeFlashRange, setMergeFlashRange] = useState<{ start: number; end: number } | null>(null)
  const [syncBytes,       setSyncBytes]       = useState<SyncBytes | null>(null)

  useEffect(() => {
    const doc = new Y.Doc()
    docRef.current = doc
    const idb = new IndexeddbPersistence(`crdt-editor-${clientLabel}`, doc)
    idbRef.current = idb
    const provider = new WebsocketProvider(WS_URL, ROOM_NAME, doc, { connect: true })
    providerRef.current = provider
    provider.on('status', ({ status: s }: { status: string }) => {
      if (s === 'connected')       setStatus('connected')
      else if (s === 'disconnected') setStatus('disconnected')
      else                           setStatus('connecting')
    })
    provider.on('connection-error', () => setStatus('disconnected'))
    return () => {
      if (chaosTimerRef.current)  clearInterval(chaosTimerRef.current)
      if (offlineListRef.current) doc.off('update', offlineListRef.current)
      if (firstUpdateRef.current) doc.off('update', firstUpdateRef.current)
      provider.destroy(); idb.destroy(); doc.destroy()
      docRef.current = providerRef.current = idbRef.current = null
    }
  }, [clientLabel])

  /** Remove offline tracking listener and chaos countdown */
  const stopChaosTracking = useCallback(() => {
    if (chaosTimerRef.current)  { clearInterval(chaosTimerRef.current); chaosTimerRef.current = null }
    if (offlineListRef.current && docRef.current) {
      docRef.current.off('update', offlineListRef.current)
      offlineListRef.current = null
    }
  }, [])

  /**
   * Core reconnect logic — captures pre-reconnect state vector for delta diffing
   */
  const doReconnect = useCallback(() => {
    const doc      = docRef.current
    const provider = providerRef.current
    if (!doc || !provider) return

    const snapVector = Y.encodeStateVector(doc) // state vector after offline edits

    if (firstUpdateRef.current) {
      doc.off('update', firstUpdateRef.current)
      firstUpdateRef.current = null
    }

    // Fires when server reconciles missing updates
    const onFirstUpdate = () => {
      doc.off('update', onFirstUpdate)
      firstUpdateRef.current = null

      // Delta bytes versus full document state bytes
      const delta = Y.encodeStateAsUpdate(doc, snapVector)
      const full  = Y.encodeStateAsUpdate(doc)
      setSyncBytes({ delta: delta.byteLength, full: full.byteLength })
      setMergeFlashRange({ start: 0, end: 10 })
    }

    firstUpdateRef.current = onFirstUpdate
    doc.on('update', onFirstUpdate)

    stopChaosTracking()
    setStatus('connecting')
    setChaos({ active: false, countdown: CHAOS_SECONDS, divergedChars: 0 })
    setSyncBytes(null)
    provider.connect()
  }, [stopChaosTracking])

  const disconnect = useCallback(() => {
    const doc = docRef.current
    providerRef.current?.disconnect()
    setStatus('disconnected')
    setSyncBytes(null)

    // Track diverged edits while offline across all files
    if (doc) {
      const offlineListener = () => {
        setChaos(c => ({ ...c, divergedChars: c.divergedChars + 1 }))
      }
      doc.on('update', offlineListener)
      offlineListRef.current = offlineListener
    }
  }, [])

  const reconnect = useCallback(() => { doReconnect() }, [doReconnect])

  const startChaos = useCallback(() => {
    const doc      = docRef.current
    const provider = providerRef.current
    if (!doc || !provider) return

    provider.disconnect()
    setStatus('disconnected')
    setSyncBytes(null)

    // Track edits while offline across files
    const offlineListener = () => {
      setChaos(c => ({ ...c, divergedChars: c.divergedChars + 1 }))
    }
    doc.on('update', offlineListener)
    offlineListRef.current = offlineListener

    let remaining = CHAOS_SECONDS
    setChaos({ active: true, countdown: remaining, divergedChars: 0 })

    const interval = setInterval(() => {
      remaining--
      if (remaining <= 0) {
        clearInterval(interval)
        chaosTimerRef.current = null
        stopChaosTracking()
        doReconnect()
      } else {
        setChaos(c => ({ ...c, countdown: remaining }))
      }
    }, 1000)
    chaosTimerRef.current = interval
  }, [doReconnect, stopChaosTracking])

  const clearMergeFlash = useCallback(() => setMergeFlashRange(null), [])

  return {
    doc: docRef.current,
    provider: providerRef.current,
    status,
    disconnect,
    reconnect,
    startChaos,
    chaos,
    mergeFlashRange,
    clearMergeFlash,
    syncBytes,
  }
}
