import * as Y from 'yjs'
import { HybridLogicalClock, generateHLC } from '../hlc'

// Helper to simulate a network transport exchange between 2 or more replicas
function exchangeUpdates(docA: Y.Doc, docB: Y.Doc): void {
  const updateA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB))
  const updateB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA))
  Y.applyUpdate(docB, updateA)
  Y.applyUpdate(docA, updateB)
}

describe('Distributed Synchronization & Correctness Suite', () => {
  describe('1. Multi-Client Eventual Consistency & Partitions', () => {
    it('Scenario 1: 3-Client concurrent edits converge under arbitrary network partition & heal', () => {
      const client1 = new Y.Doc()
      const client2 = new Y.Doc()
      const client3 = new Y.Doc()

      // Initial state synced
      client1.getText('code').insert(0, 'INIT;')
      exchangeUpdates(client1, client2)
      exchangeUpdates(client2, client3)

      // Network partition: Client 1 and Client 2 can communicate, Client 3 is isolated
      client1.getText('code').insert(5, 'C1_EDIT;')
      client2.getText('code').insert(5, 'C2_EDIT;')
      exchangeUpdates(client1, client2)

      // Client 3 makes edits in isolation
      client3.getText('code').insert(5, 'C3_ISOLATED;')

      // Partition heals: Exchange updates across all peers
      exchangeUpdates(client1, client3)
      exchangeUpdates(client2, client3)
      exchangeUpdates(client1, client2)

      const s1 = client1.getText('code').toString()
      const s2 = client2.getText('code').toString()
      const s3 = client3.getText('code').toString()

      // Strong Eventual Consistency: all three replicas must have identical state
      expect(s1).toBe(s2)
      expect(s2).toBe(s3)
      expect(s1).toContain('INIT;')
      expect(s1).toContain('C1_EDIT;')
      expect(s1).toContain('C2_EDIT;')
      expect(s1).toContain('C3_ISOLATED;')
    })

    it('Scenario 2: Duplicate update delivery is idempotent', () => {
      const docA = new Y.Doc()
      const docB = new Y.Doc()

      docA.getText('code').insert(0, 'HELLO')
      const update = Y.encodeStateAsUpdate(docA)

      // Apply the exact same update 5 times to docB
      Y.applyUpdate(docB, update)
      Y.applyUpdate(docB, update)
      Y.applyUpdate(docB, update)
      Y.applyUpdate(docB, update)
      Y.applyUpdate(docB, update)

      expect(docB.getText('code').toString()).toBe('HELLO')
    })

    it('Scenario 3: Out-of-order update delivery reconciles correctly', () => {
      const docSource = new Y.Doc()
      const docTarget = new Y.Doc()

      const updates: Uint8Array[] = []
      docSource.on('update', (u: Uint8Array) => {
        updates.push(new Uint8Array(u))
      })

      // Produce 4 sequential updates
      docSource.getText('code').insert(0, 'A')
      docSource.getText('code').insert(1, 'B')
      docSource.getText('code').insert(2, 'C')
      docSource.getText('code').insert(3, 'D')

      // Deliver updates in reverse order: 3, 2, 1, 0
      for (let i = updates.length - 1; i >= 0; i--) {
        Y.applyUpdate(docTarget, updates[i])
      }

      expect(docTarget.getText('code').toString()).toBe('ABCD')
    })
  })

  describe('2. Hybrid Logical Clock Causal Ordering', () => {
    it('Scenario 4: Causal chain A -> B -> C preserves strictly increasing HLC', () => {
      const clockA = new HybridLogicalClock('nodeA')
      const clockB = new HybridLogicalClock('nodeB')
      const clockC = new HybridLogicalClock('nodeC')

      // Event 1 on Node A
      const hlc1 = clockA.now(1000)

      // Node B receives event 1 from Node A and generates event 2
      const hlc2 = clockB.update(hlc1, 1000)

      // Node C receives event 2 from Node B and generates event 3
      const hlc3 = clockC.update(hlc2, 1000)

      expect(hlc1 < hlc2).toBe(true)
      expect(hlc2 < hlc3).toBe(true)
      expect(HybridLogicalClock.compare(hlc1, hlc2)).toBe(-1)
      expect(HybridLogicalClock.compare(hlc2, hlc3)).toBe(-1)
    })

    it('Scenario 5: Physical clock regression does not invert causality', () => {
      const clock = new HybridLogicalClock('node1')

      // Time moves backwards from 2000ms to 1500ms (NTP step)
      const t1 = clock.now(2000)
      const t2 = clock.now(1500)
      const t3 = clock.now(1500)

      expect(t1 < t2).toBe(true)
      expect(t2 < t3).toBe(true)

      const parsed1 = HybridLogicalClock.parse(t1)
      const parsed2 = HybridLogicalClock.parse(t2)
      const parsed3 = HybridLogicalClock.parse(t3)

      expect(parsed1.counter).toBe(0)
      expect(parsed2.counter).toBe(1)
      expect(parsed3.counter).toBe(2)
      expect(parsed2.wallTime).toBe(2000) // Preserves max observed physical time
    })
  })

  describe('3. Historical Replay & Compaction Semantics', () => {
    it('Scenario 6: Deterministic historical state reconstruction at intermediate HLC points', () => {
      const primaryDoc = new Y.Doc()
      const yText = primaryDoc.getText('code')

      interface OperationRecord {
        hlc: string
        update: Uint8Array
      }
      const log: OperationRecord[] = []

      primaryDoc.on('update', (u: Uint8Array) => {
        log.push({
          hlc: generateHLC('server'),
          update: new Uint8Array(u),
        })
      })

      // 1. Initial commit
      yText.insert(0, 'const x = 1;\n')
      const hlcCheckpoint1 = log[log.length - 1].hlc

      // 2. Second commit
      yText.insert(yText.length, 'const y = 2;\n')
      const hlcCheckpoint2 = log[log.length - 1].hlc

      // 3. Third commit
      yText.insert(yText.length, 'console.log(x + y);\n')

      // Replay state up to Checkpoint 1
      const replayDoc1 = new Y.Doc()
      for (const entry of log) {
        if (entry.hlc <= hlcCheckpoint1) {
          Y.applyUpdate(replayDoc1, entry.update)
        }
      }
      expect(replayDoc1.getText('code').toString()).toBe('const x = 1;\n')

      // Replay state up to Checkpoint 2
      const replayDoc2 = new Y.Doc()
      for (const entry of log) {
        if (entry.hlc <= hlcCheckpoint2) {
          Y.applyUpdate(replayDoc2, entry.update)
        }
      }
      expect(replayDoc2.getText('code').toString()).toBe('const x = 1;\nconst y = 2;\n')
    })
  })
})
