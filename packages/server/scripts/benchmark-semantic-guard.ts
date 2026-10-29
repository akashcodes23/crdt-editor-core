/**
 * packages/server/scripts/benchmark-semantic-guard.ts
 *
 * Performance Benchmark Suite for Converge Semantic Guard.
 * Measures AST analysis duration across file sizes, diagnostic update latency,
 * and debounced worker cancellation efficiency.
 */

import { SemanticChecker } from '../../client/src/lib/semantic-guard/checker'
import { ConflictAttributionEngine } from '../../client/src/lib/semantic-guard/attribution'
import { DebouncedAnalysisScheduler, LocalAnalysisWorker } from '../../client/src/lib/semantic-guard/scheduler'
import { WorkspaceFileSnapshot } from '../../client/src/lib/semantic-guard/types'

function generateFileContent(lines: number, hasConflict: boolean = false): string {
  const output: string[] = [
    `// Benchmark file generated with ${lines} lines`,
    `import { VectorClock } from './vectorClock'`,
    `export class Service {`,
    `  private clock = new VectorClock('bench');`,
  ]

  for (let i = 0; i < lines; i++) {
    output.push(`  public step_${i}(x: number): number { return x * ${i + 1}; }`)
  }

  if (hasConflict) {
    output.push(`  public execute(): void { const total = calculateMissingTotal(); }`)
  } else {
    output.push(`  public execute(): void { this.clock.tick(); }`)
  }

  output.push(`}`)
  return output.join('\n')
}

