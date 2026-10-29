/**
 * packages/client/src/lib/semantic-guard/protocol.ts
 *
 * Strongly typed message protocol for Converge Semantic Guard Web Worker.
 * Defines inbound/outbound messages, serialization validation, and error envelopes.
 */

import { AnalysisRequest, AnalysisResponse } from './types'

export type WorkerInboundMessage =
  | {
      type: 'ANALYZE_REQUEST'
      request: AnalysisRequest
    }
  | {
      type: 'CANCEL_REQUEST'
      requestId: string
      version: number
    }
  | {
      type: 'PING'
      id: string
    }

export type WorkerOutboundMessage =
  | {
      type: 'ANALYZE_SUCCESS'
      response: AnalysisResponse
    }
  | {
      type: 'ANALYZE_ERROR'
      requestId: string
      version: number
      error: string
      durationMs: number
    }
  | {
      type: 'PONG'
      id: string
    }
  | {
      type: 'WORKER_READY'
    }

export function isWorkerInboundMessage(data: any): data is WorkerInboundMessage {
  if (!data || typeof data !== 'object') return false
  if (data.type === 'ANALYZE_REQUEST') {
    return (
      data.request &&
      typeof data.request.requestId === 'string' &&
      typeof data.request.version === 'number' &&
      typeof data.request.activeFileId === 'string' &&
      Array.isArray(data.request.files)
    )
  }
  if (data.type === 'CANCEL_REQUEST') {
    return typeof data.requestId === 'string' && typeof data.version === 'number'
  }
  if (data.type === 'PING') {
    return typeof data.id === 'string'
  }
  return false
}

export function isWorkerOutboundMessage(data: any): data is WorkerOutboundMessage {
  if (!data || typeof data !== 'object') return false
  if (data.type === 'ANALYZE_SUCCESS') {
    return (
      data.response &&
      typeof data.response.requestId === 'string' &&
      typeof data.response.version === 'number' &&
      Array.isArray(data.response.diagnostics)
    )
  }
  if (data.type === 'ANALYZE_ERROR') {
    return (
      typeof data.requestId === 'string' &&
      typeof data.version === 'number' &&
      typeof data.error === 'string'
    )
  }
  if (data.type === 'PONG') {
    return typeof data.id === 'string'
  }
  if (data.type === 'WORKER_READY') {
    return true
  }
  return false
}

export function serializeProtocol(msg: WorkerInboundMessage | WorkerOutboundMessage): string {
  return JSON.stringify(msg)
}

export function deserializeProtocol<T = WorkerInboundMessage | WorkerOutboundMessage>(raw: string): T {
  return JSON.parse(raw)
}
