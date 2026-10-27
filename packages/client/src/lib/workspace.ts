import * as Y from 'yjs'

export interface WorkspaceNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  createdAt: number
}

export const WORKSPACE_FILES_KEY = 'workspace:files'

/**
 * Detect language based on file extension for Monaco Editor
 */
export function detectLanguage(filename: string): string {
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return 'typescript'
  if (filename.endsWith('.js') || filename.endsWith('.jsx')) return 'javascript'
  if (filename.endsWith('.py')) return 'python'
  if (filename.endsWith('.json')) return 'json'
  if (filename.endsWith('.md')) return 'markdown'
  if (filename.endsWith('.css')) return 'css'
  if (filename.endsWith('.html')) return 'html'
  return 'plaintext'
}

/**
 * Returns true if candidateChildId is equal to or a descendant of ancestorId.
 * Used to prevent circular folder parenting cycles.
 */
export function isDescendant(
  nodes: Map<string, WorkspaceNode>,
  candidateChildId: string,
  ancestorId: string
): boolean {
  if (candidateChildId === ancestorId) return true
  let curr = nodes.get(candidateChildId)
  const visited = new Set<string>()

  while (curr && curr.parentId) {
    if (curr.parentId === ancestorId) return true
    if (visited.has(curr.parentId)) break // cycle detected in graph
    visited.add(curr.parentId)
    curr = nodes.get(curr.parentId)
  }
  return false
}

/**
 * Get or initialize the shared Y.Map containing the workspace file tree.
 */
export function getWorkspaceMap(doc: Y.Doc): Y.Map<WorkspaceNode> {
  return doc.getMap<WorkspaceNode>(WORKSPACE_FILES_KEY)
}

/**
 * Seed starter files if workspace is empty
 */
export function initializeStarterWorkspace(doc: Y.Doc): void {
  const map = getWorkspaceMap(doc)
  if (map.size > 0) return

  doc.transact(() => {
    // 1. main entrypoint
    const indexNode: WorkspaceNode = {
      id: 'file-index-ts',
      name: 'index.ts',
      type: 'file',
      parentId: null,
      createdAt: Date.now(),
    }
    map.set(indexNode.id, indexNode)

    const indexText = doc.getText('file:file-index-ts')
    if (indexText.length === 0) {
      indexText.insert(
        0,
        `// Converge Collaborative IDE
import { VectorClock } from './vectorClock'

function main() {
  const clock = new VectorClock('peer-1')
  clock.tick()
  console.log('CRDT Engine initialized:', clock.toString())
}

main()
`
      )
    }

    // 2. vector clock helper
    const vcNode: WorkspaceNode = {
      id: 'file-vector-clock-ts',
      name: 'vectorClock.ts',
      type: 'file',
      parentId: null,
      createdAt: Date.now() + 1,
    }
    map.set(vcNode.id, vcNode)

    const vcText = doc.getText('file:file-vector-clock-ts')
    if (vcText.length === 0) {
      vcText.insert(
        0,
        `export class VectorClock {
  private clock: Map<string, number> = new Map()

  constructor(public readonly nodeId: string) {
    this.clock.set(nodeId, 0)
  }

  tick(): void {
    const current = this.clock.get(this.nodeId) || 0
    this.clock.set(this.nodeId, current + 1)
  }

  toString(): string {
    return JSON.stringify(Object.fromEntries(this.clock))
  }
}
`
      )
    }

    // 3. docs markdown file
    const docNode: WorkspaceNode = {
      id: 'file-readme-md',
      name: 'README.md',
      type: 'file',
      parentId: null,
      createdAt: Date.now() + 2,
    }
    map.set(docNode.id, docNode)

    const docText = doc.getText('file:file-readme-md')
    if (docText.length === 0) {
      docText.insert(
        0,
        `# Converge Workspace

This workspace demonstrates multi-file collaborative editing via sequence CRDTs.
- Edits in any file are synchronized independently across connected peers.
- Switch tabs or create new files in the explorer sidebar.
`
      )
    }
  })
}
