/**
 * packages/client/src/lib/semantic-guard/attribution.ts
 *
 * Conflict Attribution Engine for Converge Semantic Guard.
 * Separates ordinary syntax and compiler errors from true concurrent semantic merge conflicts.
 */

import { RawDiagnostic } from './checker'
import {
  SemanticDiagnostic,
  DiagnosticCategory,
  ConflictAttribution,
  MergeProvenance,
} from './types'

export class ConflictAttributionEngine {
  /**
   * Evaluates raw compiler diagnostics against edit provenance and merge history
   * to deterministically classify each diagnostic into the appropriate category.
   */
  public static attributeDiagnostics(
    rawDiagnostics: RawDiagnostic[],
    provenance?: MergeProvenance,
    baselineDiagnostics?: SemanticDiagnostic[]
  ): SemanticDiagnostic[] {
    return rawDiagnostics.map((raw, idx) => {
      const attribution = this.computeAttribution(raw, provenance, baselineDiagnostics)

      let category = attribution.classification
      let message = raw.message

      // Format diagnostic message based on classification
      if (category === 'CONFIRMED_CONCURRENT_CONFLICT') {
        message = `[Semantic Guard: Confirmed Conflict] ${raw.message} (${attribution.reason})`
      } else if (category === 'LIKELY_CONCURRENT_CONFLICT') {
        message = `[Semantic Guard: Likely Conflict] ${raw.message} (${attribution.reason})`
      } else if (category === 'SYNTAX_ERROR') {
        message = `[Semantic Guard: Syntax Error] ${raw.message}`
      } else {
        message = `[Semantic Guard] ${raw.message}`
      }

      return {
        id: `diag-${Date.now()}-${idx}-${raw.code}`,
        fileId: raw.fileId,
        fileName: raw.fileName,
        category,
        severity: raw.severity,
        message,
        startLine: raw.startLine,
        startColumn: raw.startColumn,
        endLine: raw.endLine,
        endColumn: raw.endColumn,
        code: raw.code,
        symbolName: raw.symbolName,
        attribution,
      }
    })
  }

  private static computeAttribution(
    raw: RawDiagnostic,
    provenance?: MergeProvenance,
    baselineDiagnostics?: SemanticDiagnostic[]
  ): ConflictAttribution {
    // 1. Syntactic parse errors are always categorized as SYNTAX_ERROR
    if (raw.isSyntaxError) {
      return {
        classification: 'SYNTAX_ERROR',
        isConcurrentConflict: false,
        reason: 'Syntactic parsing failure; malformed token or expression grammar.',
        evidence: [`TypeScript parser error TS${raw.code}`],
      }
    }

    // 2. Pre-existing error check: If the error already existed in baseline before merge,
    // it was NOT caused by the remote merge!
    if (baselineDiagnostics && baselineDiagnostics.length > 0) {
      const existedBefore = baselineDiagnostics.some(
        (b) =>
          b.code === raw.code &&
          (b.fileId === raw.fileId || b.fileName === raw.fileName) &&
          b.symbolName === raw.symbolName
      )
      if (existedBefore) {
        return {
          classification: 'STATIC_DIAGNOSTIC',
          isConcurrentConflict: false,
          targetSymbol: raw.symbolName,
          reason: 'Pre-existing diagnostic prior to merge; independent of concurrent edits.',
          evidence: ['Diagnostic existed in local baseline before remote update arrived.'],
        }
      }
    }

    // 3. If a remote merge recently occurred, evaluate causal correlation
    if (provenance && provenance.occurred) {
      const target = raw.symbolName
      const mutatedList = provenance.mutatedDeclarations || []
      const declaredList = provenance.declaredSymbols || []
      const changedFiles = provenance.changedFiles || provenance.changedFileIds || []

      // File Scoping: If changedFiles is populated and does NOT include this file or symbol,
      // the remote edit was on an unrelated file!
      const fileTouched =
        changedFiles.length === 0 ||
        changedFiles.some((f) => f === raw.fileId || raw.fileName.includes(f) || f.includes(raw.fileName))

      if (!fileTouched && (!target || !mutatedList.includes(target))) {
        return {
          classification: 'STATIC_DIAGNOSTIC',
          isConcurrentConflict: false,
          targetSymbol: target,
          reason: 'Remote edit occurred on an unrelated file; independent of this diagnostic.',
          evidence: [
            `Remote update touched [${changedFiles.join(', ')}], which does not affect ${raw.fileName}.`,
          ],
        }
      }

      // Scenario A: Remote peer mutated or deleted the declaration of target symbol
      const isMutatedTarget =
        target &&
        (mutatedList.includes(target) ||
          provenance.targetSymbol === target)

      if (isMutatedTarget) {
        return {
          classification: 'CONFIRMED_CONCURRENT_CONFLICT',
          isConcurrentConflict: true,
          targetSymbol: target,
          remoteClientId: provenance.sourceClientId,
          reason: `Remote peer #${provenance.sourceClientId ?? 'remote'} concurrently mutated or removed declaration '${target}'.`,
          evidence: [
            `CRDT merged concurrent operations cleanly.`,
            `Remote peer #${provenance.sourceClientId ?? 'remote'} altered or removed declaration '${target}'.`,
            `Local replica retains an active reference to unresolved symbol '${target}'.`,
          ],
        }
      }

      // Scenario B: Concurrent duplicate declarations (TS2451 / TS2300)
      if (raw.code === 2451 || raw.code === 2300) {
        const wasConcurrentlyDeclared =
          target &&
          (declaredList.includes(target) || provenance.targetSymbol === target)

        if (wasConcurrentlyDeclared) {
          return {
            classification: 'CONFIRMED_CONCURRENT_CONFLICT',
            isConcurrentConflict: true,
            targetSymbol: target,
            remoteClientId: provenance.sourceClientId,
            reason: `Concurrent duplicate declaration for '${target ?? 'identifier'}' introduced across replicas.`,
            evidence: [
              `Both replicas concurrently declared identifier '${target ?? 'variable'}'.`,
              `CRDT state contains conflicting block-scoped declarations in the same scope.`,
            ],
          }
        }

        // If duplicate declaration was not concurrently introduced by remote peer, classify as STATIC
        return {
          classification: 'STATIC_DIAGNOSTIC',
          isConcurrentConflict: false,
          targetSymbol: target,
          reason: 'Duplicate declaration created locally; independent of remote edit.',
          evidence: ['Local duplicate declaration.'],
        }
      }

      // Scenario C: Error emerged immediately following merge in a touched file, but exact symbol causal provenance is uncertain
      if (fileTouched) {
        return {
          classification: 'LIKELY_CONCURRENT_CONFLICT',
          isConcurrentConflict: true,
          targetSymbol: target,
          remoteClientId: provenance.sourceClientId,
          reason: `Emerged following merge from peer #${provenance.sourceClientId ?? 'remote'}; causal provenance cannot be conclusively established.`,
          evidence: [
            `Diagnostic appeared immediately after remote update merge.`,
            `Uncertainty reported: indirect type propagation or unindexed declaration delta.`,
          ],
        }
      }
    }

    // 4. Ordinary single-user static analysis diagnostic
    return {
      classification: 'STATIC_DIAGNOSTIC',
      isConcurrentConflict: false,
      targetSymbol: raw.symbolName,
      reason: 'Standard static analysis diagnostic; no concurrent remote mutation detected.',
      evidence: ['Local single-replica edit; independent of remote sync.'],
    }
  }
}
