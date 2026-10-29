/**
 * packages/client/src/lib/semantic-guard/pipeline.ts
 *
 * End-to-End Analysis Pipeline for Converge Semantic Guard.
 * Coordinates document versioning, debounced scheduling, in-memory worker execution,
 * conflict attribution, stale-result filtering, and Monaco marker synchronization.
 */

import {
  AnalysisRequest,
  AnalysisResponse,
  MergeProvenance,
  SemanticDiagnostic,
  WorkspaceFileSnapshot,
  IAnalysisWorker,
} from './types'
import { DebouncedAnalysisScheduler } from './scheduler'
import { MonacoDiagnosticAdapter } from './monaco-adapter'

export class SemanticGuardPipeline {
  private scheduler: DebouncedAnalysisScheduler
  private latestDiagnostics: Map<string, SemanticDiagnostic[]> = new Map()
  private pendingProvenance: MergeProvenance | null = null
  private onDiagnosticsUpdated?: (fileId: string, diagnostics: SemanticDiagnostic[]) => void
  private monacoInstance: any = null
  private currentModel: any = null
  private activeFileId: string | null = null

  constructor(worker?: IAnalysisWorker, debounceMs: number = 200) {
    this.scheduler = new DebouncedAnalysisScheduler(worker, debounceMs)
  }

  /**
   * Bind the Monaco editor instance and active model.
   */
  public bindMonaco(monacoInstance: any, model: any): void {
    this.monacoInstance = monacoInstance
    this.currentModel = model
  }

  /**
   * Switch active file and Monaco model, clearing markers from previous model
   * and restoring cached markers onto the new model.
   */
  public switchActiveFile(newFileId: string, model: any): void {
    this.activeFileId = newFileId
    if (this.monacoInstance && this.currentModel && this.currentModel !== model) {
      MonacoDiagnosticAdapter.clearMarkers(this.monacoInstance, this.currentModel)
    }
    this.currentModel = model
    const cached = this.latestDiagnostics.get(newFileId)
    if (this.monacoInstance && model && cached) {
      MonacoDiagnosticAdapter.applyMarkers(this.monacoInstance, model, cached)
    }
  }

  /**
   * Set callback listener for diagnostics updates.
   */
  public onUpdate(callback: (fileId: string, diagnostics: SemanticDiagnostic[]) => void): void {
    this.onDiagnosticsUpdated = callback
  }

  /**
   * Record that a remote merge / sync event occurred.
   */
  public recordMergeEvent(provenance: MergeProvenance): void {
    if (!this.pendingProvenance) {
      this.pendingProvenance = { ...provenance }
      return
    }

    // Merge existing pending provenance
    const existing = this.pendingProvenance
    const changedSet = new Set<string>([
      ...(existing.changedFileIds || []),
      ...(provenance.changedFileIds || []),
    ])
    const mutatedSet = new Set<string>([
      ...(existing.mutatedDeclarations || []),
      ...(provenance.mutatedDeclarations || []),
    ])
    const declaredSet = new Set<string>([
      ...(existing.declaredSymbols || []),
      ...(provenance.declaredSymbols || []),
    ])

    this.pendingProvenance = {
      occurred: existing.occurred || provenance.occurred,
      sourceClientId: provenance.sourceClientId ?? existing.sourceClientId,
      changedFileIds: changedSet.size > 0 ? Array.from(changedSet) : undefined,
      mutatedDeclarations: mutatedSet.size > 0 ? Array.from(mutatedSet) : undefined,
      declaredSymbols: declaredSet.size > 0 ? Array.from(declaredSet) : undefined,
    }
  }

  /**
   * Trigger debounced analysis upon document content changes.
   */
  public triggerAnalysis(
    activeFileId: string,
    files: WorkspaceFileSnapshot[]
  ): { version: number; requestId: string } {
    this.activeFileId = activeFileId
    const provenance = this.pendingProvenance ?? undefined
    const baselineDiagnostics = this.latestDiagnostics.get(activeFileId) || []
    // Clear pending provenance once consumed by request
    this.pendingProvenance = null

    return this.scheduler.schedule(
      {
        activeFileId,
        files,
        provenance,
        baselineDiagnostics,
      },
      (response: AnalysisResponse) => {
        this.handleAnalysisComplete(activeFileId, response)
      }
    )
  }

  /**
   * Immediately analyze workspace files without debouncing.
   */
  public async analyzeNow(
    activeFileId: string,
    files: WorkspaceFileSnapshot[],
    provenance?: MergeProvenance
  ): Promise<AnalysisResponse> {
    this.activeFileId = activeFileId
    const effectiveProvenance = provenance ?? this.pendingProvenance ?? undefined
    const baselineDiagnostics = this.latestDiagnostics.get(activeFileId) || []
    this.pendingProvenance = null

    return this.scheduler.flushImmediately(
      {
        activeFileId,
        files,
        provenance: effectiveProvenance,
        baselineDiagnostics,
      },
      (response: AnalysisResponse) => {
        this.handleAnalysisComplete(activeFileId, response)
      }
    )
  }

  private handleAnalysisComplete(targetFileId: string, response: AnalysisResponse): void {
    if (response.isStale) {
      return
    }

    // Filter diagnostics for the target file
    const activeFileDiags = response.diagnostics.filter(
      (d) => d.fileId === targetFileId || d.fileName.includes(targetFileId)
    )

    this.latestDiagnostics.set(targetFileId, activeFileDiags)

    // Apply markers to Monaco model ONLY if this file is still the active file
    if (this.monacoInstance && this.currentModel && this.activeFileId === targetFileId) {
      MonacoDiagnosticAdapter.applyMarkers(
        this.monacoInstance,
        this.currentModel,
        activeFileDiags
      )
    }

    if (this.onDiagnosticsUpdated) {
      this.onDiagnosticsUpdated(targetFileId, activeFileDiags)
    }
  }

  /**
   * Clear all diagnostics for a file.
   */
  public clear(fileId?: string): void {
    if (fileId) {
      this.latestDiagnostics.delete(fileId)
    } else {
      this.latestDiagnostics.clear()
    }
    if (this.monacoInstance && this.currentModel) {
      MonacoDiagnosticAdapter.clearMarkers(this.monacoInstance, this.currentModel)
    }
  }

  public getDiagnostics(fileId: string): SemanticDiagnostic[] {
    return this.latestDiagnostics.get(fileId) || []
  }

  public getScheduler(): DebouncedAnalysisScheduler {
    return this.scheduler
  }

  public getActiveFileId(): string | null {
    return this.activeFileId
  }

  public getDisplayedVersion(): number {
    return this.scheduler.getDisplayedVersion()
  }

  public dispose(): void {
    this.scheduler.dispose()
    this.clear()
  }
}
