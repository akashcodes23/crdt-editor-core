/**
 * packages/client/src/lib/semantic-guard/scheduler.ts
 *
 * Debounced Analysis Scheduler with Stale-Result Filtering and Cancellation.
 * Ensures typing responsiveness by superseding obsolete analysis requests
 * and preventing stale results from overwriting newer document versions.
 */

import {
  AnalysisRequest,
  AnalysisResponse,
  IAnalysisWorker,
  SemanticDiagnostic,
} from './types'
import { SemanticChecker } from './checker'
import { ConflictAttributionEngine } from './attribution'
import { WebWorkerAnalysisWorker } from './worker-client'

export class LocalAnalysisWorker implements IAnalysisWorker {
  public async analyze(request: AnalysisRequest): Promise<AnalysisResponse> {
    const startTime = performance.now()
    try {
      const raw = SemanticChecker.checkWorkspace(request)
      const diagnostics = ConflictAttributionEngine.attributeDiagnostics(
        raw,
        request.provenance,
        request.baselineDiagnostics
      )
      const duration = performance.now() - startTime

      return {
        requestId: request.requestId,
        version: request.version,
        diagnostics,
        analysisDurationMs: duration,
        isStale: false,
        timestamp: Date.now(),
      }
    } catch (err: any) {
      console.error('[SemanticGuard] Worker analysis error:', err)
      const duration = performance.now() - startTime
      // Return graceful error diagnostic rather than crashing
      const fallbackDiag: SemanticDiagnostic = {
        id: `err-${Date.now()}`,
        fileId: request.activeFileId,
        fileName: 'unknown',
        category: 'STATIC_DIAGNOSTIC',
        severity: 'warning',
        message: `Semantic Guard internal analysis error: ${err.message || 'Worker failure'}`,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
        code: 9999,
        attribution: {
          classification: 'STATIC_DIAGNOSTIC',
          isConcurrentConflict: false,
          reason: 'Worker execution failed gracefully.',
          evidence: [String(err)],
        },
      }
      return {
        requestId: request.requestId,
        version: request.version,
        diagnostics: [fallbackDiag],
        analysisDurationMs: duration,
        isStale: false,
        timestamp: Date.now(),
      }
    }
  }

  public dispose(): void {}
}

export class DebouncedAnalysisScheduler {
  private timeoutId: any = null
  private requestedVersion: number = 0
  private executingVersion: number | null = null
  private completedVersion: number = 0
  private displayedVersion: number = 0
  private activeRequestId: string | null = null
  private worker: IAnalysisWorker
  private debounceMs: number

  constructor(worker?: IAnalysisWorker, debounceMs: number = 200) {
    this.worker = worker || new WebWorkerAnalysisWorker()
    this.debounceMs = debounceMs
  }

  /**
   * Schedule a new analysis request. Cancels and supersedes any pending work.
   */
  public schedule(
    requestData: Omit<AnalysisRequest, 'version' | 'requestId'>,
    onResult: (response: AnalysisResponse) => void
  ): { version: number; requestId: string } {
    this.requestedVersion++
    const version = this.requestedVersion
    const requestId = `req-${version}-${Date.now()}`

    this.cancelPending()

    const fullRequest: AnalysisRequest = {
      ...requestData,
      version,
      requestId,
    }

    this.timeoutId = setTimeout(async () => {
      await this.executeRequest(fullRequest, onResult)
    }, this.debounceMs)

    return { version, requestId }
  }

  /**
   * Execute an analysis request immediately without debounce.
   */
  public async flushImmediately(
    requestData: Omit<AnalysisRequest, 'version' | 'requestId'>,
    onResult: (response: AnalysisResponse) => void
  ): Promise<AnalysisResponse> {
    this.requestedVersion++
    const version = this.requestedVersion
    const requestId = `req-immediate-${version}-${Date.now()}`

    this.cancelPending()

    const fullRequest: AnalysisRequest = {
      ...requestData,
      version,
      requestId,
    }

    return this.executeRequest(fullRequest, onResult)
  }

  private async executeRequest(
    request: AnalysisRequest,
    onResult: (response: AnalysisResponse) => void
  ): Promise<AnalysisResponse> {
    this.executingVersion = request.version
    this.activeRequestId = request.requestId

    let response: AnalysisResponse
    try {
      response = await this.worker.analyze(request)
    } catch (err: any) {
      response = {
        requestId: request.requestId,
        version: request.version,
        diagnostics: [
          {
            id: `err-${Date.now()}`,
            fileId: request.activeFileId,
            fileName: 'unknown',
            category: 'STATIC_DIAGNOSTIC',
            severity: 'warning',
            message: `Semantic Guard internal worker error: ${err.message || 'Worker failure'}`,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1,
            code: 9999,
            attribution: {
              classification: 'STATIC_DIAGNOSTIC',
              isConcurrentConflict: false,
              reason: 'Worker execution failed gracefully.',
              evidence: [String(err)],
            },
          },
        ],
        analysisDurationMs: 0,
        isStale: false,
        timestamp: Date.now(),
      }
    } finally {
      if (this.activeRequestId === request.requestId) {
        this.executingVersion = null
      }
    }

    // Stale-result rejection: discard if newer version was requested or already completed
    if (response.version < this.requestedVersion || response.version < this.completedVersion) {
      response.isStale = true
      return response
    }

    this.completedVersion = response.version
    this.displayedVersion = response.version
    onResult(response)
    return response
  }

  public cancelPending(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }

    if (this.worker.cancel && this.activeRequestId && this.executingVersion !== null) {
      this.worker.cancel(this.activeRequestId, this.executingVersion)
    }
  }

  public getCurrentVersion(): number {
    return this.requestedVersion
  }

  public getRequestedVersion(): number {
    return this.requestedVersion
  }

  public getExecutingVersion(): number | null {
    return this.executingVersion
  }

  public getLatestCompletedVersion(): number {
    return this.completedVersion
  }

  public getCompletedVersion(): number {
    return this.completedVersion
  }

  public getDisplayedVersion(): number {
    return this.displayedVersion
  }

  public getWorker(): IAnalysisWorker {
    return this.worker
  }

  public dispose(): void {
    this.cancelPending()
    this.worker.dispose()
  }
}

