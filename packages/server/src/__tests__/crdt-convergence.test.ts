import * as Y from 'yjs'

// Helper: sync two docs by exchanging all updates
// This mirrors the y-websocket exchange protocol
function syncDocs(docA: Y.Doc, docB: Y.Doc): void {
  // A → B: send everything A has that B is missing
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)))
  // B → A: send everything B has that A is missing
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)))
}

describe('CRDT Convergence Tests', () => {
  it('Test 1: Concurrent inserts at same position', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    syncDocs(docA, docB)

    // Simulate offline partition
    docA.getText('code').insert(0, 'AAAAA')
    docB.getText('code').insert(0, 'BBBBB')

    // Simulate reconnect
    syncDocs(docA, docB)

    const textA = docA.getText('code').toString()
    const textB = docB.getText('code').toString()

    expect(textA).toBe(textB)
    expect(textA).toHaveLength(10)
    expect(textA).toMatch(/^(AAAAABBBBB|BBBBBAAAAA)$/)
  })

  it('Test 2: Concurrent deletes of same character', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    
    // Setup initial state
    docA.getText('code').insert(0, 'HELLO')
    syncDocs(docA, docB)

    // Simulate offline partition: both delete 'H' (index 0)
    docA.getText('code').delete(0, 1)
    docB.getText('code').delete(0, 1)

    // Simulate reconnect
    syncDocs(docA, docB)

    const textA = docA.getText('code').toString()
    const textB = docB.getText('code').toString()

    expect(textA).toBe(textB)
    expect(textA).toBe('ELLO') // Deleting same char twice converges safely
  })

  it('Test 3: Insert on A while B deletes at same position', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    
    // Setup initial state
    docA.getText('code').insert(0, 'WRLD')
    syncDocs(docA, docB)

    // Simulate offline partition
    docA.getText('code').insert(0, 'O') // A inserts 'O' at start → 'OWRLD'
    docB.getText('code').delete(0, 1)   // B deletes 'W' at start → 'RLD'

    // Simulate reconnect
    syncDocs(docA, docB)

    const textA = docA.getText('code').toString()
    const textB = docB.getText('code').toString()

    expect(textA).toBe(textB)
    // The result should contain the new char 'O' and missing the deleted char 'W'
    expect(textA).toBe('ORLD')
  })

  it('Test 4: Both clients type identical text offline', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    syncDocs(docA, docB)

    // Both type identical string "hello"
    docA.getText('code').insert(0, 'hello')
    docB.getText('code').insert(0, 'hello')

    syncDocs(docA, docB)

    const textA = docA.getText('code').toString()
    const textB = docB.getText('code').toString()

    expect(textA).toBe(textB)
    // Because it's a sequence CRDT, identical characters without shared history
    // are treated as distinct operations and are duplicated.
    expect(textA).toBe('hellohello')
  })

  it('Test 5: Rapid sequential edits (100 ops, then sync)', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    syncDocs(docA, docB)

    for (let i = 0; i < 50; i++) {
      docA.getText('code').insert(i, 'A')
      docA.getText('code').delete(0, 1)
      docA.getText('code').insert(0, 'B')
    }

    for (let i = 0; i < 50; i++) {
      docB.getText('code').insert(i, 'C')
      docB.getText('code').delete(0, 1)
      docB.getText('code').insert(0, 'D')
    }

    syncDocs(docA, docB)

    const textA = docA.getText('code').toString()
    const textB = docB.getText('code').toString()

    expect(textA).toBe(textB)
    
    // We inserted 50 and deleted 50 on each, so net +50 for each → length should be 100
    // Actually, on docA: insert(i, 'A'), delete(0,1), insert(0, 'B'). So net +1 each loop. -> length = 50.
    // docA adds 50 chars, docB adds 50 chars. Total length = 100.
    expect(textA).toHaveLength(100)
  })
})
