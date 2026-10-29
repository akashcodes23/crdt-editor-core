/**
 * packages/client/src/lib/semantic-guard/worker-loader.ts
 *
 * Dedicated loader for the genuine browser Web Worker.
 * Contains the Webpack 5 static `new Worker(new URL(..., import.meta.url))` expression
 * ensuring isolated browser bundling without contaminating server/Node environments.
 */

import { IBrowserWorker } from './worker-client'

declare const Worker: any

export function createWorker(): IBrowserWorker | null {
  if (typeof window === 'undefined' || typeof (window as any).Worker === 'undefined') {
    return null
  }
  try {
    return new Worker(new URL('./semantic-guard.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch (err) {
    console.error('[SemanticGuard] Worker instantiation failed:', err)
    return null
  }
}
