/**
 * packages/client/src/lib/semantic-guard/checker.ts
 *
 * In-memory TypeScript Compiler Host & AST Checker for multi-file collaborative workspaces.
 * Executes both syntactic and semantic analysis across stable file identities.
 */

import * as ts from 'typescript'
import { MINIMAL_LIB_D_TS } from './lib-defs'
import { AnalysisRequest, SemanticDiagnostic, DiagnosticCategory, DiagnosticSeverity } from './types'

export interface RawDiagnostic {
  fileId: string
  fileName: string
  code: number
  message: string
  severity: DiagnosticSeverity
  isSyntaxError: boolean
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  symbolName?: string
}

export class SemanticChecker {
  private static readonly LIB_FILE_NAME = '/lib.d.ts'

  /**
   * Run in-memory TypeScript compiler program on workspace files.
   */
  public static checkWorkspace(request: AnalysisRequest): RawDiagnostic[] {
    const fileMap = new Map<string, { id: string; name: string; content: string }>()
    const pathToFileId = new Map<string, string>()

    // Index all workspace files by virtual path
    for (const f of request.files) {
      const vPath = `/workspace/${f.name}`
      fileMap.set(vPath, f)
      pathToFileId.set(vPath, f.id)
      pathToFileId.set(f.name, f.id)
    }

    const host: ts.CompilerHost = {
      getSourceFile: (fileName: string) => {
        if (fileName === SemanticChecker.LIB_FILE_NAME) {
          return ts.createSourceFile(fileName, MINIMAL_LIB_D_TS, ts.ScriptTarget.Latest, true)
        }
        const file = fileMap.get(fileName)
        if (file) {
          return ts.createSourceFile(fileName, file.content, ts.ScriptTarget.Latest, true)
        }
        return undefined
      },
      getDefaultLibFileName: () => SemanticChecker.LIB_FILE_NAME,
      writeFile: () => {},
      getCurrentDirectory: () => '/workspace',
      getDirectories: () => [],
      getCanonicalFileName: (f: string) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (fileName: string) => {
        return fileName === SemanticChecker.LIB_FILE_NAME || fileMap.has(fileName)
      },
      readFile: (fileName: string) => {
        if (fileName === SemanticChecker.LIB_FILE_NAME) return MINIMAL_LIB_D_TS
        return fileMap.get(fileName)?.content
      },
      resolveModuleNames: (moduleNames: string[], containingFile: string) => {
        return moduleNames.map((modName) => {
          let candidate = modName
          if (candidate.startsWith('./') || candidate.startsWith('../')) {
            const clean = candidate.replace(/^\.\//, '')
            // Check possible extensions
            const extensions = ['.ts', '.tsx', '.js', '.jsx', '']
            for (const ext of extensions) {
              const testPath = `/workspace/${clean}${ext}`
              if (fileMap.has(testPath)) {
                return {
                  resolvedFileName: testPath,
                  extension: ts.Extension.Ts,
                  isExternalLibraryImport: false,
                }
              }
            }
          }
          return undefined
        })
      },
    }

    const rootNames = Array.from(fileMap.keys())
    if (rootNames.length === 0) return []

    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowJs: true,
      noEmit: true,
      skipLibCheck: true,
      noLib: false,
    }

    const program = ts.createProgram(rootNames, compilerOptions, host)
    const tsDiagnostics = ts.getPreEmitDiagnostics(program)

    const rawDiagnostics: RawDiagnostic[] = []

    for (const diag of tsDiagnostics) {
      if (!diag.file) continue

      const fileName = diag.file.fileName
      if (fileName === SemanticChecker.LIB_FILE_NAME) continue

      const fileId = pathToFileId.get(fileName) || fileName
      const fileData = fileMap.get(fileName)
      const baseName = fileData ? fileData.name : fileName

      const start = diag.start ?? 0
      const length = diag.length ?? 1
      const pos = diag.file.getLineAndCharacterOfPosition(start)
      const endPos = diag.file.getLineAndCharacterOfPosition(start + length)

      const startLine = pos.line + 1
      const startColumn = pos.character + 1
      const endLine = endPos.line + 1
      const endColumn = endPos.character + 1

      const rawMessage = ts.flattenDiagnosticMessageText(diag.messageText, ' ')
      const isSyntaxError = diag.code >= 1000 && diag.code < 2000

      let severity: DiagnosticSeverity = 'error'
      if (diag.category === ts.DiagnosticCategory.Warning) severity = 'warning'
      else if (diag.category === ts.DiagnosticCategory.Suggestion) severity = 'hint'
      else if (diag.category === ts.DiagnosticCategory.Message) severity = 'info'

      const symbolName = SemanticChecker.extractSymbolFromMessage(rawMessage, diag.code)

      rawDiagnostics.push({
        fileId,
        fileName: baseName,
        code: diag.code,
        message: rawMessage,
        severity,
        isSyntaxError,
        startLine,
        startColumn,
        endLine,
        endColumn,
        symbolName,
      })
    }

    return rawDiagnostics
  }

  /**
   * Extracts symbol or identifier name referenced by the diagnostic message.
   */
  public static extractSymbolFromMessage(message: string, code: number): string | undefined {
    // Cannot find name 'XYZ'
    let match = message.match(/Cannot find name '([^']+)'/)
    if (match) return match[1]

    // Module '"..."' has no exported member 'XYZ'
    match = message.match(/has no exported member '([^']+)'/)
    if (match) return match[1]

    // Property 'XYZ' does not exist on type '...'
    match = message.match(/Property '([^']+)' does not exist on type/)
    if (match) return match[1]

    // Cannot redeclare block-scoped variable 'XYZ'
    match = message.match(/Cannot redeclare block-scoped variable '([^']+)'/)
    if (match) return match[1]

    // Duplicate identifier 'XYZ'
    match = message.match(/Duplicate identifier '([^']+)'/)
    if (match) return match[1]

    // Variable 'XYZ' is used before being assigned
    match = message.match(/Variable '([^']+)' is used before being assigned/)
    if (match) return match[1]

    return undefined
  }
}
