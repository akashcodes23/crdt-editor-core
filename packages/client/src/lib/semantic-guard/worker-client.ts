/**
 * packages/client/src/lib/semantic-guard/worker-client.ts
 *
 * Client-side Web Worker manager for Converge Semantic Guard.
 * Manages the real browser Web Worker lifecycle: instantiation, typed messaging,
 * stale request tracking, crash recovery with automatic restart, and clean disposal.
 */

import {
  AnalysisRequest,
  AnalysisResponse,
  IAnalysisWorker,
  SemanticDiagnostic,
} from './types'
import {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  isWorkerOutboundMessage,
} from './protocol'
import { LocalAnalysisWorker } from './scheduler'

import { createWorker } from './worker-loader'

declare const window: any
declare const Worker: any

export type IBrowserWorker = {
  postMessage(message: any, transfer?: any[]): void
  terminate(): void
  onmessage: ((this: any, ev: any) => any) | null
  onerror: ((this: any, ev: any) => any) | null
}

export interface WebWorkerOptions {
  workerFactory?: () => IBrowserWorker
  maxRestarts?: number
  fallbackToLocal?: boolean
}

export class WebWorkerAnalysisWorker implements IAnalysisWorker {
  private worker: IBrowserWorker | null = null
  private pendingRequests: Map<
    string,
    {
      resolve: (res: AnalysisResponse) => void
      reject: (err: any) => void
      request: AnalysisRequest
    }
  > = new Map()
  private isDisposed: boolean = false
  private isReady: boolean = false
  private restartCount: number = 0
  private maxRestarts: number
  private workerFactory?: () => IBrowserWorker
  private localFallback: LocalAnalysisWorker | null = null
  private activeVersion: number = 0

  constructor(options: WebWorkerOptions = {}) {
    this.workerFactory = options.workerFactory
    this.maxRestarts = options.maxRestarts ?? 3

    if (options.fallbackToLocal) {
      this.localFallback = new LocalAnalysisWorker()
      return
    }

    this.initWorker()
  }

  private initWorker(): void {
    if (this.isDisposed) return

    try {
      if (this.workerFactory) {
        this.worker = this.workerFactory()
      } else {
        this.worker = createWorker()
      }

      if (!this.worker) {
        console.warn('[SemanticGuard] Worker not available; falling back to in-memory analysis.')
        this.localFallback = new LocalAnalysisWorker()
        return
      }

      this.worker.onmessage = this.handleWorkerMessage.bind(this)
      this.worker.onerror = this.handleWorkerError.bind(this)
    } catch (err) {
      console.error('[SemanticGuard] Failed to initialize Web Worker:', err)
      this.localFallback = new LocalAnalysisWorker()
    }
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const data = event.data
    if (!isWorkerOutboundMessage(data)) {
      return
    }

    if (data.type === 'WORKER_READY') {
      this.isReady = true
      return
    }

    if (data.type === 'PONG') {
      return
    }

    if (data.type === 'ANALYZE_SUCCESS') {
      const entry = this.pendingRequests.get(data.response.requestId)
      if (entry) {
        this.pendingRequests.delete(data.response.requestId)
        entry.resolve(data.response)
      }
      return
    }

    if (data.type === 'ANALYZE_ERROR') {
      const entry = this.pendingRequests.get(data.requestId)
      if (entry) {
        this.pendingRequests.delete(data.requestId)
        // Synthesize fallback diagnostic for worker error
        const fallbackDiag: SemanticDiagnostic = {
          id: `worker-err-${Date.now()}`,
          fileId: entry.request.activeFileId,
          fileName: 'unknown',
          category: 'STATIC_DIAGNOSTIC',
          severity: 'warning',
          message: `Semantic Guard worker analysis error: ${data.error}`,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 1,
          code: 9999,
          attribution: {
            classification: 'STATIC_DIAGNOSTIC',
            isConcurrentConflict: false,
            reason: 'Worker analysis caught error gracefully.',
            evidence: [data.error],
          },
        }

        entry.resolve({
          requestId: data.requestId,
          version: data.version,
          diagnostics: [fallbackDiag],
          analysisDurationMs: data.durationMs,
          isStale: false,
          timestamp: Date.now(),
        })
      }
    }
  }

