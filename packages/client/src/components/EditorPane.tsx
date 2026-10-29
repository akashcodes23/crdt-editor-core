'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type monaco from 'monaco-editor'
import { MonacoBinding } from 'y-monaco'
import { ConnectionStatusBadge } from './ConnectionStatus'
import { VectorClockSidebar } from './VectorClockSidebar'
import { CursorOverlay } from './CursorOverlay'
import { FileExplorer } from './FileExplorer'
import { EditorTabBar } from './EditorTabBar'
import { useYDoc } from '@/hooks/useYDoc'
import { useAwareness, setAwarenessCursor } from '@/hooks/useAwareness'
import { useVectorClock } from '@/hooks/useVectorClock'
import { colorFromClientId } from '@/lib/colors'
import {
  WorkspaceNode,
  getWorkspaceMap,
  initializeStarterWorkspace,
  detectLanguage,
  moveNode,
} from '@/lib/workspace'
import {
  SemanticGuardPipeline,
  SemanticDiagnostic,
  WorkspaceFileSnapshot,
} from '@/lib/semantic-guard'

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
    doc, provider, status, saveState, retryFailedUpdates,
    disconnect, reconnect, startChaos,
    chaos, mergeFlashRange, clearMergeFlash, syncBytes,
  } = useYDoc(clientLabel)

  const remoteStates = useAwareness(provider, displayName)
  const vcEntries    = useVectorClock(doc, doc?.clientID ?? null)
  const editorRef    = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const bindingRef   = useRef<MonacoBinding | null>(null)
  const [monacoReady, setMonacoReady] = useState(false)

  // ── Multi-file state ────────────────────────────────────────────────────────
  const [nodes, setNodes] = useState<WorkspaceNode[]>([])
  const [openFileIds, setOpenFileIds] = useState<string[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)

  // ── Semantic Guard state ───────────────────────────────────────────────────
  const [diagnostics, setDiagnostics] = useState<SemanticDiagnostic[]>([])
  const pipelineRef = useRef<SemanticGuardPipeline | null>(null)

  // Initialize workspace map & subscribe to remote file tree changes
  useEffect(() => {
    if (!doc) return
    const wsMap = getWorkspaceMap(doc)

    // Seed starter files if empty
    initializeStarterWorkspace(doc)

    const syncNodes = () => {
      const arr: WorkspaceNode[] = []
      wsMap.forEach((node) => arr.push(node))
      arr.sort((a, b) => a.createdAt - b.createdAt)
      setNodes(arr)

      // Ensure at least one file is active if none is selected
      if (arr.length > 0) {
        setOpenFileIds((prev) => {
          if (prev.length === 0) return [arr[0].id]
          // Filter out deleted files
          const valid = prev.filter((id) => wsMap.has(id))
          return valid.length > 0 ? valid : [arr[0].id]
        })
        setActiveFileId((curr) => {
          if (curr && wsMap.has(curr)) return curr
          return arr[0].id
        })
      }
    }

    syncNodes()
    wsMap.observe(syncNodes)
    return () => {
      wsMap.unobserve(syncNodes)
    }
  }, [doc])

  // Handle Monaco mounting
  const handleEditorMount = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      editorRef.current = editor
      setMonacoReady(true)

      editor.onDidChangeCursorSelection((e) => {
        const model = editor.getModel()
        if (!model) return
        const sel = e.selection
        setAwarenessCursor(provider, {
          index: model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn }),
          length:
            model.getOffsetAt({ lineNumber: sel.endLineNumber, column: sel.endColumn }) -
            model.getOffsetAt({ lineNumber: sel.startLineNumber, column: sel.startColumn }),
        })
      })
    },
    [provider]
  )

  // Bind active file to Monaco whenever activeFileId changes
  useEffect(() => {
    if (!doc || !provider || !editorRef.current || !monacoReady || !activeFileId) return

    const activeNode = nodes.find((n) => n.id === activeFileId)
    const targetKey = `file:${activeFileId}`
    const yText = doc.getText(targetKey)

    // Clean up existing binding before creating new one
    if (bindingRef.current) {
      bindingRef.current.destroy()
      bindingRef.current = null
    }

    const editor = editorRef.current
    const model = editor.getModel()

    if (model) {
      // Set Monaco syntax highlighting
      const lang = activeNode ? detectLanguage(activeNode.name) : 'plaintext'
      // Use monaco global if available or dynamic import
      const monacoGlobal = (window as any).monaco
      if (monacoGlobal && monacoGlobal.editor) {
        monacoGlobal.editor.setModelLanguage(model, lang)
      }

      const binding = new MonacoBinding(
        yText,
        model,
        new Set([editor]),
        provider.awareness
      )
      bindingRef.current = binding
    }

    return () => {
      if (bindingRef.current) {
        bindingRef.current.destroy()
        bindingRef.current = null
      }
    }
  }, [doc, provider, monacoReady, activeFileId, nodes])

  const activeFileIdRef = useRef<string | null>(activeFileId)
  useEffect(() => {
    activeFileIdRef.current = activeFileId
    if (pipelineRef.current && activeFileId) {
      setDiagnostics(pipelineRef.current.getDiagnostics(activeFileId))
    }
  }, [activeFileId])

  // ── Semantic Guard Pipeline Initialization & Merge Tracking ──────────────
  useEffect(() => {
    if (!doc) return
    const pipeline = new SemanticGuardPipeline(undefined, 250)
    pipelineRef.current = pipeline

    pipeline.onUpdate((fileId, diags) => {
      if (fileId === activeFileIdRef.current) {
        setDiagnostics(diags)
      }
    })

    const handleDocUpdate = (_u: Uint8Array, origin: any) => {
      // If update originated remotely or from partition heal, record merge event
      if (origin !== doc.clientID) {
        pipeline.recordMergeEvent({
          occurred: true,
          sourceClientId: typeof origin === 'number' ? origin : undefined,
        })
      }
    }

    doc.on('update', handleDocUpdate)

    return () => {
      doc.off('update', handleDocUpdate)
      pipeline.dispose()
      pipelineRef.current = null
    }
  }, [doc])

  // Trigger analysis when active file, monaco model, or workspace nodes change
  useEffect(() => {
    if (!doc || !activeFileId || !monacoReady || !editorRef.current) return

    const editor = editorRef.current
    const model = editor.getModel()
    const monacoGlobal = (window as any).monaco
    if (model && monacoGlobal) {
      pipelineRef.current?.bindMonaco(monacoGlobal, model)
      pipelineRef.current?.switchActiveFile(activeFileId, model)
    }

    const runAnalysis = () => {
      const fileSnapshots: WorkspaceFileSnapshot[] = nodes
        .filter((n) => n.type === 'file')
        .map((n) => ({
          id: n.id,
          name: n.name,
          content: doc.getText(`file:${n.id}`).toString(),
        }))
      pipelineRef.current?.triggerAnalysis(activeFileId, fileSnapshots)
    }

    runAnalysis()

    const yText = doc.getText(`file:${activeFileId}`)
    const handleTextChange = (_event: any, transaction: any) => {
      if (transaction && transaction.origin !== doc.clientID) {
        pipelineRef.current?.recordMergeEvent({
          occurred: true,
          sourceClientId: typeof transaction.origin === 'number' ? transaction.origin : undefined,
          changedFileIds: [activeFileId],
        })
      }
      runAnalysis()
    }

    yText.observe(handleTextChange)
    return () => {
      yText.unobserve(handleTextChange)
    }
  }, [doc, activeFileId, monacoReady, nodes])

  // File tree operations
  const handleSelectFile = (fileId: string) => {
    if (!openFileIds.includes(fileId)) {
      setOpenFileIds((prev) => [...prev, fileId])
    }
    setActiveFileId(fileId)
  }

  const handleCloseTab = (fileId: string) => {
    const nextTabs = openFileIds.filter((id) => id !== fileId)
    setOpenFileIds(nextTabs)
    if (activeFileId === fileId && nextTabs.length > 0) {
      setActiveFileId(nextTabs[nextTabs.length - 1])
    }
  }

  const handleCreateNode = (name: string, type: 'file' | 'folder', parentId: string | null) => {
    if (!doc) return
    const id = `file-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`
    const newNode: WorkspaceNode = {
      id,
      name,
      type,
      parentId,
      createdAt: Date.now(),
    }
    const wsMap = getWorkspaceMap(doc)
    doc.transact(() => {
      wsMap.set(id, newNode)
      if (type === 'file') {
        const text = doc.getText(`file:${id}`)
        text.insert(0, `// ${name}\n`)
      }
    })
    if (type === 'file') {
      handleSelectFile(id)
    }
  }

  const handleDeleteNode = (nodeId: string) => {
    if (!doc) return
    const wsMap = getWorkspaceMap(doc)
    doc.transact(() => {
      wsMap.delete(nodeId)
    })
    handleCloseTab(nodeId)
  }

  const handleRenameNode = (nodeId: string, newName: string) => {
    if (!doc) return
    const wsMap = getWorkspaceMap(doc)
    const existing = wsMap.get(nodeId)
    if (existing) {
      wsMap.set(nodeId, { ...existing, name: newName })
    }
  }

  const handleMoveNode = (nodeId: string, newParentId: string | null) => {
    if (!doc) return
    moveNode(doc, nodeId, newParentId)
  }

  const accentColor = doc ? colorFromClientId(doc.clientID * (side === 'left' ? 1 : 3)) : '#6ee7b7'
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
          {isChaosOffline && chaos.divergedChars > 0 && (
            <span className="pane-diverge-pill">
              {chaos.divergedChars} unseen edit{chaos.divergedChars !== 1 ? 's' : ''}
            </span>
          )}

          {/* Semantic Guard Status Badge */}
          {(() => {
            const confirmedCount = diagnostics.filter(
              (d) => d.category === 'CONFIRMED_CONCURRENT_CONFLICT'
            ).length
            const likelyCount = diagnostics.filter(
              (d) => d.category === 'LIKELY_CONCURRENT_CONFLICT'
            ).length
            const totalErrors = diagnostics.length

            if (confirmedCount > 0) {
              return (
                <span
                  className="pane-diverge-pill"
                  style={{ background: '#ef4444', color: '#fff', fontWeight: 600 }}
                  title={
                    diagnostics.find(
                      (d) => d.category === 'CONFIRMED_CONCURRENT_CONFLICT'
                    )?.message
                  }
                >
                  ⚠️ Semantic Conflict ({confirmedCount})
                </span>
              )
            }
            if (likelyCount > 0) {
              return (
                <span
                  className="pane-diverge-pill"
                  style={{ background: '#f59e0b', color: '#000', fontWeight: 600 }}
                  title={
                    diagnostics.find(
                      (d) => d.category === 'LIKELY_CONCURRENT_CONFLICT'
                    )?.message
                  }
                >
                  ⚡ Likely Conflict ({likelyCount})
                </span>
              )
            }
            if (totalErrors > 0) {
              return (
                <span
                  className="pane-diverge-pill"
                  style={{ background: '#f43f5e', color: '#fff' }}
                  title={`${totalErrors} diagnostic issue(s)`}
                >
                  ❌ {totalErrors} Issue{totalErrors > 1 ? 's' : ''}
                </span>
              )
            }
            return (
              <span
                className="pane-diverge-pill"
                style={{ background: '#10b981', color: '#fff' }}
                title="Semantic Guard: 0 AST errors detected"
              >
                🛡️ Clean
              </span>
            )
          })()}
        </div>
        <ConnectionStatusBadge
          status={status}
          chaos={chaos}
          onDisconnect={disconnect}
          onReconnect={reconnect}
          onStartChaos={startChaos}
          label={displayName}
          saveState={saveState}
          onRetryFailed={retryFailedUpdates}
        />
      </div>

      {/* ── Body (File Explorer + TabBar + Monaco + VectorClock) ─────────── */}
      <div className="pane-body" style={{ display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
        {/* Collaborative File Explorer */}
        <FileExplorer
          nodes={nodes}
          activeFileId={activeFileId}
          onSelectFile={handleSelectFile}
          onCreateNode={handleCreateNode}
          onDeleteNode={handleDeleteNode}
          onRenameNode={handleRenameNode}
          onMoveNode={handleMoveNode}
        />

        {/* Center: Tabs + Monaco Editor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          <EditorTabBar
            nodes={nodes}
            openFileIds={openFileIds}
            activeFileId={activeFileId}
            onSelectTab={setActiveFileId}
            onCloseTab={handleCloseTab}
          />

          <div className="editor-wrapper" style={{ flex: 1, position: 'relative' }}>
            {doc ? (
              <MonacoEditor
                height="100%"
                defaultLanguage="typescript"
                theme="vs-dark"
                options={{
                  fontSize: 13,
                  fontFamily: '"JetBrains Mono", "Fira Code", monospace',
                  fontLigatures: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  lineNumbers: 'on',
                  renderLineHighlight: 'gutter',
                  cursorBlinking: 'smooth',
                  cursorSmoothCaretAnimation: 'on',
                  smoothScrolling: true,
                  padding: { top: 12, bottom: 12 },
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
        </div>

        {/* Right Sidebar: Vector Clock & Payload Telemetry */}
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
