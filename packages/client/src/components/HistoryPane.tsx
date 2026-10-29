'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as Y from 'yjs'
import dynamic from 'next/dynamic'
import type monaco from 'monaco-editor'
import { MonacoBinding } from 'y-monaco'
import { colorFromClientId } from '@/lib/colors'
import { HTTP_API_URL, CONVERGE_AUTH_TOKEN } from '@/lib/yjs'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <div className="editor-loading">Loading History…</div>,
})

interface HistoryPaneProps {
  onClose: () => void
  docId?: string
}

export function HistoryPane({ onClose, docId = 'demo' }: HistoryPaneProps) {
  // We'll use absolute timestamps for the slider.
  // We default start to a recent time, but in a real app we'd query the DB for the first op time.
  // For demo: start 5 mins ago to now.
  const nowMs = Date.now()
  const startMs = nowMs - 5 * 60 * 1000 // 5 minutes window
  
  const [sliderMs, setSliderMs] = useState<number>(nowMs)
  const [opsCount, setOpsCount] = useState<number>(0)
  
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const docRef = useRef<Y.Doc | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const colorDecorationsRef = useRef<string[]>([])

  const fetchHistory = useCallback(async (targetTime: number) => {
    // Generate an HLC string for the target time:
    const timeStr = targetTime.toString(36).padStart(11, '0')
    const beforeHLC = `${timeStr}-ffff-zzzz` // upper bound for that ms

    try {
      const headers: Record<string, string> = {}
      if (CONVERGE_AUTH_TOKEN) {
        headers['Authorization'] = `Bearer ${CONVERGE_AUTH_TOKEN}`
      }
      const res = await fetch(`${HTTP_API_URL}/doc/${docId}/history?before=${beforeHLC}`, {
        headers,
      })
      if (!res.ok) throw new Error('Fetch failed')
      const data = await res.json()
      
      const opsB64: string[] = data.ops
      setOpsCount(opsB64.length) // for info only

      // Reconstruct ephemeral Y.Doc
      const newDoc = new Y.Doc()
      const yText = newDoc.getText('code')
      
      // Apply each update in exact order.
      // WE DOCUMENT THE BASE64 METHODOLOGY HERE:
      // We requested the operations from the server as a JSON array of base64 strings.
      // To decode back into the raw binary (Buffer/Uint8Array) expected by Yjs,
      // we utilize the standard JS conversion: Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      // Specifically in Node/Buffer-compatible environments, Buffer.from(b64, 'base64') 
      // functions identically and performs faster, but atob is the pure browser way.
      for (const op64 of opsB64) {
        // Here we use the specified native decoding approach:
        const binaryString = atob(op64)
        const bin = Uint8Array.from(binaryString, c => c.charCodeAt(0))
        Y.applyUpdate(newDoc, bin)
      }

      // Rebind Monaco
      if (editorRef.current) {
        // Destroy old binding
        if (bindingRef.current) bindingRef.current.destroy()
        
        bindingRef.current = new MonacoBinding(
          yText,
          editorRef.current.getModel()!,
          new Set([editorRef.current]),
          null // no awareness in history
        )

        applyAuthorColors(newDoc, editorRef.current)
      }
      docRef.current = newDoc

    } catch (err) {
      console.error('[history] failed to fetch:', err)
    }
  }, [docId])

  // Map author insertions to color decorations
  const applyAuthorColors = (doc: Y.Doc, editor: monaco.editor.IStandaloneCodeEditor) => {
    const yText = doc.getText('code')
    const model = editor.getModel()
    if (!model) return

    const newDecorations: monaco.editor.IModelDeltaDecoration[] = []
    
    // Y.Text exposes an internal representation 'yText._start' pointing to the first Item
    // We can iterate the item list to find contiguous character blocks
    let currentItem = yText._start
    let textIndex = 0

    while (currentItem !== null) {
      if (!currentItem.deleted && currentItem.content instanceof Y.ContentString) {
        const length = currentItem.length
        const clientId = currentItem.id.client
        const color = colorFromClientId(clientId)

        const startPos = model.getPositionAt(textIndex)
        const endPos = model.getPositionAt(textIndex + length)

        newDecorations.push({
          range: {
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
          },
          options: {
            className: `history-author-${clientId}`,
            stickiness: 1, // NeverGrowsWhenTypingAtEdges
            hoverMessage: { value: `**Inserted by Client ${clientId}**` }
          }
        })

        // Inject color
        injectStyle(
          `history-author-style-${clientId}`,
          `.history-author-${clientId} { background-color: ${color}40; border-bottom: 2px solid ${color}; }`
        )

        textIndex += length
      }
      currentItem = currentItem.right
    }

    colorDecorationsRef.current = editor.deltaDecorations(colorDecorationsRef.current, newDecorations)
  }

  // Throttle scrubbing
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchHistory(sliderMs)
    }, 150)
    return () => clearTimeout(timer)
  }, [sliderMs, fetchHistory])

  // Cleanup
  useEffect(() => {
    return () => {
      if (bindingRef.current) bindingRef.current.destroy()
      if (docRef.current) docRef.current.destroy()
    }
  }, [])

  return (
    <div className="history-pane-container" style={{ flex: 1, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-subtle)' }}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div className="history-toolbar" style={{ padding: '10px 20px', background: 'var(--bg-surface)', display: 'flex', alignItems: 'center', gap: '20px' }}>
        <button onClick={onClose} className="conn-btn" style={{ background: 'var(--bg-elevated)', color: 'white', border: '1px solid var(--border-muted)' }}>
          ← Return to Live
        </button>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '15px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Time Travel</span>
          <input 
            type="range" 
            min={startMs} 
            max={nowMs} 
            value={sliderMs} 
            onChange={e => setSliderMs(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', color: 'var(--text-code)' }}>
            Viewing: {new Date(sliderMs).toLocaleTimeString()} ({opsCount} ops)
          </span>
        </div>
        <div className="history-legend" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Color-coded by Author
        </div>
      </div>

      {/* ── Editor ───────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, position: 'relative' }}>
        <MonacoEditor
          height="100%"
          defaultLanguage="javascript"
          theme="vs-dark"
          options={{
            readOnly: true,
            fontSize: 14,
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            minimap: { enabled: false },
            padding: { top: 16, bottom: 16 },
          }}
          onMount={(editor) => {
            editorRef.current = editor
            fetchHistory(sliderMs)
          }}
        />
      </div>
    </div>
  )
}

function injectStyle(id: string, css: string): void {
  if (typeof document === 'undefined') return
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = css
}
