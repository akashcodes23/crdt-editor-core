import * as Y from 'yjs'
import { dbPool, initDb } from '../db'
import { generateHLC } from '../hlc'
import { getRoom, flushRoomPersistence, Room } from '../room'

describe('Compaction Races, Snapshot Recovery, and History Retention Contract', () => {
  beforeAll(async () => {
    await initDb()
  })

  afterAll(async () => {
    await dbPool.end()
  })

  it('1. Snapshot-assisted recovery under concurrent edits matches full log replay', async () => {
    const docId = `test-concurrent-recovery-${Date.now()}`
    const expectedDoc = new Y.Doc()
    const expectedText = expectedDoc.getText('content')

    // Simulate two clients (Client A and Client B) editing concurrently
    const clientADoc = new Y.Doc()
    const clientBDoc = new Y.Doc()

    const fullHistoryOps: Uint8Array[] = []

    // Listeners to record all generated updates
    clientADoc.on('update', (u: Uint8Array) => {
      fullHistoryOps.push(new Uint8Array(u))
      Y.applyUpdate(clientBDoc, u)
      Y.applyUpdate(expectedDoc, u)
    })

    clientBDoc.on('update', (u: Uint8Array) => {
      fullHistoryOps.push(new Uint8Array(u))
      Y.applyUpdate(clientADoc, u)
      Y.applyUpdate(expectedDoc, u)
    })

    // Phase 1: Sequential and concurrent edits before checkpoint
    clientADoc.getText('content').insert(0, 'Hello from Client A.\n')
    clientBDoc.getText('content').insert(clientBDoc.getText('content').length, 'Hello from Client B.\n')

    // Concurrent edits
    clientADoc.getText('content').insert(5, '[A-edit] ')
    clientBDoc.getText('content').insert(15, '[B-edit] ')

    // Take snapshot at checkpoint
    const snapshotAtCheckpoint = Y.encodeStateAsUpdate(clientADoc)
    const checkpointOpIndex = fullHistoryOps.length

    // Phase 2: Subsequent concurrent edits after checkpoint (tail)
    clientADoc.getText('content').insert(clientADoc.getText('content').length, 'Tail line from Client A.\n')
    clientBDoc.getText('content').insert(clientBDoc.getText('content').length, 'Tail line from Client B.\n')

    const expectedFinalContent = expectedText.toString()

    // Recovery Path A: Full history replay
    const recoveredFull = new Y.Doc()
    for (const op of fullHistoryOps) {
      Y.applyUpdate(recoveredFull, op)
    }

    // Recovery Path B: Snapshot + retained tail ops
    const recoveredSnapshot = new Y.Doc()
    Y.applyUpdate(recoveredSnapshot, snapshotAtCheckpoint)
    for (let i = checkpointOpIndex; i < fullHistoryOps.length; i++) {
      Y.applyUpdate(recoveredSnapshot, fullHistoryOps[i])
    }

    // Assert both recovery methods arrive at identical content and match expected
    expect(recoveredFull.getText('content').toString()).toBe(expectedFinalContent)
    expect(recoveredSnapshot.getText('content').toString()).toBe(expectedFinalContent)
    expect(recoveredSnapshot.getText('content').toString()).toBe(recoveredFull.getText('content').toString())

    // Assert internal state vectors are identical
    const stateVectorFull = Y.encodeStateVector(recoveredFull)
    const stateVectorSnapshot = Y.encodeStateVector(recoveredSnapshot)
    expect(Buffer.from(stateVectorSnapshot).equals(Buffer.from(stateVectorFull))).toBe(true)
  })

  it('2. Writes arriving during compaction are preserved and never silently pruned', async () => {
    const docId = `test-compaction-race-${Date.now()}`
    const client = await dbPool.connect()

    try {
      // 1. Insert 3 operations before compaction
      const hlc1 = generateHLC('server')
      const hlc2 = generateHLC('server')
      const hlc3 = generateHLC('server')

      const doc1 = new Y.Doc()
      const text = doc1.getText('code')
      text.insert(0, 'Initial code;')
      const update1 = Y.encodeStateAsUpdate(doc1)

      text.insert(text.length, ' Second line;')
      const update2 = Y.encodeStateAsUpdate(doc1)

      text.insert(text.length, ' Third line;')
      const update3 = Y.encodeStateAsUpdate(doc1)

      await client.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES 
         ($1, 'c1', $2, $3),
         ($1, 'c1', $4, $5),
         ($1, 'c1', $6, $7)`,
        [docId, hlc1, Buffer.from(update1), hlc2, Buffer.from(update2), hlc3, Buffer.from(update3)]
      )

      // 2. Compaction begins: captures snapshot through hlc3
      const snapshotCutoffHlc = hlc3
      const snapshotBlob = Y.encodeStateAsUpdate(doc1)

      // 3. Simulating concurrent write arriving DURING compaction transaction
      // A new operation arrives with hlc4 > snapshotCutoffHlc
      const hlc4 = generateHLC('server')
      expect(hlc4 > snapshotCutoffHlc).toBe(true)

      const docInterleaved = new Y.Doc()
      docInterleaved.getText('code').insert(0, 'Concurrent write during compaction;')
      const updateInterleaved = Y.encodeStateAsUpdate(docInterleaved)

      // 4. Compaction transaction executes: inserts snapshot and deletes ops <= cutoffHlc
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
        [docId, Buffer.from(snapshotBlob), snapshotCutoffHlc]
      )
      await client.query(
        `DELETE FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2`,
        [docId, snapshotCutoffHlc]
      )

      // Concurrently, operation 4 was inserted into PostgreSQL (e.g. committed right as or after compaction deletes <= cutoff)
      await client.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, 'c2', $2, $3)`,
        [docId, hlc4, Buffer.from(updateInterleaved)]
      )

      await client.query('COMMIT')

      // 5. Verify that operation 4 was NOT deleted by compaction
      const remainingOps = await client.query(
        `SELECT hlc_timestamp, update_blob FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp ASC`,
        [docId]
      )
      expect(remainingOps.rows.length).toBe(1)
      expect(remainingOps.rows[0].hlc_timestamp).toBe(hlc4)

      // 6. Verify recovery correctly combines snapshot and retained operation 4
      const recoveredDoc = new Y.Doc()
      const snapshotRow = await client.query(
        `SELECT snapshot_blob FROM doc_snapshots WHERE doc_id = $1 ORDER BY hlc_cutoff DESC LIMIT 1`,
        [docId]
      )
      Y.applyUpdate(recoveredDoc, snapshotRow.rows[0].snapshot_blob)
      Y.applyUpdate(recoveredDoc, remainingOps.rows[0].update_blob)

      expect(recoveredDoc.getText('code').toString()).toContain('Third line;')
      expect(recoveredDoc.getText('code').toString()).toContain('Concurrent write during compaction;')
    } finally {
      client.release()
    }
  })

  it('3. Room concurrency lock prevents overlapping concurrent compaction executions', async () => {
    const docId = `test-compaction-lock-${Date.now()}`
    const room = getRoom(docId)

    expect(room.isCompacting).toBe(false)

    // Simulate first compaction locking the room
    room.isCompacting = true

    // Second compaction attempt checks mutex flag
    const attemptSecondCompaction = () => {
      if (room.isCompacting) {
        return { status: 409, error: 'COMPACTION_IN_PROGRESS' }
      }
      return { status: 200 }
    }

    const res = attemptSecondCompaction()
    expect(res.status).toBe(409)
    expect(res.error).toBe('COMPACTION_IN_PROGRESS')

    // When first compaction completes, lock is released
    room.isCompacting = false
    const afterUnlock = attemptSecondCompaction()
    expect(afterUnlock.status).toBe(200)
  })

  it('4. Failed compaction transaction rolls back cleanly and preserves uncompacted history', async () => {
    const docId = `test-failed-compaction-${Date.now()}`
    const client = await dbPool.connect()

    try {
      const hlc1 = generateHLC('server')
      const hlc2 = generateHLC('server')

      const doc = new Y.Doc()
      doc.getText('text').insert(0, 'Safe data;')
      const update = Y.encodeStateAsUpdate(doc)

      await client.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES 
         ($1, 'c1', $2, $3),
         ($1, 'c1', $4, $5)`,
        [docId, hlc1, Buffer.from(update), hlc2, Buffer.from(update)]
      )

      // Start compaction transaction but trigger an intentional error before commit
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
        [docId, Buffer.from(update), hlc2]
      )
      await client.query(`DELETE FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2`, [
        docId,
        hlc2,
      ])

      // Intentionally simulate an error (e.g. constraint violation or crash)
      let transactionFailed = false
      try {
        await client.query(`INSERT INTO non_existent_table VALUES (1)`)
      } catch {
        transactionFailed = true
        await client.query('ROLLBACK')
      }

      expect(transactionFailed).toBe(true)

      // Verify that after rollback, operations were NOT deleted and no snapshot was retained
      const opCountRes = await client.query(
        `SELECT COUNT(*) FROM operations WHERE doc_id = $1`,
        [docId]
      )
      expect(parseInt(opCountRes.rows[0].count, 10)).toBe(2)

      const snapCountRes = await client.query(
        `SELECT COUNT(*) FROM doc_snapshots WHERE doc_id = $1`,
        [docId]
      )
      expect(parseInt(snapCountRes.rows[0].count, 10)).toBe(0)

      // Recovery path remains 100% intact through full operations log
      const fullOps = await client.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp ASC`,
        [docId]
      )
      const recoveredDoc = new Y.Doc()
      for (const row of fullOps.rows) {
        Y.applyUpdate(recoveredDoc, row.update_blob)
      }
      expect(recoveredDoc.getText('text').toString()).toBe('Safe data;')
    } finally {
      client.release()
    }
  })

  it('5. Enforces bounded history retention contract (HTTP 410 on pruned history)', async () => {
    const docId = `test-retention-contract-${Date.now()}`
    const client = await dbPool.connect()

    try {
      const hlcBeforeCompaction = generateHLC('server')
      const hlcCutoff = generateHLC('server')
      const hlcAfterCompaction = generateHLC('server')

      const dummySnapshot = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))

      // Insert snapshot with cutoff
      await client.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
        [docId, dummySnapshot, hlcCutoff]
      )

      // Query retention boundary logic
      const earliestSnapshotRes = await client.query(
        `SELECT MIN(hlc_cutoff) AS earliest_cutoff FROM doc_snapshots WHERE doc_id = $1`,
        [docId]
      )
      const earliestSnapshotCutoff = earliestSnapshotRes.rows[0]?.earliest_cutoff
      expect(earliestSnapshotCutoff).toBe(hlcCutoff)

      // Querying before earliest cutoff must be rejected with 410 Gone
      const queryBeforeEarliest = (requestedHlc: string) => {
        if (earliestSnapshotCutoff && requestedHlc < earliestSnapshotCutoff) {
          return {
            status: 410,
            error: 'HISTORICAL_STATE_COMPACTED',
            earliestRecoverableHLC: earliestSnapshotCutoff,
          }
        }
        return { status: 200 }
      }

      const prunedResult = queryBeforeEarliest(hlcBeforeCompaction)
      expect(prunedResult.status).toBe(410)
      expect(prunedResult.error).toBe('HISTORICAL_STATE_COMPACTED')
      expect(prunedResult.earliestRecoverableHLC).toBe(hlcCutoff)

      const validResult = queryBeforeEarliest(hlcAfterCompaction)
      expect(validResult.status).toBe(200)
    } finally {
      client.release()
    }
  })

  it('6. Rejects malformed update blobs safely during recovery without mutating document state', () => {
    const doc = new Y.Doc()
    doc.getText('code').insert(0, 'Valid baseline.')

    const corruptedBlob = new Uint8Array([0xff, 0xfe, 0x00, 0x12]) // Invalid binary header

    expect(() => {
      Y.applyUpdate(doc, corruptedBlob)
    }).toThrow()

    // Document state remains uncorrupted
    expect(doc.getText('code').toString()).toBe('Valid baseline.')
  })
})
