/**
 * packages/client/src/lib/semantic-guard/semantic-guard.worker.ts
 *
 * Genuine browser Web Worker executing Converge Semantic Guard in isolation.
 * Performs TypeScript AST parsing, virtual compiler checks, and conflict attribution
 * completely off the browser main thread.
 */

import { SemanticChecker } from './checker'
import { ConflictAttributionEngine } from './attribution'
import {
  WorkerInboundMessage,
  WorkerOutboundMessage,
  isWorkerInboundMessage,
} from './protocol'

// Post ready signal upon script execution in worker context
if (typeof self !== 'undefined' && typeof (self as any).postMessage === 'function') {
  try {
    const readyMsg: WorkerOutboundMessage = { type: 'WORKER_READY' }
    ;(self as any).postMessage(readyMsg)
  } catch (_e) {
    // Ignored in non-worker environments (e.g., node import)
  }

  self.addEventListener('message', (event: MessageEvent) => {
    const data = event.data
    if (!isWorkerInboundMessage(data)) {
      return
    }

    if (data.type === 'PING') {
      const pongMsg: WorkerOutboundMessage = { type: 'PONG', id: data.id }
      ;(self as any).postMessage(pongMsg)
      return
    }

    if (data.type === 'ANALYZE_REQUEST') {
      const { request } = data
      const startTime = performance.now()

      try {
        const raw = SemanticChecker.checkWorkspace(request)
        const diagnostics = ConflictAttributionEngine.attributeDiagnostics(
          raw,
          request.provenance,
          request.baselineDiagnostics
        )
        const duration = performance.now() - startTime

        const successMsg: WorkerOutboundMessage = {
          type: 'ANALYZE_SUCCESS',
          response: {
            requestId: request.requestId,
            version: request.version,
            diagnostics,
            analysisDurationMs: duration,
            isStale: false,
            timestamp: Date.now(),
          },
        }

        ;(self as any).postMessage(successMsg)
      } catch (err: any) {
        const duration = performance.now() - startTime
        const errorMsg: WorkerOutboundMessage = {
          type: 'ANALYZE_ERROR',
          requestId: request.requestId,
          version: request.version,
          error: String(err?.message || err || 'Unknown worker analysis error'),
          durationMs: duration,
        }

        ;(self as any).postMessage(errorMsg)
      }
    }
  })
}
