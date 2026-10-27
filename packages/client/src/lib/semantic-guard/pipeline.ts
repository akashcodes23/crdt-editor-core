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
   * Set callback listener for diagnostics updates.
   */
  public onUpdate(callback: (fileId: string, diagnostics: SemanticDiagnostic[]) => void): void {
    this.onDiagnosticsUpdated = callback
  }

  /**
   * Record that a remote merge / sync event occurred.
   */
  public recordMergeEvent(provenance: MergeProvenance): void {
    this.pendingProvenance = provenance
  }

  /**
   * Trigger debounced analysis upon document content changes.
   */
  public triggerAnalysis(
    activeFileId: string,
    files: WorkspaceFileSnapshot[]
  ): { version: number; requestId: string } {
    const provenance = this.pendingProvenance ?? undefined
    // Clear pending provenance once consumed by request
    this.pendingProvenance = null

    return this.scheduler.schedule(
      {
        activeFileId,
        files,
        provenance,
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
    const effectiveProvenance = provenance ?? this.pendingProvenance ?? undefined
    this.pendingProvenance = null

    return this.scheduler.flushImmediately(
      {
        activeFileId,
        files,
        provenance: effectiveProvenance,
      },
      (response: AnalysisResponse) => {
        this.handleAnalysisComplete(activeFileId, response)
      }
    )
  }

  private handleAnalysisComplete(activeFileId: string, response: AnalysisResponse): void {
    // Filter diagnostics for the active file
    const activeFileDiags = response.diagnostics.filter(
      (d) => d.fileId === activeFileId || d.fileName.includes(activeFileId)
    )

    this.latestDiagnostics.set(activeFileId, activeFileDiags)

    // Apply markers to Monaco model if bound
    if (this.monacoInstance && this.currentModel) {
      MonacoDiagnosticAdapter.applyMarkers(
        this.monacoInstance,
        this.currentModel,
        activeFileDiags
      )
    }

    if (this.onDiagnosticsUpdated) {
      this.onDiagnosticsUpdated(activeFileId, activeFileDiags)
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

  public dispose(): void {
    this.scheduler.dispose()
    this.clear()
  }
}
