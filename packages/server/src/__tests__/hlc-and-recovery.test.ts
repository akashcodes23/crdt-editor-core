import * as Y from 'yjs'
import { generateHLC } from '../hlc'

describe('Hybrid Logical Clock & Snapshot Recovery Tests', () => {
  it('Test 1: HLC Monotonicity and Lexical Sortability', () => {
    const timestamps: string[] = []
    
    // Generate rapid timestamps
    for (let i = 0; i < 50; i++) {
      timestamps.push(generateHLC('server1'))
    }

    // Verify strict monotonicity: each timestamp is strictly greater than previous
    for (let i = 1; i < timestamps.length; i++) {
      const prev = timestamps[i - 1]
      const curr = timestamps[i]
      expect(curr > prev).toBe(true)
      expect(curr.localeCompare(prev)).toBe(1)
    }
  })

  it('Test 2: Snapshot Compaction & Deterministic Tail Recovery', () => {
    // 1. Primary document receives 30 incremental edits
    const primaryDoc = new Y.Doc()
    const yText = primaryDoc.getText('code')
    const operations: Uint8Array[] = []

    primaryDoc.on('update', (u: Uint8Array) => {
      operations.push(new Uint8Array(u))
    })

    for (let i = 0; i < 20; i++) {
      yText.insert(yText.length, `line_${i}\n`)
    }

    // 2. Take a snapshot checkpoint at operation 20
    const snapshotCheckpoint = Y.encodeStateAsUpdate(primaryDoc)
    const cutoffOpCount = operations.length

    // 3. Document continues receiving further edits (tail operations)
    for (let i = 20; i < 30; i++) {
      yText.insert(yText.length, `line_${i}\n`)
    }

    const expectedFinalText = yText.toString()

    // 4. Recovery Method A: Naive replay of all 30 individual updates
    const docA = new Y.Doc()
    for (const op of operations) {
      Y.applyUpdate(docA, op)
    }

    // 5. Recovery Method B: Compacted Snapshot + Tail Operations (from cutoff onward)
    const docB = new Y.Doc()
    Y.applyUpdate(docB, snapshotCheckpoint)
    for (let i = cutoffOpCount; i < operations.length; i++) {
      Y.applyUpdate(docB, operations[i])
    }

    // 6. Assert both recovery paths yield identical document state
    expect(docA.getText('code').toString()).toBe(expectedFinalText)
    expect(docB.getText('code').toString()).toBe(expectedFinalText)
    expect(docA.getText('code').toString()).toBe(docB.getText('code').toString())
  })
})
