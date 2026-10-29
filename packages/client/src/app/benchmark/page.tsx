'use client'

import React, { useState, useEffect } from 'react'
import {
  LocalAnalysisWorker,
  WebWorkerAnalysisWorker,
  SemanticGuardPipeline,
  WorkspaceFileSnapshot,
  AnalysisRequest,
  AnalysisResponse,
} from '@/lib/semantic-guard'

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

export default function BenchmarkPage() {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('Idle')
  const [results, setResults] = useState<any>(null)

  const helperFile: WorkspaceFileSnapshot = {
    id: 'vc',
    name: 'vectorClock.ts',
    content: `export class VectorClock { constructor(public id: string) {} tick(): void {} }`,
  }

  const runBrowserBenchmark = async () => {
    setRunning(true)
    setProgress('Initializing workers...')

    const benchData: any = {
      timestamp: new Date().toISOString(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
      comparisons: [],
      mainThreadBlocking: {},
      burstTyping: {},
      workerStartup: {},
      recovery: {},
    }

    try {
      // ── Measurement 1: Worker Startup Time ───────────────────────────────
      setProgress('Measuring worker startup time...')
      const startupStart = performance.now()
      const workerInstance = new WebWorkerAnalysisWorker()
      // Send ping / initial request to measure full startup time
      const initRes = await workerInstance.analyze({
        requestId: 'startup-check',
        version: 1,
        activeFileId: 'vc',
        files: [helperFile],
      })
      const workerStartupMs = performance.now() - startupStart
      benchData.workerStartup = {
        startupDurationMs: Number(workerStartupMs.toFixed(2)),
        initAnalysisMs: Number(initRes.analysisDurationMs.toFixed(2)),
      }

      // ── Measurement 2: Workloads Comparison (Local vs Web Worker) ────────
      const workloads = [
        { name: 'Small File (~25 lines / ~1.5 KB)', lines: 25, samples: 20 },
        { name: 'Medium File (~250 lines / ~14 KB)', lines: 250, samples: 20 },
        { name: 'Large File (~1,200 lines / ~69 KB)', lines: 1200, samples: 15 },
      ]

      const localWorker = new LocalAnalysisWorker()

      for (const wl of workloads) {
        setProgress(`Benchmarking ${wl.name}...`)
        const content = generateFileContent(wl.lines, true)
        const files: WorkspaceFileSnapshot[] = [
          helperFile,
          { id: 'target', name: 'target.ts', content },
        ]

        // 1. Local Worker (Main Thread)
        // Warmup
        for (let w = 0; w < 3; w++) {
          await localWorker.analyze({ requestId: 'warmup', version: 0, activeFileId: 'target', files })
        }
        const localTimes: number[] = []
        for (let i = 0; i < wl.samples; i++) {
          const t0 = performance.now()
          await localWorker.analyze({
            requestId: `loc-${i}`,
            version: i + 1,
            activeFileId: 'target',
            files,
            provenance: { occurred: true, mutatedDeclarations: ['calculateMissingTotal'], targetSymbol: 'calculateMissingTotal' },
          })
          localTimes.push(performance.now() - t0)
        }
        localTimes.sort((a, b) => a - b)
        const localMedian = localTimes[Math.floor(localTimes.length / 2)]
        const localP95 = localTimes[Math.floor(localTimes.length * 0.95)]

        // 2. Web Worker (Off-Thread)
        // Warmup
        for (let w = 0; w < 3; w++) {
          await workerInstance.analyze({ requestId: 'warmup-w', version: 0, activeFileId: 'target', files })
        }
        const workerE2ETimes: number[] = []
        const workerInternalTimes: number[] = []
        for (let i = 0; i < wl.samples; i++) {
          const t0 = performance.now()
          const res = await workerInstance.analyze({
            requestId: `wrk-${i}`,
            version: i + 1,
            activeFileId: 'target',
            files,
            provenance: { occurred: true, mutatedDeclarations: ['calculateMissingTotal'], targetSymbol: 'calculateMissingTotal' },
          })
          workerE2ETimes.push(performance.now() - t0)
          workerInternalTimes.push(res.analysisDurationMs)
        }
        workerE2ETimes.sort((a, b) => a - b)
        workerInternalTimes.sort((a, b) => a - b)
        const workerE2EMedian = workerE2ETimes[Math.floor(workerE2ETimes.length / 2)]
        const workerE2EP95 = workerE2ETimes[Math.floor(workerE2ETimes.length * 0.95)]
        const workerInternalMedian = workerInternalTimes[Math.floor(workerInternalTimes.length / 2)]

        benchData.comparisons.push({
          workload: wl.name,
          lines: wl.lines,
          samples: wl.samples,
          localMedianMs: Number(localMedian.toFixed(2)),
          localP95Ms: Number(localP95.toFixed(2)),
          workerE2EMedianMs: Number(workerE2EMedian.toFixed(2)),
          workerE2EP95Ms: Number(workerE2EP95.toFixed(2)),
          workerAnalysisDurationMs: Number(workerInternalMedian.toFixed(2)),
          ipcOverheadMs: Number((workerE2EMedian - workerInternalMedian).toFixed(2)),
        })
      }

      // ── Measurement 3: Multi-File Workspace (10 Files) ───────────────────
      setProgress('Benchmarking 10-file cross-reference workspace...')
      const multiFiles: WorkspaceFileSnapshot[] = [helperFile]
      for (let f = 1; f <= 9; f++) {
        multiFiles.push({
          id: `mod_${f}`,
          name: `module_${f}.ts`,
          content: `export class Module_${f} { compute(n: number): number { return n * ${f}; } }`,
        })
      }
      multiFiles.push({
        id: 'agg',
        name: 'agg.ts',
        content: `
          ${Array.from({ length: 9 }, (_, i) => `import { Module_${i + 1} } from './module_${i + 1}';`).join('\n')}
          export const total = ${Array.from({ length: 9 }, (_, i) => `new Module_${i + 1}().compute(${i})`).join(' + ')};
        `,
      })

      const multiTimes: number[] = []
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now()
        await workerInstance.analyze({ requestId: `multi-${i}`, version: i + 1, activeFileId: 'agg', files: multiFiles })
        multiTimes.push(performance.now() - t0)
      }
      multiTimes.sort((a, b) => a - b)
      benchData.multiFileWorkspace = {
        filesCount: 10,
        medianLatencyMs: Number(multiTimes[Math.floor(multiTimes.length / 2)].toFixed(2)),
        p95LatencyMs: Number(multiTimes[Math.floor(multiTimes.length * 0.95)].toFixed(2)),
      }

      // ── Measurement 4: Main Thread Blocking Comparison ───────────────────
      setProgress('Measuring main-thread blocking time...')
      const largeContent = generateFileContent(1200, true)
      const largeFiles = [helperFile, { id: 'large', name: 'large.ts', content: largeContent }]

      // Measure local main thread block
      const startLocalSync = performance.now()
      await localWorker.analyze({ requestId: 'sync-block', version: 1, activeFileId: 'large', files: largeFiles })
      const localMainThreadBlockMs = performance.now() - startLocalSync

      // Measure worker main thread block (dispatch + immediate return)
      const startWorkerAsync = performance.now()
      const workerPromise = workerInstance.analyze({ requestId: 'async-noblock', version: 2, activeFileId: 'large', files: largeFiles })
      const workerMainThreadDispatchMs = performance.now() - startWorkerAsync
      await workerPromise

      benchData.mainThreadBlocking = {
        localMainThreadBlockingMs: Number(localMainThreadBlockMs.toFixed(2)),
        workerMainThreadBlockingMs: Number(workerMainThreadDispatchMs.toFixed(2)),
        blockingReductionPercent: Number((((localMainThreadBlockMs - workerMainThreadDispatchMs) / localMainThreadBlockMs) * 100).toFixed(1)),
      }

      // ── Measurement 5: Rapid Typing Bursts & Execution Supersession ──────
      setProgress('Measuring rapid typing bursts...')
      const pipeline = new SemanticGuardPipeline(workerInstance, 50)
      let deliveredBursts = 0
      pipeline.onUpdate(() => {
        deliveredBursts++
      })

      for (let k = 1; k <= 10; k++) {
        pipeline.triggerAnalysis('target', [
          helperFile,
          { id: 'target', name: 'target.ts', content: `const burstVal = ${k};` },
        ])
      }
      await new Promise((r) => setTimeout(r, 120))

      benchData.burstTyping = {
        keystrokes: 10,
        deliveredFinalAnalyses: deliveredBursts,
        supersededExecutions: 10 - deliveredBursts,
        reductionPercent: Number((((10 - deliveredBursts) / 10) * 100).toFixed(1)),
      }

      setProgress('Benchmark complete!')
      setResults(benchData)
      if (typeof window !== 'undefined') {
        ;(window as any).__BENCHMARK_RESULTS__ = benchData
      }
      console.log('CONVERGE_BROWSER_BENCHMARK_RESULTS:', JSON.stringify(benchData, null, 2))

      pipeline.dispose()
      workerInstance.dispose()
      localWorker.dispose()
    } catch (err) {
      console.error('Benchmark failed:', err)
      setProgress(`Failed: ${err}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: 960, margin: '0 auto', color: '#111' }}>
      <h1>Converge Semantic Guard: Genuine Browser Web Worker Benchmark</h1>
      <p style={{ color: '#555' }}>
        Compares Main-Thread Synchronous Execution (<code>LocalAnalysisWorker</code>) against Genuine Browser Web Worker Isolation (<code>WebWorkerAnalysisWorker</code>).
      </p>

      <button
        id="run-benchmark-btn"
        onClick={runBrowserBenchmark}
        disabled={running}
        style={{
          padding: '10px 20px',
          backgroundColor: running ? '#999' : '#0066cc',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontWeight: 600,
          cursor: running ? 'not-allowed' : 'pointer',
        }}
      >
        {running ? 'Running Benchmark...' : 'Run Browser Benchmark'}
      </button>

      <span style={{ marginLeft: 16, fontWeight: 500, color: '#333' }}>
        Status: <span id="benchmark-status">{progress}</span>
      </span>

      {results && (
        <div id="benchmark-results" style={{ marginTop: 32 }}>
          <h2>Benchmark Results</h2>

          <h3>1. Workload Latencies: Main Thread vs Genuine Web Worker</h3>
          <table border={1} cellPadding={8} style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 24 }}>
            <thead>
              <tr style={{ backgroundColor: '#f0f4f8' }}>
                <th>Workload</th>
                <th>Lines</th>
                <th>Local Median (Main Thread)</th>
                <th>Worker E2E Median</th>
                <th>Worker Analysis Only</th>
                <th>Worker IPC Overhead</th>
              </tr>
            </thead>
            <tbody>
              {results.comparisons.map((c: any, idx: number) => (
                <tr key={idx}>
                  <td><strong>{c.workload}</strong></td>
                  <td>{c.lines}</td>
                  <td>{c.localMedianMs} ms</td>
                  <td>{c.workerE2EMedianMs} ms</td>
                  <td>{c.workerAnalysisDurationMs} ms</td>
                  <td>{c.ipcOverheadMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>2. Main-Thread Blocking Duration (Large File 1,200 lines)</h3>
          <ul>
            <li><strong>Local Runner Main Thread Block:</strong> {results.mainThreadBlocking.localMainThreadBlockingMs} ms</li>
            <li><strong>Web Worker Main Thread Block:</strong> {results.mainThreadBlocking.workerMainThreadBlockingMs} ms</li>
            <li><strong>Main-Thread Blocking Reduction:</strong> {results.mainThreadBlocking.blockingReductionPercent}%</li>
          </ul>

          <h3>3. Worker Startup & Multi-File Workspace</h3>
          <ul>
            <li><strong>Worker Startup Latency:</strong> {results.workerStartup.startupDurationMs} ms</li>
            <li><strong>10-File Workspace Median Latency:</strong> {results.multiFileWorkspace?.medianLatencyMs} ms (P95: {results.multiFileWorkspace?.p95LatencyMs} ms)</li>
            <li><strong>Burst Keystrokes Debounce Reduction:</strong> {results.burstTyping.reductionPercent}%</li>
          </ul>

          <pre style={{ backgroundColor: '#f5f5f5', padding: 12, borderRadius: 6, overflowX: 'auto', fontSize: 12 }}>
            {JSON.stringify(results, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
