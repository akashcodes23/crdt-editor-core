'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type monaco from 'monaco-editor'
import { MonacoBinding } from 'y-monaco'
import { ConnectionStatusBadge } from './ConnectionStatus'
import { VectorClockSidebar } from './VectorClockSidebar'
import { CursorOverlay } from './CursorOverlay'
import { useYDoc } from '@/hooks/useYDoc'
import { useAwareness, setAwarenessCursor } from '@/hooks/useAwareness'
import { useVectorClock } from '@/hooks/useVectorClock'
import { getSharedText } from '@/lib/yjs'
import { colorFromClientId } from '@/lib/colors'

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <div className="editor-loading">Loading editor…</div>,
})

interface EditorPaneProps {
  clientLabel: string
  displayName: string
  side: 'left' | 'right'
}

export function EditorPane({ clientLabel, displayName, side }: EditorPaneProps) {
  const {
    doc, provider, status,
    disconnect, reconnect, startChaos,
    chaos, mergeFlashRange, clearMergeFlash, syncBytes,
  } = useYDoc(clientLabel)

  const remoteStates = useAwareness(provider, displayName)
  const vcEntries    = useVectorClock(doc, doc?.clientID ?? null)
  const editorRef    = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const bindingRef   = useRef<MonacoBinding | null>(null)
  const [monacoReady, setMonacoReady] = useState(false)

  const handleEditorMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor
      setMonacoReady(true)
      editor.onDidChangeCursorSelection((e) => {
        const model = editor.getModel()
        if (!model) return
        const sel = e.selection
        setAwarenessCursor(provider, {
          index:  model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn }),
          length: model.getOffsetAt({ lineNumber: sel.endLineNumber,   column: sel.endColumn }) -
                  model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn }),
        })
      })
    },
    [provider]
  )

  useEffect(() => {
    if (!doc || !provider || !editorRef.current || !monacoReady) return
    const yText   = getSharedText(doc)
    const binding = new MonacoBinding(
      yText, editorRef.current.getModel()!,
      new Set([editorRef.current]), provider.awareness
    )
    bindingRef.current = binding
    return () => { binding.destroy(); bindingRef.current = null }
  }, [doc, provider, monacoReady])

  const accentColor  = doc ? colorFromClientId(doc.clientID * (side === 'left' ? 1 : 3)) : '#6ee7b7'
  const isChaosOffline = chaos.active && status === 'disconnected'

  return (
    <div className={`editor-pane editor-pane--${side}${isChaosOffline ? ' editor-pane--chaos' : ''}`}>
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="pane-header" style={{ borderTopColor: accentColor }}>
        <div className="pane-header-left">
          <span className="pane-dot" style={{ background: accentColor }} />
          <span className="pane-name">{displayName}</span>
          {doc && (
            <code className="pane-clientid" title="Yjs clientID">
              #{doc.clientID}
            </code>
          )}
          {/* Diverged char counter in the header too (visible without scrolling) */}
          {isChaosOffline && chaos.divergedChars > 0 && (
            <span className="pane-diverge-pill">
              {chaos.divergedChars} unseen edit{chaos.divergedChars !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <ConnectionStatusBadge
          status={status}
          chaos={chaos}
          onDisconnect={disconnect}
          onReconnect={reconnect}
          onStartChaos={startChaos}
          label={displayName}
        />
      </div>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="pane-body">
        <div className="editor-wrapper">
          {doc ? (
            <MonacoEditor
              height="100%"
              defaultLanguage="javascript"
              theme="vs-dark"
              options={{
                fontSize: 14,
                fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                fontLigatures: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: 'on',
                renderLineHighlight: 'gutter',
                cursorBlinking: 'smooth',
                cursorSmoothCaretAnimation: 'on',
                smoothScrolling: true,
                padding: { top: 16, bottom: 16 },
                wordWrap: 'on',
              }}
              onMount={handleEditorMount}
            />
          ) : (
            <div className="editor-loading">Initialising CRDT…</div>
          )}
          <CursorOverlay
            editor={editorRef.current}
            remoteStates={remoteStates}
            mergeFlashRange={mergeFlashRange}
            onFlashComplete={clearMergeFlash}
          />
        </div>

        <VectorClockSidebar
          entries={vcEntries}
          localClientId={doc?.clientID ?? null}
          userName={displayName}
          syncBytes={syncBytes}
        />
      </div>
    </div>
  )
}
