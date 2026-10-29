/**
 * packages/client/src/lib/semantic-guard/types.ts
 *
 * Core type definitions for Converge Semantic Guard:
 * An AST-based static-analysis engine detecting post-CRDT convergence semantic conflicts.
 */

export type DiagnosticCategory =
  | 'SYNTAX_ERROR'
  | 'STATIC_DIAGNOSTIC'
  | 'LIKELY_CONCURRENT_CONFLICT'
  | 'CONFIRMED_CONCURRENT_CONFLICT'

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface ConflictAttribution {
  classification: DiagnosticCategory
  isConcurrentConflict: boolean
  targetSymbol?: string
  reason: string
  evidence: string[]
  localClientId?: number
  remoteClientId?: number
}

export interface SemanticDiagnostic {
  id: string
  fileId: string
  fileName: string
  category: DiagnosticCategory
  severity: DiagnosticSeverity
  message: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  code: number
  symbolName?: string
  attribution: ConflictAttribution
}

export interface WorkspaceFileSnapshot {
  id: string
  name: string
  content: string
  version?: number
}

export interface MergeProvenance {
  occurred: boolean
  sourceClientId?: number
  targetSymbol?: string
  mutatedDeclarations?: string[]
  referencedSymbols?: string[]
  changedFiles?: string[]
  changedFileIds?: string[]
  declaredSymbols?: string[]
}

export interface AnalysisRequest {
  requestId: string
  version: number
  activeFileId: string
  files: WorkspaceFileSnapshot[]
  provenance?: MergeProvenance
  baselineDiagnostics?: SemanticDiagnostic[]
  cursorOffset?: number
}

export interface AnalysisResponse {
  requestId: string
  version: number
  diagnostics: SemanticDiagnostic[]
  analysisDurationMs: number
  isStale: boolean
  timestamp: number
}

export interface IAnalysisWorker {
  analyze(request: AnalysisRequest): Promise<AnalysisResponse>
  cancel?(requestId: string, version: number): void
  dispose(): void
}
