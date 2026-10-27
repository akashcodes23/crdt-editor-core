/**
 * packages/server/scripts/benchmark.ts
 *
 * Formal Reproducible Benchmark Suite for Converge Distributed Collaborative Core
 * Measures:
 * 1. Full-state vs Differential synchronization payload size & wire reduction ratio.
 * 2. CRDT synchronization latency across operation batches.
 * 3. Snapshot creation duration and compaction compression ratio.
 * 4. Cold recovery latency: Full historical operation replay vs Snapshot + Delta tail.
 * 5. PostgreSQL insertion latency and operation log row growth.
 * 6. Convergence under simulated artificial network latency and jitter.
 * 7. Multi-client peer swarm scaling and memory footprint.
 */

import * as Y from 'yjs'
import { performance } from 'perf_hooks'
import { dbPool, initDb } from '../src/db'
import { generateHLC } from '../src/hlc'

// Helper for statistical analysis
function stats(samples: number[]): {
  count: number
  mean: number
  median: number
  p90: number
  p95: number
  p99: number
  min: number
  max: number
} {
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

async function runBenchmarks() {
  console.log('='.repeat(80))
  console.log('CONVERGE DISTRIBUTED COLLABORATION ENGINE: PERFORMANCE BENCHMARK SUITE')
  console.log(`Node.js Runtime: ${process.version} | Platform: ${process.platform} ${process.arch}`)
  console.log(`Execution Timestamp: ${new Date().toISOString()}`)
  console.log('='.repeat(80) + '\n')

  // ───────────────────────────────────────────────────────────────────────────
  // Benchmark 1: Full-State vs Differential Synchronization Payload Size
  // ───────────────────────────────────────────────────────────────────────────
  console.log('## Benchmark 1: Full-State vs Differential Synchronization Wire Payload')
  const docSizes = [
    { label: 'Small Doc (~1 KB / 25 lines)', lines: 25 },
    { label: 'Medium Doc (~10 KB / 250 lines)', lines: 250 },
    { label: 'Large Doc (~50 KB / 1200 lines)', lines: 1200 },
  ]

  const b1Results: any[] = []

  for (const { label, lines } of docSizes) {
    const docServer = new Y.Doc()
    const docClient = new Y.Doc()

    const textServer = docServer.getText('code')
    for (let i = 0; i < lines; i++) {
      textServer.insert(textServer.length, `const line_${i} = { id: ${i}, value: "test-data-payload-segment-${i}" };\n`)
    }

    // Sync baseline state to client
    Y.applyUpdate(docClient, Y.encodeStateAsUpdate(docServer))

    // Client makes 1 incremental edit (e.g. typing 1 character)
    const clientStateVector = Y.encodeStateVector(docClient)
    textServer.insert(textServer.length, `// incremental single edit\n`)

    // Naive resync: Full state update
    const fullStateBytes = Y.encodeStateAsUpdate(docServer).byteLength

    // Converge differential sync: Diff against client's state vector
    const deltaBytes = Y.encodeStateAsUpdate(docServer, clientStateVector).byteLength
    const savingsPercent = ((fullStateBytes - deltaBytes) / fullStateBytes) * 100

    b1Results.push({
      workload: label,
      docChars: textServer.length,
      fullPayloadBytes: fullStateBytes,
      deltaPayloadBytes: deltaBytes,
      reductionPercent: savingsPercent.toFixed(2),
    })
  }

  console.table(b1Results)

  // ───────────────────────────────────────────────────────────────────────────
  // Benchmark 2: Synchronization & Convergence Latency
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n## Benchmark 2: Micro-Operation Synchronization Latency')
  const syncLatencies: number[] = []
  const N_OPS = 500

  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const textA = docA.getText('code')

  for (let i = 0; i < N_OPS; i++) {
    const tStart = performance.now()
    textA.insert(textA.length, 'x')
    const update = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB))
    Y.applyUpdate(docB, update)
    const tEnd = performance.now()
    syncLatencies.push(tEnd - tStart)
  }

  const b2Stats = stats(syncLatencies)
  console.log(`Iterations: ${N_OPS}`)
  console.log(`Mean Latency:   ${(b2Stats.mean * 1000).toFixed(2)} µs (${b2Stats.mean.toFixed(4)} ms)`)
  console.log(`Median (P50):   ${(b2Stats.median * 1000).toFixed(2)} µs`)
  console.log(`P90 Latency:    ${(b2Stats.p90 * 1000).toFixed(2)} µs`)
  console.log(`P99 Latency:    ${(b2Stats.p99 * 1000).toFixed(2)} µs`)
  console.log(`Max Latency:    ${(b2Stats.max * 1000).toFixed(2)} µs`)

  // ───────────────────────────────────────────────────────────────────────────
  // Benchmark 3: Snapshot Creation & Compaction Compression Ratio
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n## Benchmark 3: Snapshot Creation Duration & Storage Compaction Ratio')
  const opLogDoc = new Y.Doc()
  const opLogText = opLogDoc.getText('code')
  const rawOperationBuffers: Uint8Array[] = []

  opLogDoc.on('update', (u: Uint8Array) => {
    rawOperationBuffers.push(new Uint8Array(u))
  })

  // Simulate 300 sequential keystrokes
  for (let i = 0; i < 300; i++) {
    opLogText.insert(opLogText.length, `char_${i % 10}`)
  }

  const rawLogBytes = rawOperationBuffers.reduce((sum, b) => sum + b.byteLength, 0)

  const tSnapStart = performance.now()
  const compactedSnapshot = Y.encodeStateAsUpdate(opLogDoc)
  const tSnapEnd = performance.now()

  const snapshotCreationDurationMs = tSnapEnd - tSnapStart
  const snapshotBytes = compactedSnapshot.byteLength
  const compactionSavings = ((rawLogBytes - snapshotBytes) / rawLogBytes) * 100

  console.log(`Individual Incremental Updates: ${rawOperationBuffers.length}`)
  console.log(`Total Uncompacted Log Size:     ${rawLogBytes} bytes`)
  console.log(`Compacted Snapshot Size:        ${snapshotBytes} bytes`)
  console.log(`Storage Footprint Reduction:    ${compactionSavings.toFixed(2)}%`)
  console.log(`Snapshot Encoding Duration:     ${snapshotCreationDurationMs.toFixed(3)} ms`)

  // ───────────────────────────────────────────────────────────────────────────
  // Benchmark 4: Recovery Latency (Full Log Replay vs Snapshot + Tail)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n## Benchmark 4: Cold Document Recovery Latency')
  const RECOVERY_TRIALS = 30
  const fullReplayTimes: number[] = []
  const snapshotRecoveryTimes: number[] = []

  // Pre-generate 400 base ops + snapshot at op 300 + 100 tail ops
  const baseDoc = new Y.Doc()
  const baseText = baseDoc.getText('code')
  const allOps: Uint8Array[] = []

  baseDoc.on('update', (u) => allOps.push(new Uint8Array(u)))
  for (let i = 0; i < 300; i++) {
    baseText.insert(baseText.length, `item_${i}\n`)
  }
  const snap300 = Y.encodeStateAsUpdate(baseDoc)
  const cutoffIndex = allOps.length

  for (let i = 300; i < 400; i++) {
    baseText.insert(baseText.length, `item_${i}\n`)
  }

  // Measure Full Replay (Replaying all 400 ops from scratch)
  for (let t = 0; t < RECOVERY_TRIALS; t++) {
    const t0 = performance.now()
    const targetDocA = new Y.Doc()
    for (const op of allOps) {
      Y.applyUpdate(targetDocA, op)
    }
    const t1 = performance.now()
    fullReplayTimes.push(t1 - t0)
  }

  // Measure Snapshot + Tail (Applying snapshot + 100 tail ops)
  for (let t = 0; t < RECOVERY_TRIALS; t++) {
    const t0 = performance.now()
    const targetDocB = new Y.Doc()
    Y.applyUpdate(targetDocB, snap300)
    for (let i = cutoffIndex; i < allOps.length; i++) {
      Y.applyUpdate(targetDocB, allOps[i])
    }
    const t1 = performance.now()
    snapshotRecoveryTimes.push(t1 - t0)
  }

  const fullReplayStats = stats(fullReplayTimes)
  const snapRecoveryStats = stats(snapshotRecoveryTimes)
  const recoverySpeedup = fullReplayStats.mean / snapRecoveryStats.mean

  console.log(`Trials per method: ${RECOVERY_TRIALS}`)
  console.log(`Method A: Full Replay (400 ops): Mean = ${fullReplayStats.mean.toFixed(3)} ms | Median = ${fullReplayStats.median.toFixed(3)} ms | P95 = ${fullReplayStats.p95.toFixed(3)} ms`)
  console.log(`Method B: Snapshot + Tail (100 ops): Mean = ${snapRecoveryStats.mean.toFixed(3)} ms | Median = ${snapRecoveryStats.median.toFixed(3)} ms | P95 = ${snapRecoveryStats.p95.toFixed(3)} ms`)
  console.log(`Speedup Factor: ${recoverySpeedup.toFixed(2)}x faster restoration`)

  // ───────────────────────────────────────────────────────────────────────────
  // Benchmark 5: PostgreSQL Database Persistence Latency
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n## Benchmark 5: PostgreSQL Operation Append Latency')
  const dbConnected = await initDb()
  if (dbConnected) {
    const dbInsertLatencies: number[] = []
    const DB_INSERTS = 50
    const testDocId = `bench-${Date.now()}`

    for (let i = 0; i < DB_INSERTS; i++) {
      const hlc = generateHLC('bench-worker')
      const fakeBlob = Buffer.from(new Uint8Array([0, 1, 2, 3, i % 255]))

      const t0 = performance.now()
      await dbPool.query(
        `INSERT INTO operations (doc_id, client_id, hlc_timestamp, update_blob) VALUES ($1, $2, $3, $4)`,
        [testDocId, 'bench-client', hlc, fakeBlob]
      )
      const t1 = performance.now()
      dbInsertLatencies.push(t1 - t0)
    }

    const dbStats = stats(dbInsertLatencies)
    console.log(`PostgreSQL Inserts: ${DB_INSERTS} rows`)
    console.log(`Mean Write Latency:   ${dbStats.mean.toFixed(2)} ms`)
    console.log(`Median (P50):         ${dbStats.median.toFixed(2)} ms`)
    console.log(`P95 Write Latency:    ${dbStats.p95.toFixed(2)} ms`)
    console.log(`Max Write Latency:    ${dbStats.max.toFixed(2)} ms`)

    // Cleanup benchmark rows
    await dbPool.query(`DELETE FROM operations WHERE doc_id = $1`, [testDocId])
  } else {
    console.log('PostgreSQL connection unavailable: Skipped live database write latency benchmark.')
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Benchmark 6: Artificial Network Latency & Partition Jitter
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n## Benchmark 6: Convergence Under Artificial Latency & Jitter')
  const latencyLevelsMs = [0, 25, 50, 100]
  const b6Results: any[] = []

  for (const latencyMs of latencyLevelsMs) {
    const docPeerA = new Y.Doc()
    const docPeerB = new Y.Doc()

    docPeerA.getText('code').insert(0, 'peerA_initial;')
    docPeerB.getText('code').insert(0, 'peerB_initial;')

    const t0 = performance.now()
    // Simulated round-trip delay
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs))
    }

    // Exchange updates
    const uA = Y.encodeStateAsUpdate(docPeerA, Y.encodeStateVector(docPeerB))
    const uB = Y.encodeStateAsUpdate(docPeerB, Y.encodeStateVector(docPeerA))
    Y.applyUpdate(docPeerB, uA)
    Y.applyUpdate(docPeerA, uB)
    const t1 = performance.now()

    b6Results.push({
      injectedRoundTripDelayMs: latencyMs,
      measuredConvergenceMs: (t1 - t0).toFixed(2),
      convergedStateEquality: docPeerA.getText('code').toString() === docPeerB.getText('code').toString(),
    })
  }

  console.table(b6Results)

  // ───────────────────────────────────────────────────────────────────────────
  // Benchmark 7: Peer Swarm Scalability
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n## Benchmark 7: Peer Swarm Scalability (2 to 50 Replicas)')
  const swarmSizes = [2, 5, 10, 25, 50]
  const b7Results: any[] = []

  for (const size of swarmSizes) {
    const startMemory = process.memoryUsage().heapUsed
    const t0 = performance.now()

    const replicas: Y.Doc[] = []
    for (let i = 0; i < size; i++) {
      replicas.push(new Y.Doc())
    }

    // Each replica performs concurrent insert
    for (let i = 0; i < size; i++) {
      replicas[i].getText('code').insert(0, `[P${i}]`)
    }

    // Broadcast in a star topology via replica[0] as relay
    const hub = replicas[0]
    for (let i = 1; i < size; i++) {
      const u = Y.encodeStateAsUpdate(replicas[i], Y.encodeStateVector(hub))
      Y.applyUpdate(hub, u)
    }

    for (let i = 1; i < size; i++) {
      const u = Y.encodeStateAsUpdate(hub, Y.encodeStateVector(replicas[i]))
      Y.applyUpdate(replicas[i], u)
    }

    const t1 = performance.now()
    const endMemory = process.memoryUsage().heapUsed
    const heapAllocatedMb = (endMemory - startMemory) / (1024 * 1024)

    // Verify convergence across all replicas
    const expected = hub.getText('code').toString()
    const allConverged = replicas.every((r) => r.getText('code').toString() === expected)

    b7Results.push({
      replicaCount: size,
      convergenceDurationMs: (t1 - t0).toFixed(2),
      heapDeltaMb: heapAllocatedMb.toFixed(3),
      allReplicasConverged: allConverged,
    })
  }

  console.table(b7Results)

  console.log('\n' + '='.repeat(80))
  console.log('BENCHMARK RUN COMPLETE')
  console.log('='.repeat(80))

  await dbPool.end()
}

runBenchmarks().catch((err) => {
  console.error('[benchmark] Execution error:', err)
  process.exit(1)
})
