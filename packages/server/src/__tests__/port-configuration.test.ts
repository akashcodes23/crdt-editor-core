import { resolvePort, DEFAULT_PORT } from '../port'
import { spawnSync } from 'child_process'
import path from 'path'

describe('Network Port Configuration & Resolution (resolvePort)', () => {
  const origEnv = process.env.PORT

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.PORT = origEnv
    } else {
      delete process.env.PORT
    }
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Valid numeric PORT
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Valid numeric PORT', () => {
    it('resolves standard port strings to integers', () => {
      expect(resolvePort('3000')).toBe(3000)
      expect(resolvePort('10000')).toBe(10000) // Render standard web service port
      expect(resolvePort('8080')).toBe(8080)
      expect(resolvePort('1234')).toBe(1234)
    })

    it('trims leading and trailing whitespace from valid numeric ports', () => {
      expect(resolvePort('  10000  ')).toBe(10000)
      expect(resolvePort('\t8080\n')).toBe(8080)
    })

    it('accepts boundary ports 1 and 65535', () => {
      expect(resolvePort('1')).toBe(1)
      expect(resolvePort('65535')).toBe(65535)
    })

    it('resolves correctly from process.env.PORT', () => {
      process.env.PORT = '5000'
      expect(resolvePort(process.env.PORT)).toBe(5000)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Absent PORT in local development
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Absent PORT in local development', () => {
    it('falls back to DEFAULT_PORT (1234) when PORT is undefined', () => {
      expect(resolvePort(undefined)).toBe(DEFAULT_PORT)
      expect(DEFAULT_PORT).toBe(1234)
    })

    it('falls back to custom defaultPort when provided and PORT is undefined', () => {
      expect(resolvePort(undefined, 8000)).toBe(8000)
      expect(resolvePort(undefined, 9090)).toBe(9090)
    })

    it('uses fallback when process.env.PORT is unset', () => {
      delete process.env.PORT
      expect(resolvePort(process.env.PORT)).toBe(1234)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Empty PORT
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Empty PORT', () => {
    it('rejects an empty string and fails early with a descriptive error', () => {
      expect(() => resolvePort('')).toThrow(
        /Invalid PORT configuration: PORT is set to an empty string/
      )
    })

    it('rejects whitespace-only strings and fails early with a descriptive error', () => {
      expect(() => resolvePort('   ')).toThrow(
        /Invalid PORT configuration: PORT is set to an empty string/
      )
      expect(() => resolvePort('\t\n')).toThrow(
        /Invalid PORT configuration: PORT is set to an empty string/
      )
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Nonnumeric value
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Nonnumeric value', () => {
    it('rejects alphabetic strings', () => {
      expect(() => resolvePort('abc')).toThrow(
        /Invalid PORT configuration: "abc" is not a valid integer/
      )
      expect(() => resolvePort('PORT')).toThrow(
        /Invalid PORT configuration: "PORT" is not a valid integer/
      )
    })

    it('rejects string "NaN" without returning or propagating NaN', () => {
      expect(() => resolvePort('NaN')).toThrow(
        /Invalid PORT configuration: "NaN" is not a valid integer/
      )
    })

    it('rejects string "undefined" and "null"', () => {
      expect(() => resolvePort('undefined')).toThrow(
        /Invalid PORT configuration: "undefined" is not a valid integer/
      )
      expect(() => resolvePort('null')).toThrow(
        /Invalid PORT configuration: "null" is not a valid integer/
      )
    })

    it('rejects fractional/decimal numbers', () => {
      expect(() => resolvePort('1234.5')).toThrow(
        /Invalid PORT configuration: "1234.5" is not a valid integer/
      )
      expect(() => resolvePort('10000.00')).toThrow(
        /Invalid PORT configuration: "10000.00" is not a valid integer/
      )
    })

    it('rejects hex or exponential notations', () => {
      expect(() => resolvePort('0x1234')).toThrow(/not a valid integer/)
      expect(() => resolvePort('1e4')).toThrow(/not a valid integer/)
    })

    it('rejects alphanumeric mixtures', () => {
      expect(() => resolvePort('10000a')).toThrow(/not a valid integer/)
      expect(() => resolvePort('p10000')).toThrow(/not a valid integer/)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Out-of-range port
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Out-of-range port', () => {
    it('rejects port 0 (options.port must be >= 1 for web services)', () => {
      expect(() => resolvePort('0')).toThrow(
        /Invalid PORT configuration: port 0 is out of range/
      )
    })

    it('rejects negative ports', () => {
      expect(() => resolvePort('-1')).toThrow(/not a valid integer/)
      expect(() => resolvePort('-8080')).toThrow(/not a valid integer/)
    })

    it('rejects ports above 65535', () => {
      expect(() => resolvePort('65536')).toThrow(
        /Invalid PORT configuration: port 65536 is out of range/
      )
      expect(() => resolvePort('70000')).toThrow(
        /Invalid PORT configuration: port 70000 is out of range/
      )
      expect(() => resolvePort('999999')).toThrow(
        /Invalid PORT configuration: port 999999 is out of range/
      )
    })
  })

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Subprocess Early Exit Behavior (Never pass NaN to server.listen)
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Subprocess Startup Safety', () => {
    const serverDist = path.resolve(__dirname, '../../dist/index.js')
    const serverSrc = path.resolve(__dirname, '../port.ts')

    it('fails early with exit code 1 when PORT is invalid in a Node process', () => {
      // Execute a small inline node evaluation simulating the server index initialization
      const script = `
        const { resolvePort } = require('${serverSrc}');
        try {
          resolvePort(process.env.PORT);
        } catch (err) {
          console.error("FATAL:", err.message);
          process.exit(1);
        }
      `
      const result = spawnSync('node', ['-e', script], {
        env: { ...process.env, PORT: '' },
        encoding: 'utf8',
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('FATAL: Invalid PORT configuration: PORT is set to an empty string')
    })
  })
})

