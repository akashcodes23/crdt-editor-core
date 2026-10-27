import * as Y from 'yjs'

interface WorkspaceNode {
  id: string
  name: string
  type: 'file' | 'folder'
  parentId: string | null
  createdAt: number
}

const WORKSPACE_KEY = 'workspace:files'

function isDescendant(
  nodes: Map<string, WorkspaceNode>,
  candidateChildId: string,
  ancestorId: string
): boolean {
  if (candidateChildId === ancestorId) return true
  let curr = nodes.get(candidateChildId)
  const visited = new Set<string>()

  while (curr && curr.parentId) {
    if (curr.parentId === ancestorId) return true
    if (visited.has(curr.parentId)) break
    visited.add(curr.parentId)
    curr = nodes.get(curr.parentId)
  }
  return false
}

function sanitizeTreeHierarchy(nodes: WorkspaceNode[]): WorkspaceNode[] {
  const nodeMap = new Map<string, WorkspaceNode>(nodes.map((n) => [n.id, { ...n }]))

  for (const node of nodeMap.values()) {
    if (!node.parentId) continue

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
      node.parentId = null // Deterministically break cycle to root
    }
  }

  return Array.from(nodeMap.values())
}

function syncDocs(docA: Y.Doc, docB: Y.Doc): void {
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)))
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)))
}

