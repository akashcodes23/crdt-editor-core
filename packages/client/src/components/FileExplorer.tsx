'use client'

import { useState } from 'react'
import { WorkspaceNode, TreeNode, buildHierarchyTree } from '@/lib/workspace'

interface FileExplorerProps {
  nodes: WorkspaceNode[]
  activeFileId: string | null
  onSelectFile: (fileId: string) => void
  onCreateNode: (name: string, type: 'file' | 'folder', parentId: string | null) => void
  onDeleteNode: (nodeId: string) => void
  onRenameNode: (nodeId: string, newName: string) => void
  onMoveNode: (nodeId: string, newParentId: string | null) => void
}

export function FileExplorer({
  nodes,
  activeFileId,
  onSelectFile,
  onCreateNode,
  onDeleteNode,
  onRenameNode,
  onMoveNode,
}: FileExplorerProps) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [isCreating, setIsCreating] = useState<{ type: 'file' | 'folder'; parentId: string | null } | null>(null)
  const [newNodeName, setNewNodeName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [movingNodeId, setMovingNodeId] = useState<string | null>(null)

  const tree = buildHierarchyTree(nodes)
  const folders = nodes.filter((n) => n.type === 'folder')

  const toggleFolder = (folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newNodeName.trim() || !isCreating) return
    onCreateNode(newNodeName.trim(), isCreating.type, isCreating.parentId)
    setNewNodeName('')
    setIsCreating(null)
  }

  const handleRenameSubmit = (id: string, e: React.FormEvent) => {
    e.preventDefault()
    if (!renameVal.trim()) return
    onRenameNode(id, renameVal.trim())
    setRenamingId(null)
  }

  const getFileIcon = (node: WorkspaceNode) => {
    if (node.name.endsWith('.ts') || node.name.endsWith('.tsx')) return '🔷'
    if (node.name.endsWith('.js') || node.name.endsWith('.jsx')) return '🟨'
    if (node.name.endsWith('.json')) return '🔣'
    if (node.name.endsWith('.md')) return '📝'
    if (node.name.endsWith('.py')) return '🐍'
    if (node.name.endsWith('.css')) return '🎨'
    return '📄'
  }

  const renderTree = (items: TreeNode[]) => {
    return items.map((node) => {
      const isFolder = node.type === 'folder'
      const isCollapsed = collapsedFolders.has(node.id)
      const isActive = node.id === activeFileId
      const isRenaming = node.id === renamingId
      const isMoving = node.id === movingNodeId

      return (
        <div key={node.id} style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            onClick={() => {
              if (isFolder) toggleFolder(node.id)
              else onSelectFile(node.id)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '3px 6px',
              paddingLeft: `${Math.max(6, node.depth * 14 + 6)}px`,
              cursor: 'pointer',
              background: isActive ? 'var(--bg-elevated)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              borderLeft: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
              fontSize: '11.5px',
              gap: '4px',
            }}
          >
            {/* Expand / Collapse Chevron */}
            {isFolder && (
              <span style={{ fontSize: '9px', width: '10px', color: 'var(--text-muted)' }}>
                {isCollapsed ? '▶' : '▼'}
              </span>
            )}

            <span>{isFolder ? (isCollapsed ? '📁' : '📂') : getFileIcon(node)}</span>

            {/* In-place rename form */}
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

            {/* Actions: Add file to folder, move, delete */}
            <div
              style={{ display: 'flex', gap: '2px', opacity: 0.7 }}
              onClick={(e) => e.stopPropagation()}
            >
              {isFolder && (
                <button
                  onClick={() => setIsCreating({ type: 'file', parentId: node.id })}
                  title="New File Inside Folder"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', padding: '0 2px' }}
                >
                  +📄
                </button>
              )}

              {/* Move Node Selector */}
              {isMoving ? (
                <select
                  autoFocus
                  defaultValue={node.parentId || ''}
                  onChange={(e) => {
                    const newParent = e.target.value === '' ? null : e.target.value
                    onMoveNode(node.id, newParent)
                    setMovingNodeId(null)
                  }}
                  onBlur={() => setMovingNodeId(null)}
                  style={{
                    background: 'var(--bg-base)',
                    color: 'var(--text-primary)',
                    fontSize: '10px',
                    border: '1px solid var(--accent-blue)',
                    borderRadius: '2px',
                  }}
                >
                  <option value="">(Root)</option>
                  {folders
                    .filter((f) => f.id !== node.id)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        📁 {f.name}
                      </option>
                    ))}
                </select>
              ) : (
                <button
                  onClick={() => setMovingNodeId(node.id)}
                  title="Move to folder..."
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '10px', color: 'var(--text-muted)' }}
                >
                  ↗
                </button>
              )}

              {/* Delete Node */}
              {nodes.length > 1 && (
                <button
                  onClick={() => {
                    if (confirm(`Delete "${node.name}"?`)) onDeleteNode(node.id)
                  }}
                  title="Delete"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', color: 'var(--text-muted)' }}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* Children nodes if folder is expanded */}
          {isFolder && !isCollapsed && node.children.length > 0 && renderTree(node.children)}
        </div>
      )
    })
  }

  return (
    <div
      className="file-explorer"
      style={{
        width: '200px',
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        fontSize: '12px',
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      {/* Explorer Header */}
      <div
        style={{
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border-subtle)',
          color: 'var(--text-muted)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        <span>Explorer</span>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={() => {
              setIsCreating({ type: 'file', parentId: null })
              setNewNodeName('')
            }}
            title="New File in Root"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '2px' }}
          >
            +📄
          </button>
          <button
            onClick={() => {
              setIsCreating({ type: 'folder', parentId: null })
              setNewNodeName('')
            }}
            title="New Folder in Root"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '2px' }}
          >
            +📁
          </button>
        </div>
      </div>

      {/* Inline Create Input */}
      {isCreating && (
        <form onSubmit={handleCreateSubmit} style={{ padding: '4px 8px' }}>
          <input
            autoFocus
            type="text"
            placeholder={`new-${isCreating.type}...`}
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

      {/* Hierarchical Tree List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>{renderTree(tree)}</div>
    </div>
  )
}
