'use client'

import { useEffect, useRef } from 'react'
import type monaco from 'monaco-editor'
import type { RemoteCursorState } from '@/hooks/useAwareness'
import { selectionColorFromClientId } from '@/lib/colors'

interface CursorOverlayProps {
  editor: monaco.editor.IStandaloneCodeEditor | null
  remoteStates: RemoteCursorState[]
  mergeFlashRange?: { start: number; end: number } | null
  onFlashComplete?: () => void
}

/**
 * Renders remote cursors and selection highlights as Monaco decorations.
 * Decorations are delta-applied so unchanged cursors don't flicker.
 */
export function CursorOverlay({ editor, remoteStates, mergeFlashRange, onFlashComplete }: CursorOverlayProps) {
  const decorationsRef = useRef<string[]>([])
  const mergeFlashRef = useRef<string[]>([])

  useEffect(() => {
    if (!editor) return

    const model = editor.getModel()
    if (!model) return

    const newDecorations: monaco.editor.IModelDeltaDecoration[] = []

    remoteStates.forEach((state) => {
      if (!state.cursor) return

      const { index, length } = state.cursor
      const startPos = model.getPositionAt(index)
      const endPos = model.getPositionAt(index + Math.max(0, length))

      const selectionColor = selectionColorFromClientId(state.clientID)
      const cursorColor = state.color

      // Selection highlight
      if (length > 0) {
        newDecorations.push({
          range: {
            startLineNumber: startPos.lineNumber,
            startColumn: startPos.column,
            endLineNumber: endPos.lineNumber,
            endColumn: endPos.column,
          },
          options: {
            className: `remote-selection remote-selection-${state.clientID}`,
            stickiness: 1, // NeverGrowsWhenTypingAtEdges
          },
        })

        injectStyle(
          `remote-selection-style-${state.clientID}`,
          `.remote-selection-${state.clientID} { background: ${selectionColor}; }`
        )
      }

      // Cursor line decoration
      newDecorations.push({
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: startPos.lineNumber,
          endColumn: startPos.column,
        },
        options: {
          className: `remote-cursor remote-cursor-${state.clientID}`,
          stickiness: 1,
          hoverMessage: { value: `**${state.name}**` },
        },
      })

      injectStyle(
        `remote-cursor-style-${state.clientID}`,
        `.remote-cursor-${state.clientID}::before {
          content: '';
          position: absolute;
          border-left: 2px solid ${cursorColor};
          height: 1.2em;
          margin-top: 1px;
        }`
      )
    })

    decorationsRef.current = editor.deltaDecorations(
      decorationsRef.current,
      newDecorations
    )
  }, [editor, remoteStates])

  // Separate effect for the ephemeral merge flash to avoid flickering
  useEffect(() => {
    if (!editor || !mergeFlashRange) return
    const model = editor.getModel()
    if (!model) return

    const startPos = model.getPositionAt(mergeFlashRange.start)
    const endPos = model.getPositionAt(mergeFlashRange.end)

    mergeFlashRef.current = editor.deltaDecorations(mergeFlashRef.current, [{
      range: {
        startLineNumber: startPos.lineNumber,
        startColumn: startPos.column,
        endLineNumber: endPos.lineNumber,
        endColumn: endPos.column,
      },
      options: {
        className: 'merge-flash',
        stickiness: 1, // NeverGrowsWhenTypingAtEdges
      },
    }])

    const timer = setTimeout(() => {
      if (editor) {
        mergeFlashRef.current = editor.deltaDecorations(mergeFlashRef.current, [])
      }
      onFlashComplete?.()
    }, 2000)

    return () => clearTimeout(timer)
  }, [editor, mergeFlashRange, onFlashComplete])

  return null
}

/** Inject or update a <style> tag by a stable ID */
function injectStyle(id: string, css: string): void {
  if (typeof document === 'undefined') return
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = css
}
