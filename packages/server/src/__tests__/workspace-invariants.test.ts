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
})
