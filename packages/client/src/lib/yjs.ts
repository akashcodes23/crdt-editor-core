import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'

// ── Shared Yjs document key ───────────────────────────────────────────────────
export const TEXT_KEY = 'code'
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:1234'
export const ROOM_NAME = process.env.NEXT_PUBLIC_ROOM_NAME || 'demo'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the Y.Text from a doc by the shared key */
export function getSharedText(doc: Y.Doc): Y.Text {
  return doc.getText(TEXT_KEY)
}

/**
 * Decode a state vector binary into a human-readable map of
 * { clientID (decimal string) → clock (number) }.
 * Used for the VectorClock sidebar.
 */
export function decodeStateVectorToMap(
  stateVector: Uint8Array
): Map<string, number> {
  const raw = Y.decodeStateVector(stateVector)
  const result = new Map<string, number>()
  raw.forEach((clock, clientId) => {
    result.set(String(clientId), clock)
  })
  return result
}

/** Encode the current state vector of a doc */
export function encodeStateVec(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc)
}

// ── Awareness local state type ────────────────────────────────────────────────
export interface CursorState {
  user: {
    name: string
    color: string
    clientID: number
  }
  cursor: {
    index: number
    length: number
  } | null
}

export type AwarenessState = Map<number, CursorState>

/** Extract typed awareness states from a raw awareness instance */
export function getAwarenessStates(
  awareness: awarenessProtocol.Awareness
): AwarenessState {
  const states = awareness.getStates() as Map<number, CursorState>
  return states
}
