'use client'

import { WorkspaceNode } from '@/lib/workspace'

interface EditorTabBarProps {
  nodes: WorkspaceNode[]
  openFileIds: string[]
  activeFileId: string | null
  onSelectTab: (fileId: string) => void
  onCloseTab: (fileId: string) => void
}

export function EditorTabBar({
  nodes,
  openFileIds,
  activeFileId,
  onSelectTab,
  onCloseTab,
}: EditorTabBarProps) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]))

  return (
    <div
      className="editor-tab-bar"
      style={{
        display: 'flex',
        background: 'var(--bg-base)',
        borderBottom: '1px solid var(--border-subtle)',
        overflowX: 'auto',
        minHeight: '32px',
        alignItems: 'stretch',
      }}
    >
      {openFileIds.map((id) => {
        const node = nodeMap.get(id)
        if (!node) return null
        const isActive = id === activeFileId

        return (
          <div
            key={id}
            onClick={() => onSelectTab(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '0 12px',
              cursor: 'pointer',
              background: isActive ? 'var(--bg-elevated)' : 'transparent',
              color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
              borderRight: '1px solid var(--border-subtle)',
              borderTop: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
              fontSize: '12px',
              fontWeight: isActive ? 600 : 400,
              userSelect: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            <span>{node.name}</span>
            {openFileIds.length > 1 && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(id)
                }}
                title="Close Tab"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                  padding: '0 2px',
                  borderRadius: '2px',
                  lineHeight: 1,
                  opacity: 0.7,
                }}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
