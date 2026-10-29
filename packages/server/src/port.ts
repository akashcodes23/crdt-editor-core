/**
 * Network port resolution and validation module.
 *
 * Provides fail-closed, robust port resolution for cloud deployment platforms
 * (Render, Fly.io, Railway, etc.) and local development.
 */

export const DEFAULT_PORT = 1234

/**
 * Resolves and strictly validates the network port for the server.
 *
 * Requirements:
 * 1. When PORT is absent (undefined), defaults to local-development fallback (1234).
 * 2. When PORT is explicitly supplied:
 *    - Must be a non-empty string.
 *    - Must consist strictly of decimal digits (no decimals, signs, or alphanumeric characters).
 *    - Must be an integer between 1 and 65535.
 * 3. Never returns NaN, an empty string, null, or out-of-range values.
 * 4. Fails early with a clear descriptive Error on any invalid port configuration.
 *
 * @param rawPort The raw PORT environment variable (typically process.env.PORT)
 * @param defaultPort Fallback port for local development when PORT is absent (default: 1234)
 * @returns Validated integer port between 1 and 65535
 */
export function resolvePort(rawPort: string | undefined, defaultPort = DEFAULT_PORT): number {
  // 1. Absent PORT: fallback to documented local development port
  if (rawPort === undefined) {
    return defaultPort
  }

  // 2. Explicitly supplied PORT: validate non-empty
  const trimmed = rawPort.trim()
  if (trimmed === '') {
    throw new Error(
      `Invalid PORT configuration: PORT is set to an empty string. Expected an integer between 1 and 65535, or omit PORT to default to ${defaultPort}.`
    )
  }

  // 3. Strictly validate integer representation (rejects decimals like 1234.5, hex, letters, NaN, -1)
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid PORT configuration: "${rawPort}" is not a valid integer. Expected an integer between 1 and 65535.`
    )
  }

  const portNum = Number(trimmed)

  // 4. Validate valid port range [1, 65535]
  if (!Number.isSafeInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(
      `Invalid PORT configuration: port ${portNum} is out of range. Expected an integer between 1 and 65535.`
    )
  }

  return portNum
}

