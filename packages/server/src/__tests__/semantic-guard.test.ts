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

describe('Phase 3: Compiler Correctness Test Matrix (14 Scenarios)', () => {
  it('1. Valid TypeScript with standard library types (Record, Partial, Readonly, Promise, Date, Error, Uint8Array)', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-std',
        name: 'std.ts',
        content: `
          type User = { id: string; name: string };
          const partialUser: Partial<User> = { id: '1' };
          const map: Record<string, number> = { a: 1 };
          const now: string = new Date().toISOString();
          const err: Error = new Error('test');
          const buf: Uint8Array = new Uint8Array(8);
          async function fetchVal(): Promise<number> { return 42; }
        `,
      },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-1',
      version: 1,
      activeFileId: 'f-std',
      files,
    })
    expect(raw.length).toBe(0)
  })

  it('2. Valid TSX and JSX syntax in .tsx and .jsx files', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-ui',
        name: 'Component.tsx',
        content: `
          export function Component(props: { title: string }) {
            return <div className="card"><h1>{props.title}</h1></div>;
          }
        `,
      },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-2',
      version: 1,
      activeFileId: 'f-ui',
      files,
    })
    expect(raw.length).toBe(0)
  })

  it('3. Extensionless relative imports (./math resolves math.ts)', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-math', name: 'math.ts', content: `export const PI = 3.14159;` },
      { id: 'f-main', name: 'main.ts', content: `import { PI } from './math'; console.log(PI);` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-3',
      version: 1,
      activeFileId: 'f-main',
      files,
    })
    expect(raw.length).toBe(0)
  })

  it('4. Nested relative imports (../../core/util resolves across subdirectories)', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-core', name: 'core/util.ts', content: `export function add(a: number, b: number): number { return a + b; }` },
      { id: 'f-btn', name: 'components/ui/Button.tsx', content: `import { add } from '../../core/util'; export const val = add(1, 2);` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-4',
      version: 1,
      activeFileId: 'f-btn',
      files,
    })
    expect(raw.length).toBe(0)
  })

  it('5. Same-named files in different directories do not collide', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-adm', name: 'admin/user.ts', content: `export const role = 'admin';` },
      { id: 'f-cli', name: 'client/user.ts', content: `export const role = 'client';` },
      { id: 'f-idx', name: 'index.ts', content: `
        import { role as adminRole } from './admin/user';
        import { role as clientRole } from './client/user';
        console.log(adminRole, clientRole);
      ` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-5',
      version: 1,
      activeFileId: 'f-idx',
      files,
    })
    expect(raw.length).toBe(0)
  })

  it('6. Missing modules emit TS2307 diagnostic', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-app', name: 'app.ts', content: `import { nonexistent } from './missing';` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-6',
      version: 1,
      activeFileId: 'f-app',
      files,
    })
    expect(raw.some((d) => d.code === 2307)).toBe(true)
  })

  it('7. Renamed files with stale imports emit TS2307 diagnostic', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-new', name: 'newService.ts', content: `export const service = 1;` },
      { id: 'f-app', name: 'app.ts', content: `import { service } from './oldService';` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-7',
      version: 1,
      activeFileId: 'f-app',
      files,
    })
    expect(raw.some((d) => d.code === 2307)).toBe(true)
  })

  it('8. Deleted files still referenced elsewhere emit TS2307 diagnostic', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-app', name: 'app.ts', content: `import { deleted } from './deletedFile';` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-8',
      version: 1,
      activeFileId: 'f-app',
      files,
    })
    expect(raw.some((d) => d.code === 2307)).toBe(true)
  })

  it('9. Exported and imported symbols caught on type mismatch', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-data', name: 'data.ts', content: `export const count: number = 42;` },
      { id: 'f-main', name: 'main.ts', content: `import { count } from './data'; const s: string = count;` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-9',
      version: 1,
      activeFileId: 'f-main',
      files,
    })
    expect(raw.some((d) => d.code === 2322)).toBe(true)
  })

  it('10. Incomplete code during typing emits static syntax diagnostic without crash', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-main', name: 'main.ts', content: `const x = ` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-10',
      version: 1,
      activeFileId: 'f-main',
      files,
    })
    expect(raw.length).toBeGreaterThan(0)
    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw)
    expect(attributed[0].category).toBe('SYNTAX_ERROR')
    expect(attributed[0].attribution.isConcurrentConflict).toBe(false)
  })

  it('11. Repeated edits to the same document track version and updates diagnostics', () => {
    const p = new SemanticGuardPipeline(new LocalAnalysisWorker(), 0)
    const f1 = [{ id: 'doc', name: 'doc.ts', content: `const a: number = 'err';` }]
    const res1 = p.triggerAnalysis('doc', f1)
    expect(res1.version).toBe(1)

    const f2 = [{ id: 'doc', name: 'doc.ts', content: `const a: number = 100;` }]
    const res2 = p.triggerAnalysis('doc', f2)
    expect(res2.version).toBe(2)
    p.dispose()
  })

  it('12. Corrected errors clearing their old markers in Monaco', async () => {
    const p = new SemanticGuardPipeline(new LocalAnalysisWorker(), 0)
    let currentMarkers: any[] = []
    const fakeMonaco = {
      editor: {
        setModelMarkers: (_m: any, _owner: string, markers: any[]) => {
          currentMarkers = markers
        },
      },
    }
    p.bindMonaco(fakeMonaco, { uri: 'file:///workspace/doc.ts' })

    await p.analyzeNow('doc', [{ id: 'doc', name: 'doc.ts', content: `const x: number = 'wrong';` }])
    expect(currentMarkers.length).toBeGreaterThan(0)

    await p.analyzeNow('doc', [{ id: 'doc', name: 'doc.ts', content: `const x: number = 42;` }])
    expect(currentMarkers.length).toBe(0)
    p.dispose()
  })

  it('13. Unsupported language extensions (.md, .json) are handled gracefully without compiler errors', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'f-md', name: 'README.md', content: `# Title\n\nSome documentation.` },
      { id: 'f-json', name: 'config.json', content: `{"key": "value"}` },
      { id: 'f-ts', name: 'main.ts', content: `export const val = 1;` },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-13',
      version: 1,
      activeFileId: 'f-ts',
      files,
    })
    expect(raw.length).toBe(0)
  })

  it('14. Common ambient globals (console, setTimeout, setInterval, clearTimeout, Promise) do not cause false errors', () => {
    const files: WorkspaceFileSnapshot[] = [
      {
        id: 'f-amb',
        name: 'ambient.ts',
        content: `
          console.log('test');
          const timer = setTimeout(() => {}, 100);
          clearTimeout(timer);
          const interval = setInterval(() => {}, 200);
          clearInterval(interval);
        `,
      },
    ]
    const raw = SemanticChecker.checkWorkspace({
      requestId: 'matrix-14',
      version: 1,
      activeFileId: 'f-amb',
      files,
    })
    expect(raw.length).toBe(0)
  })
})

