/**
 * packages/client/src/lib/semantic-guard/monaco-adapter.ts
 *
 * Integrates Semantic Guard diagnostics with Monaco Editor markers.
 * Maps diagnostics to IMarkerData and manages marker lifecycle (updating and clearing).
 */

import { SemanticDiagnostic } from './types'

export interface MonacoMarkerData {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  message: string
  severity: number // 8 = Error, 4 = Warning, 2 = Info, 1 = Hint
  source: string
}

export class MonacoDiagnosticAdapter {
  public static readonly OWNER = 'semantic-guard'

  /**
   * Convert SemanticDiagnostic array to Monaco-compatible marker data.
   */
  public static toMonacoMarkers(diagnostics: SemanticDiagnostic[]): MonacoMarkerData[] {
    return diagnostics.map((d) => {
      let severity = 8 // Error default

      if (d.category === 'LIKELY_CONCURRENT_CONFLICT') {
        severity = 4 // Warning
      } else if (d.severity === 'warning') {
        severity = 4 // Warning
      } else if (d.severity === 'info') {
        severity = 2 // Info
      } else if (d.severity === 'hint') {
        severity = 1 // Hint
      }

      return {
        startLineNumber: Math.max(1, d.startLine),
        startColumn: Math.max(1, d.startColumn),
        endLineNumber: Math.max(1, d.endLine),
        endColumn: Math.max(1, d.endColumn),
        message: d.message,
        severity,
        source: 'Semantic Guard',
      }
    })
  }

  /**
   * Applies diagnostics as Monaco editor model markers.
   */
  public static applyMarkers(
    monacoInstance: any,
    model: any,
    diagnostics: SemanticDiagnostic[]
  ): void {
    if (!monacoInstance || !monacoInstance.editor || !model) return
    const markers = this.toMonacoMarkers(diagnostics)
    monacoInstance.editor.setModelMarkers(model, this.OWNER, markers)
  }

  /**
   * Clears all Semantic Guard markers from the Monaco model.
   */
  public static clearMarkers(monacoInstance: any, model: any): void {
    if (!monacoInstance || !monacoInstance.editor || !model) return
    monacoInstance.editor.setModelMarkers(model, this.OWNER, [])
  }
}
