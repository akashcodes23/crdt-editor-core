/**
 * packages/server/scripts/benchmark-recovery.ts
 *
 * Reproducible Distributed Recovery & Fault-Injection Benchmark
 * Tests real PostgreSQL persistence and recovery under:
 * 1. Full historical log replay without snapshots
 * 2. Snapshot-assisted recovery with compacted history
 * 3. Recovery following interrupted / aborted compaction transactions
 *
 * Computes exact empirical metrics: Workload size, repetitions, median (P50), P95, and speedup.
 */

import * as Y from 'yjs'
import { performance } from 'perf_hooks'
import { dbPool, initDb } from '../src/db.js'
import { generateHLC } from '../src/hlc.js'

function computeStats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const count = sorted.length
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const mean = sum / count
  const median = sorted[Math.floor(count * 0.5)]
  const p90 = sorted[Math.floor(count * 0.9)]
  const p95 = sorted[Math.floor(count * 0.95)]
  const p99 = sorted[Math.floor(count * 0.99)]
  const min = sorted[0]
  const max = sorted[count - 1]
  return { count, mean, median, p90, p95, p99, min, max }
}

async function runRecoveryBenchmark() {
  console.log('='.repeat(80))
  console.log('CONVERGE PERSISTENCE & RECOVERY BENCHMARK: REPRODUCIBLE EXPERIMENTS')
  console.log(`Node.js Runtime: ${process.version} | Platform: ${process.platform} ${process.arch}`)
  console.log(`Execution Timestamp: ${new Date().toISOString()}`)
  console.log('='.repeat(80) + '\n')

  const dbOk = await initDb()
  if (!dbOk) {
    console.error('Fatal: Failed to connect to PostgreSQL database')
    process.exit(1)
  }

  const WORKLOAD_SIZES = [
    { label: 'Workload S (100 operations)', totalOps: 100, snapshotCutoffPercent: 0.8 },
    { label: 'Workload M (500 operations)', totalOps: 500, snapshotCutoffPercent: 0.8 },
    { label: 'Workload L (1000 operations)', totalOps: 1000, snapshotCutoffPercent: 0.8 },
  ]

  const TRIALS = 50
  const WARMUP = 5

  for (const { label, totalOps, snapshotCutoffPercent } of WORKLOAD_SIZES) {
    console.log(`\n### ${label}`)
    const docIdUncompacted = `bench-rec-uncompacted-${Date.now()}-${totalOps}`
    const docIdCompacted = `bench-rec-compacted-${Date.now()}-${totalOps}`
    const docIdInterrupted = `bench-rec-interrupted-${Date.now()}-${totalOps}`

    const canonicalDoc = new Y.Doc()
    const canonicalText = canonicalDoc.getText('code')

    // 1. Generate controlled sequence of operations
    const opBlobs: { hlc: string; blob: Uint8Array }[] = []
    canonicalDoc.on('update', (u) => {
      opBlobs.push({
        hlc: generateHLC('recovery-bench'),
        blob: new Uint8Array(u),
      })
    })

    // Populate initial document
    canonicalText.insert(0, 'function initializeCluster() {\n  const nodes = [];\n')
    for (let i = 0; i < totalOps - 1; i++) {
      canonicalText.insert(
        canonicalText.length,
        `  nodes.push({ id: ${i}, status: "healthy", clock: "${generateHLC('worker')}" });\n`
      )
    }
    canonicalText.insert(canonicalText.length, '  return nodes;\n}\n')

    const expectedFinalText = canonicalText.toString()
    const expectedStateVector = Y.encodeStateVector(canonicalDoc)

    // 2. Persist operations into PostgreSQL for each test document
    const client = await dbPool.connect()
    try {
      // Document A: Uncompacted
      for (const op of opBlobs) {
        await client.query(
          `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, 'bench', $2, $3)`,
          [docIdUncompacted, op.hlc, Buffer.from(op.blob)]
        )
      }

      // Document B: Compacted (Snapshot at cutoff + remaining delta tail)
      for (const op of opBlobs) {
        await client.query(
          `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, 'bench', $2, $3)`,
          [docIdCompacted, op.hlc, Buffer.from(op.blob)]
        )
      }

      const cutoffIndex = Math.floor(opBlobs.length * snapshotCutoffPercent)
      const cutoffHlc = opBlobs[cutoffIndex].hlc

      // Construct snapshot at cutoff
      const cutoffDoc = new Y.Doc()
      for (let i = 0; i <= cutoffIndex; i++) {
        Y.applyUpdate(cutoffDoc, opBlobs[i].blob)
      }
      const snapshotBlob = Y.encodeStateAsUpdate(cutoffDoc)

      // Transactional compaction on docIdCompacted
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
        [docIdCompacted, Buffer.from(snapshotBlob), cutoffHlc]
      )
      await client.query(
        `DELETE FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2`,
        [docIdCompacted, cutoffHlc]
      )
      await client.query('COMMIT')

      // Document C: Interrupted compaction (BEGIN -> INSERT -> DELETE -> ROLLBACK)
      for (const op of opBlobs) {
        await client.query(
          `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, 'bench', $2, $3)`,
          [docIdInterrupted, op.hlc, Buffer.from(op.blob)]
        )
      }

      await client.query('BEGIN')
      await client.query(
        `INSERT INTO doc_snapshots (doc_id, snapshot_blob, hlc_cutoff) VALUES ($1, $2, $3)`,
        [docIdInterrupted, Buffer.from(snapshotBlob), cutoffHlc]
      )
      await client.query(
        `DELETE FROM operations WHERE doc_id = $1 AND hlc_timestamp <= $2`,
        [docIdInterrupted, cutoffHlc]
      )
      // Inject transaction abort
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Benchmark Experiment 1: Recovery WITHOUT Snapshots (Full Historical Log Replay)
    // ─────────────────────────────────────────────────────────────────────────
    const uncompactedLatencies: number[] = []
    let opsReplayedUncompacted = 0

    // Warmup
    for (let w = 0; w < WARMUP; w++) {
      const d = new Y.Doc()
      const { rows } = await dbPool.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp ASC, id ASC`,
        [docIdUncompacted]
      )
      for (const r of rows) Y.applyUpdate(d, r.update_blob)
    }

    for (let t = 0; t < TRIALS; t++) {
      const t0 = performance.now()
      const recoveredDoc = new Y.Doc()
      const { rows } = await dbPool.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 ORDER BY hlc_timestamp ASC, id ASC`,
        [docIdUncompacted]
      )
      opsReplayedUncompacted = rows.length
      for (const r of rows) {
        Y.applyUpdate(recoveredDoc, r.update_blob)
      }
      const t1 = performance.now()
      uncompactedLatencies.push(t1 - t0)

      if (t === 0) {
        if (recoveredDoc.getText('code').toString() !== expectedFinalText) {
          throw new Error('Uncompacted recovery content mismatch!')
        }
        if (!Buffer.from(Y.encodeStateVector(recoveredDoc)).equals(Buffer.from(expectedStateVector))) {
          throw new Error('Uncompacted recovery state vector mismatch!')
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Benchmark Experiment 2: Recovery WITH Snapshots (Compacted Log Replay)
    // ─────────────────────────────────────────────────────────────────────────
    const compactedLatencies: number[] = []
    let opsReplayedCompacted = 0

    // Warmup
    for (let w = 0; w < WARMUP; w++) {
      const d = new Y.Doc()
      const snapRes = await dbPool.query(
        `SELECT snapshot_blob, hlc_cutoff FROM doc_snapshots WHERE doc_id = $1 ORDER BY hlc_cutoff DESC LIMIT 1`,
        [docIdCompacted]
      )
      Y.applyUpdate(d, snapRes.rows[0].snapshot_blob)
      const { rows } = await dbPool.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 AND hlc_timestamp > $2 ORDER BY hlc_timestamp ASC`,
        [docIdCompacted, snapRes.rows[0].hlc_cutoff]
      )
      for (const r of rows) Y.applyUpdate(d, r.update_blob)
    }

    for (let t = 0; t < TRIALS; t++) {
      const t0 = performance.now()
      const recoveredDoc = new Y.Doc()
      const snapRes = await dbPool.query(
        `SELECT snapshot_blob, hlc_cutoff FROM doc_snapshots WHERE doc_id = $1 ORDER BY hlc_cutoff DESC LIMIT 1`,
        [docIdCompacted]
      )
      Y.applyUpdate(recoveredDoc, snapRes.rows[0].snapshot_blob)
      const { rows } = await dbPool.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 AND hlc_timestamp > $2 ORDER BY hlc_timestamp ASC`,
        [docIdCompacted, snapRes.rows[0].hlc_cutoff]
      )
      opsReplayedCompacted = 1 + rows.length // 1 snapshot + delta tail ops
      for (const r of rows) {
        Y.applyUpdate(recoveredDoc, r.update_blob)
      }
      const t1 = performance.now()
      compactedLatencies.push(t1 - t0)

      if (t === 0) {
        if (recoveredDoc.getText('code').toString() !== expectedFinalText) {
          throw new Error('Compacted recovery content mismatch!')
        }
        if (!Buffer.from(Y.encodeStateVector(recoveredDoc)).equals(Buffer.from(expectedStateVector))) {
          throw new Error('Compacted recovery state vector mismatch!')
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Benchmark Experiment 3: Recovery After Interrupted Compaction
    // ─────────────────────────────────────────────────────────────────────────
    const interruptedLatencies: number[] = []
    let opsReplayedInterrupted = 0

    for (let t = 0; t < TRIALS; t++) {
      const t0 = performance.now()
      const recoveredDoc = new Y.Doc()
      // Since compaction rolled back, snapshot table has 0 snapshots for this docId
      const snapRes = await dbPool.query(
        `SELECT snapshot_blob, hlc_cutoff FROM doc_snapshots WHERE doc_id = $1 ORDER BY hlc_cutoff DESC LIMIT 1`,
        [docIdInterrupted]
      )
      let cutoff = '0'
      if (snapRes.rows.length > 0) {
        Y.applyUpdate(recoveredDoc, snapRes.rows[0].snapshot_blob)
        cutoff = snapRes.rows[0].hlc_cutoff
      }
      const { rows } = await dbPool.query(
        `SELECT update_blob FROM operations WHERE doc_id = $1 AND hlc_timestamp > $2 ORDER BY hlc_timestamp ASC`,
        [docIdInterrupted, cutoff]
      )
      opsReplayedInterrupted = rows.length
      for (const r of rows) {
        Y.applyUpdate(recoveredDoc, r.update_blob)
      }
      const t1 = performance.now()
      interruptedLatencies.push(t1 - t0)

      if (t === 0) {
        if (recoveredDoc.getText('code').toString() !== expectedFinalText) {
          throw new Error('Interrupted recovery content mismatch!')
        }
        if (!Buffer.from(Y.encodeStateVector(recoveredDoc)).equals(Buffer.from(expectedStateVector))) {
          throw new Error('Interrupted recovery state vector mismatch!')
        }
      }
    }

    const uncompactedStats = computeStats(uncompactedLatencies)
    const compactedStats = computeStats(compactedLatencies)
    const interruptedStats = computeStats(interruptedLatencies)
    const speedupMedian = (uncompactedStats.median / compactedStats.median).toFixed(2)

    console.table([
      {
        Mode: 'A: Full Replay (No Snapshot)',
        OpsReplayed: opsReplayedUncompacted,
        'Mean (ms)': uncompactedStats.mean.toFixed(2),
        'Median (ms)': uncompactedStats.median.toFixed(2),
        'P95 (ms)': uncompactedStats.p95.toFixed(2),
        'P99 (ms)': uncompactedStats.p99.toFixed(2),
        Verification: 'PASSED (exact match)',
      },
      {
        Mode: 'B: Compacted (Snapshot + Tail)',
        OpsReplayed: opsReplayedCompacted,
        'Mean (ms)': compactedStats.mean.toFixed(2),
        'Median (ms)': compactedStats.median.toFixed(2),
        'P95 (ms)': compactedStats.p95.toFixed(2),
        'P99 (ms)': compactedStats.p99.toFixed(2),
        Verification: 'PASSED (exact match)',
      },
      {
        Mode: 'C: Interrupted Compaction Rollback',
        OpsReplayed: opsReplayedInterrupted,
        'Mean (ms)': interruptedStats.mean.toFixed(2),
        'Median (ms)': interruptedStats.median.toFixed(2),
        'P95 (ms)': interruptedStats.p95.toFixed(2),
        'P99 (ms)': interruptedStats.p99.toFixed(2),
        Verification: 'PASSED (exact match)',
      },
    ])

    console.log(`=> Snapshot Compaction Recovery Speedup Factor: ${speedupMedian}x (P50)`)
    console.log(
      `=> Operations Replayed Reduction: ${opsReplayedUncompacted} -> ${opsReplayedCompacted} (${(
        (1 - opsReplayedCompacted / opsReplayedUncompacted) *
        100
      ).toFixed(1)}% reduction)`
    )
  }

  await dbPool.end()
  console.log('\n[Recovery Benchmark Completed Successfully]')
}

runRecoveryBenchmark().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
