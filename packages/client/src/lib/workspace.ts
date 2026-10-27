import * as Y from 'yjs'

export interface WorkspaceNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  createdAt: number
}

export interface TreeNode extends WorkspaceNode {
  children: TreeNode[]
  depth: number
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
 * Resolves effective parent-child relationships deterministically.
 * If any node's ancestor path contains a cycle due to concurrent moves across peers,
 * the edge that creates the cycle is deterministically broken by resetting that
 * node's parentId to null (root), preventing disconnected islands.
 */
export function sanitizeTreeHierarchy(nodes: WorkspaceNode[]): WorkspaceNode[] {
  const nodeMap = new Map<string, WorkspaceNode>(nodes.map((n) => [n.id, { ...n }]))

  for (const node of nodeMap.values()) {
    if (!node.parentId) continue

    // Trace ancestors
    const visited = new Set<string>([node.id])
    let curr = nodeMap.get(node.parentId)
    let hasCycle = false

    while (curr) {
      if (visited.has(curr.id)) {
        hasCycle = true
        break
      }
      visited.add(curr.id)
      curr = curr.parentId ? nodeMap.get(curr.parentId) : undefined
    }

    if (hasCycle) {
      // Deterministic conflict resolution: break cyclic link to root
      node.parentId = null
    }
  }

  return Array.from(nodeMap.values())
}

/**
 * Builds a hierarchical tree structure from flat node records.
 */
export function buildHierarchyTree(nodes: WorkspaceNode[]): TreeNode[] {
  const sanitized = sanitizeTreeHierarchy(nodes)
  const nodeMap = new Map<string, TreeNode>()

  // Sort nodes: folders first, then by name
  const sorted = [...sanitized].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const node of sorted) {
    nodeMap.set(node.id, { ...node, children: [], depth: 0 })
  }

  const roots: TreeNode[] = []

  for (const node of sorted) {
    const treeNode = nodeMap.get(node.id)!
    if (node.parentId && nodeMap.has(node.parentId)) {
      const parent = nodeMap.get(node.parentId)!
      treeNode.depth = parent.depth + 1
      parent.children.push(treeNode)
    } else {
      roots.push(treeNode)
    }
  }

  return roots
}

/**
 * Get or initialize the shared Y.Map containing the workspace file tree.
 */
export function getWorkspaceMap(doc: Y.Doc): Y.Map<WorkspaceNode> {
  return doc.getMap<WorkspaceNode>(WORKSPACE_FILES_KEY)
}

/**
 * Move a node into a new parent folder, validating against local cycles.
 */
export function moveNode(
  doc: Y.Doc,
  nodeId: string,
  newParentId: string | null
): boolean {
  const map = getWorkspaceMap(doc)
  const node = map.get(nodeId)
  if (!node) return false
  if (nodeId === newParentId) return false

  if (newParentId) {
    const allNodes = new Map<string, WorkspaceNode>()
    map.forEach((n) => allNodes.set(n.id, n))
    if (isDescendant(allNodes, newParentId, nodeId)) {
      return false // Cannot move into own descendant
    }
  }

  doc.transact(() => {
    map.set(nodeId, { ...node, parentId: newParentId })
  })
  return true
}

/**
 * Seed starter files if workspace is empty
 */
export function initializeStarterWorkspace(doc: Y.Doc): void {
  const map = getWorkspaceMap(doc)
  if (map.size > 0) return

  doc.transact(() => {
    // 1. src folder
    const srcFolder: WorkspaceNode = {
      id: 'folder-src',
      name: 'src',
      type: 'folder',
      parentId: null,
      createdAt: Date.now(),
    }
    map.set(srcFolder.id, srcFolder)

    // 2. index.ts inside src
    const indexNode: WorkspaceNode = {
      id: 'file-index-ts',
      name: 'index.ts',
      type: 'file',
      parentId: 'folder-src',
      createdAt: Date.now() + 1,
    }
    map.set(indexNode.id, indexNode)

    const indexText = doc.getText('file:file-index-ts')
    if (indexText.length === 0) {
      indexText.insert(
        0,
        `// Converge Multi-File Collaborative IDE
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

    // 3. vectorClock.ts inside src
    const vcNode: WorkspaceNode = {
      id: 'file-vector-clock-ts',
      name: 'vectorClock.ts',
      type: 'file',
      parentId: 'folder-src',
      createdAt: Date.now() + 2,
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

    // 4. README.md in root
    const docNode: WorkspaceNode = {
      id: 'file-readme-md',
      name: 'README.md',
      type: 'file',
      parentId: null,
      createdAt: Date.now() + 3,
    }
    map.set(docNode.id, docNode)

    const docText = doc.getText('file:file-readme-md')
    if (docText.length === 0) {
      docText.insert(
        0,
        `# Converge Collaborative Workspace

This workspace demonstrates multi-file collaborative editing via sequence CRDTs:
- Folders and files possess immutable UUIDs independent of mutable paths.
- Edits in any file synchronize independently without blocking sibling documents.
- Cycles caused by concurrent folder moves are deterministically resolved to root.
`
      )
    }
  })
}
