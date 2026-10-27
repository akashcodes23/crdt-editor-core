'use client'

import { useState } from 'react'
import { WorkspaceNode } from '@/lib/workspace'

interface FileExplorerProps {
  nodes: WorkspaceNode[]
  activeFileId: string | null
  onSelectFile: (fileId: string) => void
  onCreateNode: (name: string, type: 'file' | 'folder', parentId: string | null) => void
  onDeleteNode: (nodeId: string) => void
  onRenameNode: (nodeId: string, newName: string) => void
}

export function FileExplorer({
  nodes,
  activeFileId,
  onSelectFile,
  onCreateNode,
  onDeleteNode,
  onRenameNode,
}: FileExplorerProps) {
  const [isCreating, setIsCreating] = useState<'file' | 'folder' | null>(null)
  const [newNodeName, setNewNodeName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newNodeName.trim() || !isCreating) return
    onCreateNode(newNodeName.trim(), isCreating, null)
    setNewNodeName('')
    setIsCreating(null)
  }

  const handleRenameSubmit = (id: string, e: React.FormEvent) => {
    e.preventDefault()
    if (!renameVal.trim()) return
    onRenameNode(id, renameVal.trim())
    setRenamingId(null)
  }

  const getIcon = (node: WorkspaceNode) => {
    if (node.type === 'folder') return '📁'
    if (node.name.endsWith('.ts') || node.name.endsWith('.tsx')) return '🔷'
    if (node.name.endsWith('.js') || node.name.endsWith('.jsx')) return '🟨'
    if (node.name.endsWith('.json')) return '🔣'
    if (node.name.endsWith('.md')) return '📝'
    if (node.name.endsWith('.py')) return '🐍'
    return '📄'
  }

  return (
    <div className="file-explorer" style={{
      width: '180px',
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      fontSize: '12px',
      userSelect: 'none',
      flexShrink: 0
    }}>
      {/* Explorer Header */}
      <div style={{
        padding: '6px 10px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: '1px solid var(--border-subtle)',
        color: 'var(--text-muted)',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em'
      }}>
        <span>Files</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={() => { setIsCreating('file'); setNewNodeName('') }}
            title="New File"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '2px 4px' }}
          >
            +📄
          </button>
        </div>
      </div>

      {/* Inline Create Input */}
      {isCreating && (
        <form onSubmit={handleCreateSubmit} style={{ padding: '4px 8px' }}>
          <input
            autoFocus
            type="text"
            placeholder={`new-${isCreating}...`}
            value={newNodeName}
            onChange={(e) => setNewNodeName(e.target.value)}
            onBlur={() => setIsCreating(null)}
            style={{
              width: '100%',
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--accent-blue)',
              borderRadius: '3px',
              padding: '2px 6px',
              fontSize: '11px',
              outline: 'none',
            }}
          />
        </form>
      )}

      {/* Nodes List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {nodes.map((node) => {
          const isActive = node.id === activeFileId
          const isRenaming = node.id === renamingId

          return (
            <div
              key={node.id}
              onClick={() => {
                if (node.type === 'file') onSelectFile(node.id)
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '4px 8px',
                cursor: 'pointer',
                background: isActive ? 'var(--bg-elevated)' : 'transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderLeft: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
              }}
            >
              <span style={{ marginRight: '6px' }}>{getIcon(node)}</span>

              {isRenaming ? (
                <form
                  onSubmit={(e) => handleRenameSubmit(node.id, e)}
                  style={{ flex: 1 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    autoFocus
                    type="text"
                    value={renameVal}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onBlur={() => setRenamingId(null)}
                    style={{
                      width: '100%',
                      background: 'var(--bg-base)',
                      color: 'var(--text-primary)',
                      border: '1px solid var(--accent-blue)',
                      borderRadius: '2px',
                      padding: '1px 4px',
                      fontSize: '11px',
                    }}
                  />
                </form>
              ) : (
                <span
                  style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setRenamingId(node.id)
                    setRenameVal(node.name)
                  }}
                  title={`${node.name} (Double-click to rename)`}
                >
                  {node.name}
                </span>
              )}

              {/* Actions (delete) */}
              {nodes.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`Delete "${node.name}"?`)) onDeleteNode(node.id)
                  }}
                  title="Delete"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    padding: '0 2px',
                    opacity: 0.6,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