async function runBenchmarks() {
  console.log('='.repeat(80))
  console.log('CONVERGE SEMANTIC GUARD: PERFORMANCE BENCHMARK SUITE')
  console.log(`Runtime: Node.js ${process.version} | Platform: ${process.platform} ${process.arch}`)
  console.log(`Timestamp: ${new Date().toISOString()}`)
  console.log('='.repeat(80))

  const helperFile: WorkspaceFileSnapshot = {
    id: 'vc',
    name: 'vectorClock.ts',
    content: `export class VectorClock { constructor(public id: string) {} tick(): void {} }`,
  }

  // ── Benchmark 1: Compiler Cold Start vs Incremental Analysis Duration ───
  console.log('\n## Benchmark 1: Compiler Cold Start vs Incremental Analysis Duration')

  const workloads = [
    { name: 'Small File (~25 lines / ~1 KB)', lines: 25 },
    { name: 'Medium File (~250 lines / ~10 KB)', lines: 250 },
    { name: 'Large File (~1,200 lines / ~50 KB)', lines: 1200 },
  ]

  const workloadResults: any[] = []

  for (const wl of workloads) {
    const content = generateFileContent(wl.lines, true)
    const files: WorkspaceFileSnapshot[] = [
      helperFile,
      { id: 'target', name: 'target.ts', content },
    ]

    // Cold start measurement (first execution without warm-up)
    const coldStart = performance.now()
    const coldRaw = SemanticChecker.checkWorkspace({
      requestId: 'cold',
      version: 0,
      activeFileId: 'target',
      files,
    })
    ConflictAttributionEngine.attributeDiagnostics(coldRaw, {
      occurred: true,
      sourceClientId: 99,
      mutatedDeclarations: ['calculateMissingTotal'],
      targetSymbol: 'calculateMissingTotal',
    })
    const coldDurationMs = performance.now() - coldStart

    // Warm-up 5 cycles
    for (let i = 0; i < 5; i++) {
      SemanticChecker.checkWorkspace({
        requestId: 'warmup',
        version: 0,
        activeFileId: 'target',
        files,
      })
    }

    // Measure 30 incremental iterations (main-thread synchronous execution time)
    const samples: number[] = []
    for (let i = 0; i < 30; i++) {
      const start = performance.now()
      const raw = SemanticChecker.checkWorkspace({
        requestId: `bench-${i}`,
        version: i + 1,
        activeFileId: 'target',
        files,
      })
      ConflictAttributionEngine.attributeDiagnostics(raw, {
        occurred: true,
        sourceClientId: 99,
        mutatedDeclarations: ['calculateMissingTotal'],
        targetSymbol: 'calculateMissingTotal',
      })
      const dur = performance.now() - start
      samples.push(dur)
    }

    samples.sort((a, b) => a - b)
    const sum = samples.reduce((acc, v) => acc + v, 0)
    const mean = sum / samples.length
    const median = samples[Math.floor(samples.length / 2)]
    const p95 = samples[Math.floor(samples.length * 0.95)]

    workloadResults.push({
      workload: wl.name,
      lines: wl.lines,
      fileSizeChars: content.length,
      coldStartMs: coldDurationMs.toFixed(2),
      meanDurationMs: mean.toFixed(2),
      medianDurationMs: median.toFixed(2),
      p95DurationMs: p95.toFixed(2),
      mainThreadBlocking: 'Synchronous (Main Thread)',
    })
  }

  console.table(workloadResults)

  // ── Benchmark 2: Multi-File Workspace Analysis Cost (10 Files) ────────────
  console.log('\n## Benchmark 2: Multi-File Workspace Cross-File Analysis Cost (10 files)')
  const multiFiles: WorkspaceFileSnapshot[] = [helperFile]
  for (let f = 1; f <= 9; f++) {
    multiFiles.push({
      id: `file_${f}`,
      name: `module_${f}.ts`,
      content: `
        import { VectorClock } from './vectorClock';
        export class Module_${f} {
          private vc = new VectorClock('mod_${f}');
          public compute(n: number): number { return n * ${f}; }
        }
      `,
    })
  }
  // Target file imports from all 9 modules
  multiFiles.push({
    id: 'aggregator',
    name: 'aggregator.ts',
    content: `
      ${Array.from({ length: 9 }, (_, idx) => `import { Module_${idx + 1} } from './module_${idx + 1}';`).join('\n')}
      export function runAll(): number {
        return ${Array.from({ length: 9 }, (_, idx) => `new Module_${idx + 1}().compute(${idx})`).join(' + ')};
      }
    `,
  })

  // Measure 20 runs
  const multiSamples: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    SemanticChecker.checkWorkspace({
      requestId: `multi-${i}`,
      version: i + 1,
      activeFileId: 'aggregator',
      files: multiFiles,
    })
    multiSamples.push(performance.now() - t0)
  }
  multiSamples.sort((a, b) => a - b)
  const multiMedian = multiSamples[Math.floor(multiSamples.length / 2)].toFixed(2)
  const multiP95 = multiSamples[Math.floor(multiSamples.length * 0.95)].toFixed(2)
  console.log(`10-File Workspace Analysis Latency:`)
  console.log(`Median: ${multiMedian} ms | P95: ${multiP95} ms`)

  // ── Benchmark 3: End-to-End Edit-to-Marker Latency (with Debounce Breakdown) ─
  console.log('\n## Benchmark 3: End-to-End Diagnostic Update Latency & Debounce Breakdown')

  const immediateScheduler = new DebouncedAnalysisScheduler(new LocalAnalysisWorker(), 0) // immediate flush
  const editLatencies: number[] = []

  for (let i = 0; i < 20; i++) {
    const editContent = `const val_${i} = ${i}; console.log(unknown_${i});`
    const files = [helperFile, { id: 'edit', name: 'edit.ts', content: editContent }]

    const start = performance.now()
    await new Promise<void>((resolve) => {
      immediateScheduler.schedule(
        { activeFileId: 'edit', files },
        () => {
          editLatencies.push(performance.now() - start)
          resolve()
        }
      )
    })
  }

  editLatencies.sort((a, b) => a - b)
  const editMean = (editLatencies.reduce((a, b) => a + b, 0) / editLatencies.length).toFixed(2)
  const editMedian = editLatencies[Math.floor(editLatencies.length / 2)].toFixed(2)
  const editP95 = editLatencies[Math.floor(editLatencies.length * 0.95)].toFixed(2)

  console.log(`Immediate (0ms debounce) Edit Update Latency (20 edits):`)
  console.log(`Mean:   ${editMean} ms`)
  console.log(`Median: ${editMedian} ms`)
  console.log(`P95:    ${editP95} ms`)
  console.log(`Default debounce configured in editor: 200 ms`)
  console.log(`Expected End-to-End latency in production editor: ~${(Number(editMedian) + 200).toFixed(2)} ms`)

  // ── Benchmark 4: Worker Cancellation & Actual Compiler Invocations ────────
  console.log('\n## Benchmark 4: Burst Typing Debounce & Actual Compiler Invocations')

  let actualCompilerInvocations = 0
  const instrumentedWorker = {
    analyze: async (req: any) => {
      actualCompilerInvocations++
      const worker = new LocalAnalysisWorker()
      return worker.analyze(req)
    },
    dispose: () => {},
  }

  const burstScheduler = new DebouncedAnalysisScheduler(instrumentedWorker, 50)
  let deliveredResults = 0

  // Simulate rapid 50ms keystroke burst (10 rapid keystrokes within 20ms)
  const totalKeystrokes = 10
  for (let k = 0; k < totalKeystrokes; k++) {
    burstScheduler.schedule(
      {
        activeFileId: 'burst',
        files: [{ id: 'burst', name: 'burst.ts', content: `const x = ${k}` }],
      },
      () => {
        deliveredResults++
      }
    )
  }

  // Wait for debounce to settle
  await new Promise((r) => setTimeout(r, 120))
  const supersededExecutions = totalKeystrokes - actualCompilerInvocations

  console.log(`Burst Keystrokes Simulated:        ${totalKeystrokes}`)
  console.log(`Delivered Final Analysis:          ${deliveredResults}`)
  console.log(`Actual Compiler Executions:        ${actualCompilerInvocations}`)
  console.log(`Superseded / Avoided Compiles:     ${supersededExecutions} (${((supersededExecutions / totalKeystrokes) * 100).toFixed(1)}% verified reduction in actual compiler invocations)`)

  console.log('\n' + '='.repeat(80))
  console.log('SEMANTIC GUARD BENCHMARK COMPLETE')
  console.log('='.repeat(80))
}

runBenchmarks().catch(console.error)