describe('Workspace File Tree CRDT & Invariant Tests', () => {
  it('Test 1: Concurrent file creation converges deterministically', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    syncDocs(docA, docB)

    const mapA = docA.getMap<WorkspaceNode>(WORKSPACE_KEY)
    const mapB = docB.getMap<WorkspaceNode>(WORKSPACE_KEY)

    // Peer A creates file-1
    mapA.set('f1', {
      id: 'f1',
      name: 'server.ts',
      type: 'file',
      parentId: null,
      createdAt: 100,
    })

    // Peer B concurrently creates file-2
    mapB.set('f2', {
      id: 'f2',
      name: 'client.ts',
      type: 'file',
      parentId: null,
      createdAt: 101,
    })

    syncDocs(docA, docB)

    expect(mapA.size).toBe(2)
    expect(mapB.size).toBe(2)
    expect(mapA.get('f1')?.name).toBe('server.ts')
    expect(mapA.get('f2')?.name).toBe('client.ts')
    expect(mapB.get('f1')?.name).toBe('server.ts')
    expect(mapB.get('f2')?.name).toBe('client.ts')
  })

  it('Test 2: Concurrent file rename and content edit in separate CRDT subtrees', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const mapA = docA.getMap<WorkspaceNode>(WORKSPACE_KEY)
    mapA.set('f1', {
      id: 'f1',
      name: 'initial.ts',
      type: 'file',
      parentId: null,
      createdAt: 100,
    })
    docA.getText('file:f1').insert(0, 'console.log("hello")')

    syncDocs(docA, docB)

    // Peer A renames the file
    mapA.set('f1', {
      id: 'f1',
      name: 'renamed.ts',
      type: 'file',
      parentId: null,
      createdAt: 100,
    })

    // Peer B concurrently edits the file content at the end of the text
    const mapB = docB.getMap<WorkspaceNode>(WORKSPACE_KEY)
    const textB = docB.getText('file:f1')
    textB.insert(textB.length, '; process.exit(0)')

    syncDocs(docA, docB)

    // Both peers converge to renamed file AND merged content
    expect(mapA.get('f1')?.name).toBe('renamed.ts')
    expect(mapB.get('f1')?.name).toBe('renamed.ts')
    expect(docA.getText('file:f1').toString()).toBe('console.log("hello"); process.exit(0)')
    expect(docB.getText('file:f1').toString()).toBe('console.log("hello"); process.exit(0)')
  })

  it('Test 3: Invariant - Acyclic folder parenting validation', () => {
    const nodes = new Map<string, WorkspaceNode>()
    nodes.set('dir1', { id: 'dir1', name: 'src', type: 'folder', parentId: null, createdAt: 1 })
    nodes.set('dir2', { id: 'dir2', name: 'components', type: 'folder', parentId: 'dir1', createdAt: 2 })
    nodes.set('dir3', { id: 'dir3', name: 'buttons', type: 'folder', parentId: 'dir2', createdAt: 3 })

    // Normal descent checks: dir3 is descendant of dir1
    expect(isDescendant(nodes, 'dir3', 'dir1')).toBe(true)
    expect(isDescendant(nodes, 'dir2', 'dir1')).toBe(true)

    // Invariant check: Attempting to make dir1 a child of dir3 would create a cycle (src -> components -> buttons -> src)
    const wouldCreateCycle = isDescendant(nodes, 'dir3', 'dir1')
    expect(wouldCreateCycle).toBe(true)
  })

  it('Test 4: Invariant - Concurrent cyclic moves deterministically break to root', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const mapA = docA.getMap<WorkspaceNode>(WORKSPACE_KEY)
    const mapB = docB.getMap<WorkspaceNode>(WORKSPACE_KEY)

    mapA.set('dirA', { id: 'dirA', name: 'FolderA', type: 'folder', parentId: null, createdAt: 1 })
    mapA.set('dirB', { id: 'dirB', name: 'FolderB', type: 'folder', parentId: null, createdAt: 2 })
    syncDocs(docA, docB)

    // Concurrent move partition:
    // Peer A moves FolderA into FolderB
    mapA.set('dirA', { id: 'dirA', name: 'FolderA', type: 'folder', parentId: 'dirB', createdAt: 1 })

    // Peer B moves FolderB into FolderA
    mapB.set('dirB', { id: 'dirB', name: 'FolderB', type: 'folder', parentId: 'dirA', createdAt: 2 })

    // Sync partitions
    syncDocs(docA, docB)

    // Both documents have converged to the identical map entries
    const rawNodesA = Array.from(mapA.values())
    const rawNodesB = Array.from(mapB.values())
    expect(rawNodesA).toEqual(rawNodesB)

    // Effective tree sanitizer detects and resolves cycle deterministically:
    const sanitizedA = sanitizeTreeHierarchy(rawNodesA)
    const sanitizedB = sanitizeTreeHierarchy(rawNodesB)
    expect(sanitizedA).toEqual(sanitizedB)

    // Verify neither folder is lost and the cycle has been broken
    const nodeA = sanitizedA.find((n) => n.id === 'dirA')
    const nodeB = sanitizedA.find((n) => n.id === 'dirB')
    expect(nodeA).toBeDefined()
    expect(nodeB).toBeDefined()
    // At least one parentId must be null to prevent infinite loop
    expect(nodeA?.parentId === null || nodeB?.parentId === null).toBe(true)
  })

  it('Test 5: Invariant - Duplicate file names preserve distinct UUID document identities', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const mapA = docA.getMap<WorkspaceNode>(WORKSPACE_KEY)
    const mapB = docB.getMap<WorkspaceNode>(WORKSPACE_KEY)

    // Both peers independently create a file named 'config.json'
    mapA.set('file-uuid-1', { id: 'file-uuid-1', name: 'config.json', type: 'file', parentId: null, createdAt: 100 })
    docA.getText('file:file-uuid-1').insert(0, '{"port": 80}')

    mapB.set('file-uuid-2', { id: 'file-uuid-2', name: 'config.json', type: 'file', parentId: null, createdAt: 101 })
    docB.getText('file:file-uuid-2').insert(0, '{"port": 443}')

    syncDocs(docA, docB)

    // Both files coexist without data loss because identity is based on UUID, not filename
    expect(mapA.size).toBe(2)
    expect(mapB.size).toBe(2)
    expect(docA.getText('file:file-uuid-1').toString()).toBe('{"port": 80}')
    expect(docA.getText('file:file-uuid-2').toString()).toBe('{"port": 443}')
    expect(docB.getText('file:file-uuid-1').toString()).toBe('{"port": 80}')
    expect(docB.getText('file:file-uuid-2').toString()).toBe('{"port": 443}')
  })
})