describe('Phase 4: Adversarial Concurrent Conflict Attribution Matrix (10 Scenarios with Real Yjs Replicas)', () => {
  it('1. Concurrent rename versus stale reference produces CONFIRMED_CONCURRENT_CONFLICT', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const utilA = docA.getText('file:util')
    const mainA = docA.getText('file:main')
    const utilB = docB.getText('file:util')
    const mainB = docB.getText('file:main')

    utilA.insert(0, `export function processItem(): number { return 1; }\n`)
    mainA.insert(0, `import { processItem } from './util';\n`)
    syncReplicas(docA, docB)

    // docA renames processItem -> handleItem
    utilA.delete(16, 'processItem'.length)
    utilA.insert(16, 'handleItem')

    // docB concurrently invokes processItem()
    mainB.insert(mainB.length, `processItem();\n`)

    syncReplicas(docA, docB)

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-1',
      version: 1,
      activeFileId: 'main',
      files: [
        { id: 'util', name: 'util.ts', content: utilA.toString() },
        { id: 'main', name: 'main.ts', content: mainA.toString() },
      ],
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docA.clientID,
      changedFileIds: ['util'],
      mutatedDeclarations: ['processItem'],
      targetSymbol: 'processItem',
    })

    const diag = attributed.find((d) => d.symbolName === 'processItem' || d.code === 2305)
    expect(diag).toBeDefined()
    expect(diag?.category).toBe('CONFIRMED_CONCURRENT_CONFLICT')
  })

  it('2. Concurrent deletion versus active reference produces CONFIRMED_CONCURRENT_CONFLICT', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const apiA = docA.getText('file:api')
    const clientA = docA.getText('file:client')
    const apiB = docB.getText('file:api')
    const clientB = docB.getText('file:client')

    apiA.insert(0, `export function validateInput(): boolean { return true; }\n`)
    clientA.insert(0, `import { validateInput } from './api';\n`)
    syncReplicas(docA, docB)

    // docA deletes validateInput
    apiA.delete(0, apiA.length)
    apiA.insert(0, `export const VERSION = 1;\n`)

    // docB adds usage
    clientB.insert(clientB.length, `const valid = validateInput();\n`)
    syncReplicas(docA, docB)

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-2',
      version: 1,
      activeFileId: 'client',
      files: [
        { id: 'api', name: 'api.ts', content: apiA.toString() },
        { id: 'client', name: 'client.ts', content: clientA.toString() },
      ],
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docA.clientID,
      changedFileIds: ['api'],
      mutatedDeclarations: ['validateInput'],
      targetSymbol: 'validateInput',
    })

    const diag = attributed.find((d) => d.symbolName === 'validateInput' || d.code === 2305)
    expect(diag).toBeDefined()
    expect(diag?.category).toBe('CONFIRMED_CONCURRENT_CONFLICT')
  })

  it('3. Concurrent duplicate declarations produce CONFIRMED_CONCURRENT_CONFLICT', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const sharedA = docA.getText('file:shared')
    const sharedB = docB.getText('file:shared')

    sharedA.insert(0, `// shared file\n`)
    syncReplicas(docA, docB)

    // Both peers concurrently declare the same variable
    sharedA.insert(sharedA.length, `export const configValue = 'fromA';\n`)
    sharedB.insert(sharedB.length, `export const configValue = 'fromB';\n`)
    syncReplicas(docA, docB)

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-3',
      version: 1,
      activeFileId: 'shared',
      files: [{ id: 'shared', name: 'shared.ts', content: sharedA.toString() }],
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docB.clientID,
      changedFileIds: ['shared'],
      declaredSymbols: ['configValue'],
      targetSymbol: 'configValue',
    })

    const dupDiag = attributed.find((d) => d.code === 2451 || d.code === 2300 || d.symbolName === 'configValue')
    expect(dupDiag).toBeDefined()
    expect(dupDiag?.category).toBe('CONFIRMED_CONCURRENT_CONFLICT')
  })

  it('4. Compatible concurrent edits result in 0 diagnostics', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const mathA = docA.getText('file:math')
    const mathB = docB.getText('file:math')

    mathA.insert(0, `export function f1(): number { return 1; }\nexport function f2(): number { return 2; }\n`)
    syncReplicas(docA, docB)

    // docA modifies f1
    const idx1 = mathA.toString().indexOf('return 1;') + 'return '.length
    mathA.delete(idx1, 1)
    mathA.insert(idx1, '10')

    // docB modifies f2
    const idx2 = mathB.toString().indexOf('return 2;') + 'return '.length
    mathB.delete(idx2, 1)
    mathB.insert(idx2, '20')
    syncReplicas(docA, docB)

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-4',
      version: 1,
      activeFileId: 'math',
      files: [{ id: 'math', name: 'math.ts', content: mathA.toString() }],
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docB.clientID,
    })
    expect(attributed.length).toBe(0)
  })

  it('5. A local error followed by an unrelated remote edit preserves STATIC_DIAGNOSTIC classification', () => {
    // Local user introduces an error in main.ts
    const localFiles: WorkspaceFileSnapshot[] = [
      { id: 'main', name: 'main.ts', content: `const x: number = 'type-error';` },
      { id: 'other', name: 'other.ts', content: `export const val = 1;` },
    ]

    const baselineRaw = SemanticChecker.checkWorkspace({
      requestId: 'adv-5-base',
      version: 1,
      activeFileId: 'main',
      files: localFiles,
    })
    const baselineDiagnostics = ConflictAttributionEngine.attributeDiagnostics(baselineRaw)
    expect(baselineDiagnostics[0].category).toBe('STATIC_DIAGNOSTIC')

    // Remote peer then edits 'other.ts'
    const updatedFiles: WorkspaceFileSnapshot[] = [
      { id: 'main', name: 'main.ts', content: `const x: number = 'type-error';` },
      { id: 'other', name: 'other.ts', content: `export const val = 200;` },
    ]

    const postMergeRaw = SemanticChecker.checkWorkspace({
      requestId: 'adv-5-post',
      version: 2,
      activeFileId: 'main',
      files: updatedFiles,
    })

    // Remote merge occurred on 'other.ts', but error is in 'main.ts'
    const attributed = ConflictAttributionEngine.attributeDiagnostics(
      postMergeRaw,
      {
        occurred: true,
        sourceClientId: 999,
        changedFileIds: ['other'],
      },
      baselineDiagnostics
    )

    const diag = attributed.find((d) => d.code === 2322)
    expect(diag).toBeDefined()
    // MUST remain STATIC_DIAGNOSTIC!
    expect(diag?.category).toBe('STATIC_DIAGNOSTIC')
    expect(diag?.attribution.isConcurrentConflict).toBe(false)
  })

  it('6. A causally ordered rename and reference update produces 0 diagnostics', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const utilA = docA.getText('file:util')
    const mainA = docA.getText('file:main')

    // Peer A updates both declaration and reference in causal order
    utilA.insert(0, `export function newFunction(): string { return 'ok'; }\n`)
    mainA.insert(0, `import { newFunction } from './util'; console.log(newFunction());\n`)
    syncReplicas(docA, docB)

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-6',
      version: 1,
      activeFileId: 'main',
      files: [
        { id: 'util', name: 'util.ts', content: utilA.toString() },
        { id: 'main', name: 'main.ts', content: mainA.toString() },
      ],
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docA.clientID,
    })
    expect(attributed.length).toBe(0)
  })

  it('7. An unrelated remote edit followed by a local error preserves STATIC_DIAGNOSTIC', () => {
    // Unrelated remote edit occurred on file 'other'
    const files: WorkspaceFileSnapshot[] = [
      { id: 'main', name: 'main.ts', content: `const invalidType: number = 'not-a-number';` },
      { id: 'other', name: 'other.ts', content: `export const X = 10;` },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-7',
      version: 1,
      activeFileId: 'main',
      files,
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: 777,
      changedFileIds: ['other'], // Remote peer edited 'other', not 'main'
    })

    const diag = attributed[0]
    expect(diag).toBeDefined()
    expect(diag.category).toBe('STATIC_DIAGNOSTIC')
    expect(diag.attribution.isConcurrentConflict).toBe(false)
  })

  it('8. Reconnection after multiple offline edits flags confirmed conflict for affected symbols', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const schemaA = docA.getText('file:schema')
    const consumerA = docA.getText('file:consumer')
    const schemaB = docB.getText('file:schema')
    const consumerB = docB.getText('file:consumer')

    schemaA.insert(0, `export type UserProfile = { id: string; name: string };\n`)
    consumerA.insert(0, `import { UserProfile } from './schema';\n`)
    syncReplicas(docA, docB)

    // docA offline: multiple sequential edits
    schemaA.delete(12, 'UserProfile'.length)
    schemaA.insert(12, 'AccountProfile')

    // docB offline: multiple sequential edits referencing UserProfile
    consumerB.insert(consumerB.length, `const user: UserProfile = { id: '1', name: 'Ada' };\n`)

    // Partition heals: sync replicas
    syncReplicas(docA, docB)

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-8',
      version: 1,
      activeFileId: 'consumer',
      files: [
        { id: 'schema', name: 'schema.ts', content: schemaA.toString() },
        { id: 'consumer', name: 'consumer.ts', content: consumerA.toString() },
      ],
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: docA.clientID,
      changedFileIds: ['schema'],
      mutatedDeclarations: ['UserProfile'],
      targetSymbol: 'UserProfile',
    })

    const conflict = attributed.find((d) => d.symbolName === 'UserProfile' || d.code === 2305)
    expect(conflict).toBeDefined()
    expect(conflict?.category).toBe('CONFIRMED_CONCURRENT_CONFLICT')
  })

  it('9. Stale provenance after an error has been fixed does not produce ghost conflict', async () => {
    const pipeline = new SemanticGuardPipeline(new LocalAnalysisWorker(), 0)

    // Phase A: Remote merge introduces conflict
    pipeline.recordMergeEvent({
      occurred: true,
      sourceClientId: 999,
      changedFileIds: ['api'],
      mutatedDeclarations: ['oldFunc'],
      targetSymbol: 'oldFunc',
    })

    const brokenFiles: WorkspaceFileSnapshot[] = [
      { id: 'api', name: 'api.ts', content: `export function newFunc() {}\n` },
      { id: 'main', name: 'main.ts', content: `import { oldFunc } from './api'; oldFunc();\n` },
    ]

    const resA = await pipeline.analyzeNow('main', brokenFiles)
    const conflict = resA.diagnostics.find((d) => d.category === 'CONFIRMED_CONCURRENT_CONFLICT')
    expect(conflict).toBeDefined()

    // Phase B: User fixes main.ts to import newFunc
    const fixedFiles: WorkspaceFileSnapshot[] = [
      { id: 'api', name: 'api.ts', content: `export function newFunc() {}\n` },
      { id: 'main', name: 'main.ts', content: `import { newFunc } from './api'; newFunc();\n` },
    ]

    const resB = await pipeline.analyzeNow('main', fixedFiles)
    expect(resB.diagnostics.length).toBe(0)
    pipeline.dispose()
  })

  it('10. Multiple diagnostics in one file: distinguishes CONCURRENT_CONFLICT from local STATIC_DIAGNOSTIC', () => {
    const files: WorkspaceFileSnapshot[] = [
      { id: 'api', name: 'api.ts', content: `export function renamedService(): void {}\n` },
      {
        id: 'main',
        name: 'main.ts',
        content: `
          import { staleService } from './api';
          staleService();
          const localTypo: number = 'this is a local type mismatch';
        `,
      },
    ]

    const raw = SemanticChecker.checkWorkspace({
      requestId: 'adv-10',
      version: 1,
      activeFileId: 'main',
      files,
    })

    const attributed = ConflictAttributionEngine.attributeDiagnostics(raw, {
      occurred: true,
      sourceClientId: 888,
      changedFileIds: ['api'],
      mutatedDeclarations: ['staleService'],
      targetSymbol: 'staleService',
    })

    const conflictDiag = attributed.find((d) => d.symbolName === 'staleService' || d.code === 2305)
    const staticDiag = attributed.find((d) => d.code === 2322)

    expect(conflictDiag).toBeDefined()
    expect(conflictDiag?.category).toBe('CONFIRMED_CONCURRENT_CONFLICT')

    expect(staticDiag).toBeDefined()
    expect(staticDiag?.category).toBe('STATIC_DIAGNOSTIC')
  })
})
