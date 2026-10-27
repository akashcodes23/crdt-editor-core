import * as Y from 'yjs'
import { SemanticChecker } from '../../../client/src/lib/semantic-guard/checker'
import { ConflictAttributionEngine } from '../../../client/src/lib/semantic-guard/attribution'
import { DebouncedAnalysisScheduler, LocalAnalysisWorker } from '../../../client/src/lib/semantic-guard/scheduler'
import { SemanticGuardPipeline } from '../../../client/src/lib/semantic-guard/pipeline'
import { MonacoDiagnosticAdapter } from '../../../client/src/lib/semantic-guard/monaco-adapter'
import { AnalysisRequest, WorkspaceFileSnapshot, IAnalysisWorker } from '../../../client/src/lib/semantic-guard/types'

function syncReplicas(docA: Y.Doc, docB: Y.Doc): void {
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB)))
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)))
}

describe('Converge Semantic Guard: AST Static Analysis & Conflict Attribution Tests', () => {
  // ── Test 1: Rename declaration without updating a reference ───────────────
  it('1. Detects declaration rename without updating reference (cross-file unresolved member)', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-util',
        name: 'util.ts',
        content: `export function computeTotal(items: number[]): number { return 100; }`,
      },
      {
        id: 'f-index',
        name: 'index.ts',
        content: `import { calculateTotal } from './util'; console.log(calculateTotal([]));`,
      },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'test-1',
      version: 1,
      activeFileId: 'f-index',
      files,
    })

    expect(raw.length).toBeGreaterThan(0)
    const diag = raw.find((d) => d.symbolName === 'calculateTotal' || d.code === 2305)
    expect(diag).toBeDefined()
    expect(diag?.fileName).toBe('index.ts')

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw)
    const target = attributed.find((d) => d.symbolName === 'calculateTotal' || d.code === 2305)
    expect(target).toBeDefined()
    expect(target?.category).toBe('STATIC_DIAGNOSTIC')
  })

  // ── Test 2: Concurrent declaration rename and reference insertion ─────────
  it('2. Confirms concurrent conflict on declaration rename and concurrent reference insertion', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const utilTextA = docA.getText('file:util')
    const utilTextB = docB.getText('file:util')
    const mainTextA = docA.getText('file:main')
    const mainTextB = docB.getText('file:main')

    // Initial synchronized baseline
    utilTextA.insert(0, `export function calculateTotal(): number { return 42; }\n`)
    mainTextA.insert(0, `import { calculateTotal } from './util';\n`)
    syncReplicas(docA, docB)

    // Network partition / concurrent disconnected editing:
    // Peer A renames calculateTotal -> computeTotal in util.ts
    utilTextA.delete(16, 'calculateTotal'.length)
    utilTextA.insert(16, 'computeTotal')

    // Peer B concurrently adds a call to calculateTotal() in main.ts
    mainTextB.insert(mainTextB.length, `const result = calculateTotal();\n`)

    // Partition heals: CRDT cleanly merges without syntactic text collision
    syncReplicas(docA, docB)

    const mergedFiles: WorkspaceFileSnapshot[] = [
      { id: 'util', name: 'util.ts', content: utilTextA.toString() },
      { id: 'main', name: 'main.ts', content: mainTextA.toString() },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'test-2',
      version: 2,
      activeFileId: 'main',
      files: mergedFiles,
    })

    // Attribution engine receives merge provenance indicating peer A mutated 'calculateTotal'
    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docA.clientID,
      mutatedDeclarations: ['calculateTotal'],
      targetSymbol: 'calculateTotal',
    })

    const conflict = attributed.find(
      (d) => d.symbolName === 'calculateTotal' || d.code === 2305 || d.code === 2304
    )

    expect(conflict).toBeDefined()
    expect(conflict?.category).toBe('CONFIRMED_CONCURRENT_CONFLICT')
    expect(conflict?.attribution.isConcurrentConflict).toBe(true)
    expect(conflict?.attribution.targetSymbol).toBe('calculateTotal')
  })

  // ── Test 3: Missing import ────────────────────────────────────────────────
  it('3. Detects missing imports (unresolvable module specifier)', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-main',
        name: 'main.ts',
        content: `import { nonExistent } from './missingModule';\nconsole.log(nonExistent);`,
      },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'test-3',
      version: 1,
      activeFileId: 'f-main',
      files,
    })

    const missingModuleDiag = raw.find((d) => d.code === 2307)
    expect(missingModuleDiag).toBeDefined()
    expect(missingModuleDiag?.message).toContain("Cannot find module './missingModule'")

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw)
    const target = attributed.find((d) => d.code === 2307)
    expect(target?.category).toBe('STATIC_DIAGNOSTIC')
  })

  // ── Test 4: Ordinary incomplete typing ─────────────────────────────────────
  it('4. Classifies incomplete typing as STATIC_DIAGNOSTIC without false-positive conflict', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-main',
        name: 'main.ts',
        content: `const x = fo`, // In-progress typing
      },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'test-4',
      version: 1,
      activeFileId: 'f-main',
      files,
    })

    // Does not have merge provenance -> must be STATIC_DIAGNOSTIC
    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: false,
    })

    const diag = attributed.find((d) => d.symbolName === 'fo' || d.code === 2304)
    expect(diag).toBeDefined()
    expect(diag?.category).toBe('STATIC_DIAGNOSTIC')
    expect(diag?.attribution.isConcurrentConflict).toBe(false)
  })

  // ── Test 5: Valid code after a fix ────────────────────────────────────────
  it('5. Clears all diagnostics when broken code is corrected', () => {
    // Step 1: Broken code
    const brokenFiles: WorkspaceFileSnapshot[] = [
      { id: 'f-main', name: 'main.ts', content: `const x: number = 'not-a-number';` },
    ]
    const rawBroken = SemanticChecker.checkWorkspace({
      requestId: 'test-5a',
      version: 1,
      activeFileId: 'f-main',
      files: brokenFiles,
    })
    expect(rawBroken.length).toBeGreaterThan(0)

    // Step 2: Fixed code
    const fixedFiles: WorkspaceFileSnapshot[] = [
      { id: 'f-main', name: 'main.ts', content: `const x: number = 42; console.log(x);` },
    ]
    const rawFixed = SemanticChecker.checkWorkspace({
      requestId: 'test-5b',
      version: 2,
      activeFileId: 'f-main',
      files: fixedFiles,
    })
    const attributedFixed = ConflictAttributionEngine.attributeDiagnostics(rawFixed)

    expect(attributedFixed.length).toBe(0)
  })

  // ── Test 6: Two concurrent edits that converge correctly ──────────────────
  it('6. Verifies clean convergence when concurrent edits are semantically compatible', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const textA = docA.getText('file:code')
    const textB = docB.getText('file:code')

    textA.insert(0, `export function f1(): number { return 1; }\n\nexport function f2(): number { return 2; }\n`)
    syncReplicas(docA, docB)

    // Peer A modifies body of f1 (replaces '1' with '10')
    const idx1 = textA.toString().indexOf('return 1;') + 'return '.length
    textA.delete(idx1, 1)
    textA.insert(idx1, '10')

    // Peer B concurrently modifies body of f2 (replaces '2' with '20')
    const idx2 = textB.toString().indexOf('return 2;') + 'return '.length
    textB.delete(idx2, 1)
    textB.insert(idx2, '20')

    syncReplicas(docA, docB)

    const files: WorkspaceFileSnapshot[] = [
      { id: 'code', name: 'code.ts', content: textA.toString() },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'test-6',
      version: 1,
      activeFileId: 'code',
      files,
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docB.clientID,
    })

    expect(attributed.length).toBe(0)
  })

  // ── Test 7: Cross-file references ─────────────────────────────────────────
  it('7. Typechecks cross-file references and catches member signature mismatches', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-vc',
        name: 'vectorClock.ts',
        content: `export class VectorClock { tick(): void {} }`,
      },
      {
        id: 'f-main',
        name: 'index.ts',
        content: `import { VectorClock } from './vectorClock';\nconst vc = new VectorClock();\nvc.invalidMethod();`,
      },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'test-7',
      version: 1,
      activeFileId: 'f-main',
      files,
    })

    const invalidMemberDiag = raw.find((d) => d.code === 2339 && d.symbolName === 'invalidMethod')
    expect(invalidMemberDiag).toBeDefined()
    expect(invalidMemberDiag?.message).toContain("Property 'invalidMethod' does not exist on type 'VectorClock'")
  })

  // ── Test 8: Deleted declarations ──────────────────────────────────────────
  it('8. Flags confirmed conflict when declaration is deleted concurrently with a reference', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-api',
        name: 'api.ts',
        content: `// formatName was deleted by peer\nexport const VERSION = 1;\n`,
      },
      {
        id: 'f-client',
        name: 'client.ts',
        content: `import { formatName } from './api';\nconsole.log(formatName('Alice'));`,
      },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'test-8',
      version: 1,
      activeFileId: 'f-client',
      files,
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: 999,
      mutatedDeclarations: ['formatName'],
      targetSymbol: 'formatName',
    })

    const conflict = attributed.find((d) => d.symbolName === 'formatName' || d.code === 2305)
    expect(conflict).toBeDefined()
    expect(conflict?.category).toBe('CONFIRMED_CONCURRENT_CONFLICT')
  })

  // ── Test 9: Stale worker results ──────────────────────────────────────────
  it('9. Rejects stale worker results when document version advances during analysis', async () => {
    let resolveSlowWorker: ((res: any) => void) | null = null

    const mockWorker: IAnalysisWorker = {
      analyze: (req) => {
        if (req.version === 1) {
          // Slow worker takes long time
          return new Promise((resolve) => {
            resolveSlowWorker = () => {
              resolve({
                requestId: req.requestId,
                version: req.version,
                diagnostics: [],
                analysisDurationMs: 100,
                isStale: false,
                timestamp: Date.now(),
              })
            }
          })
        }
        return Promise.resolve({
          requestId: req.requestId,
          version: req.version,
          diagnostics: [],
          analysisDurationMs: 5,
          isStale: false,
          timestamp: Date.now(),
        })
      },
      dispose: () => {},
    }

    const scheduler = new DebouncedAnalysisScheduler(mockWorker, 0)

    let v1Delivered = false
    let v2Delivered = false

    // Request 1 is scheduled
    scheduler.schedule(
      { activeFileId: 'f1', files: [{ id: 'f1', name: 'a.ts', content: 'var a = 1' }] },
      () => {
        v1Delivered = true
      }
    )

    // Immediate edit schedules Request 2
    scheduler.schedule(
      { activeFileId: 'f1', files: [{ id: 'f1', name: 'a.ts', content: 'var a = 2' }] },
      () => {
        v2Delivered = true
      }
    )

    // Complete Request 1 after Request 2 has superseded it
    if (resolveSlowWorker) (resolveSlowWorker as any)()

    // Allow event loop ticks
    await new Promise((r) => setTimeout(r, 20))

    // Stale result v1 must be rejected; only v2 delivered
    expect(v1Delivered).toBe(false)
    expect(v2Delivered).toBe(true)
    expect(scheduler.getCurrentVersion()).toBe(2)
  })

  // ── Test 10: Analysis worker failure handling ─────────────────────────────
  it('10. Handles worker execution errors gracefully without throwing', async () => {
    const crashingWorker: IAnalysisWorker = {
      analyze: () => {
        throw new Error('Simulated worker crash: out of memory')
      },
      dispose: () => {},
    }

    const pipeline = new SemanticGuardPipeline(crashingWorker, 0)
    let callbackInvoked = false

    pipeline.onUpdate((fileId, diags) => {
      callbackInvoked = true
      expect(fileId).toBe('f-crash')
      // Pipeline catches error and emits a graceful warning diagnostic
      expect(diags.length).toBe(1)
      expect(diags[0].message).toContain('Simulated worker crash')
      expect(diags[0].severity).toBe('warning')
    })

    const res = await pipeline.analyzeNow('f-crash', [
      { id: 'f-crash', name: 'crash.ts', content: 'var x = 1;' },
    ])

    expect(callbackInvoked).toBe(true)
    expect(res.diagnostics.length).toBe(1)
    expect(res.isStale).toBe(false)
  })

  // ── Test 11: Reconnection after network partition with Monaco adapter ─────
  it('11. Attributes concurrent conflicts on partition reconnect and adapts to Monaco markers', async () => {
    const pipeline = new SemanticGuardPipeline(new LocalAnalysisWorker(), 0)

    // Simulate Monaco instance
    const markersApplied: any[] = []
    const fakeMonaco = {
      editor: {
        setModelMarkers: (_model: any, owner: string, markers: any[]) => {
          expect(owner).toBe('semantic-guard')
          markersApplied.push(...markers)
        },
      },
    }
    const fakeModel = { uri: 'file:///workspace/main.ts' }
    pipeline.bindMonaco(fakeMonaco, fakeModel)

    // Record that partition merge occurred with client 200 mutating 'helper'
    pipeline.recordMergeEvent({
      occurred: true,
      sourceClientId: 200,
      mutatedDeclarations: ['helper'],
      targetSymbol: 'helper',
    })

    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'main',
        name: 'main.ts',
        content: `import { helper } from './util'; helper();`,
      },
      {
        id: 'util',
        name: 'util.ts',
        content: `// helper was renamed to runHelper by peer 200\nexport function runHelper() {}\n`,
      },
    ]

    const response = await pipeline.analyzeNow('main', files)

    expect(response.diagnostics.length).toBeGreaterThan(0)
    const conflictDiag = response.diagnostics.find(
      (d) => d.category === 'CONFIRMED_CONCURRENT_CONFLICT'
    )

    expect(conflictDiag).toBeDefined()
    expect(conflictDiag?.symbolName).toBe('helper')

    // Verify Monaco markers were generated
    expect(markersApplied.length).toBeGreaterThan(0)
    const marker = markersApplied.find((m) => m.message.includes('Confirmed Conflict'))
    expect(marker).toBeDefined()
    expect(marker.severity).toBe(8) // Error severity in Monaco
    expect(marker.source).toBe('Semantic Guard')
  })
})
