/**
 * Deterministically generate a vibrant color from a numeric clientID.
 * Uses golden-ratio hue stepping so consecutive clientIDs never clash.
 */
export function colorFromClientId(clientId: number): string {
  const hue = (clientId * 137.508) % 360 // golden angle
  return `hsl(${Math.round(hue)}, 80%, 60%)`
}

/**
 * A dimmer version of the cursor color for selection background highlights.
 */
export function selectionColorFromClientId(clientId: number): string {
  const hue = (clientId * 137.508) % 360
  return `hsla(${Math.round(hue)}, 75%, 55%, 0.25)`
}

/** Short human-readable label e.g. "User A", "User B" */
export function labelFromIndex(index: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  return `User ${letters[index % letters.length] ?? index}`
}