  private handleWorkerError(error: any): void {
    console.error('[SemanticGuard] Worker fatal error occurred:', error)

    // Fail all pending requests with error diagnostics
    const pending = Array.from(this.pendingRequests.values())
    this.pendingRequests.clear()

    for (const item of pending) {
      const fallbackDiag: SemanticDiagnostic = {
        id: `crash-err-${Date.now()}`,
        fileId: item.request.activeFileId,
        fileName: 'unknown',
        category: 'STATIC_DIAGNOSTIC',
        severity: 'warning',
        message: `Semantic Guard worker crashed: ${error?.message || 'Worker terminated'}`,
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 1,
        code: 9999,
        attribution: {
          classification: 'STATIC_DIAGNOSTIC',
          isConcurrentConflict: false,
          reason: 'Worker crashed during execution.',
          evidence: [String(error?.message || error)],
        },
      }

      item.resolve({
        requestId: item.request.requestId,
        version: item.request.version,
        diagnostics: [fallbackDiag],
        analysisDurationMs: 0,
        isStale: false,
        timestamp: Date.now(),
      })
    }

    // Terminate the crashed worker
    if (this.worker) {
      try {
        this.worker.terminate()
      } catch (_e) {}
      this.worker = null
    }

    // Attempt crash recovery
    if (this.restartCount < this.maxRestarts && !this.isDisposed) {
      this.restartCount++
      console.log(`[SemanticGuard] Restarting worker (attempt ${this.restartCount}/${this.maxRestarts})...`)
      this.initWorker()
    } else {
      console.warn('[SemanticGuard] Max worker restarts reached; permanently falling back to local runner.')
      this.localFallback = new LocalAnalysisWorker()
    }
  }

  public async analyze(request: AnalysisRequest): Promise<AnalysisResponse> {
    if (this.isDisposed) {
      throw new Error('WebWorkerAnalysisWorker has been disposed.')
    }

    if (this.localFallback) {
      return this.localFallback.analyze(request)
    }

    this.activeVersion = request.version

    return new Promise<AnalysisResponse>((resolve, reject) => {
      this.pendingRequests.set(request.requestId, { resolve, reject, request })

      const msg: WorkerInboundMessage = {
        type: 'ANALYZE_REQUEST',
        request,
      }

      try {
        this.worker?.postMessage(msg)
      } catch (err) {
        this.pendingRequests.delete(request.requestId)
        this.handleWorkerError(err)
      }
    })
  }

  public cancel(requestId: string, version: number): void {
    const entry = this.pendingRequests.get(requestId)
    if (entry) {
      this.pendingRequests.delete(requestId)
      entry.resolve({
        requestId,
        version,
        diagnostics: [],
        analysisDurationMs: 0,
        isStale: true,
        timestamp: Date.now(),
      })
      if (this.worker) {
        const cancelMsg: WorkerInboundMessage = {
          type: 'CANCEL_REQUEST',
          requestId,
          version,
        }
        try {
          this.worker.postMessage(cancelMsg)
        } catch (_e) {}
      }
    }
  }

  public getRestartCount(): number {
    return this.restartCount
  }

  public isUsingLocalFallback(): boolean {
    return this.localFallback !== null
  }

  public dispose(): void {
    this.isDisposed = true

    for (const [id, item] of this.pendingRequests.entries()) {
      item.resolve({
        requestId: id,
        version: item.request.version,
        diagnostics: [],
        analysisDurationMs: 0,
        isStale: true,
        timestamp: Date.now(),
      })
    }
    this.pendingRequests.clear()

    if (this.worker) {
      try {
        this.worker.terminate()
      } catch (_e) {}
      this.worker = null
    }

    if (this.localFallback) {
      this.localFallback.dispose()
      this.localFallback = null
    }
  }
}
