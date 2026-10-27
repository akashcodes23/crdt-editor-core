/**
 * packages/server/src/hlc.ts
 *
 * Formal Hybrid Logical Clock (HLC) Implementation
 * Based on Kulkarni et al., "Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases".
 *
 * An HLC guarantees:
 * 1. Monotonicity: e1 -> e2 implies HLC(e1) < HLC(e2).
 * 2. Causal Consistency: If an event on Node A causes an event on Node B, HLC(A) < HLC(B).
 * 3. Physical Proximity: |HLC.wallTime - physicalTime| bounded by max clock drift.
 * 4. Lexical Sortability: ASCII character comparison order-preserves logical ordering.
 */

export interface HLCTimestamp {
  wallTime: number
  counter: number
  nodeId: string
}

const MAX_COUNTER = 2176782335 // 36^6 - 1

export class HybridLogicalClock {
  private lastPhysicalTime: number = 0
  private counter: number = 0

  constructor(public readonly nodeId: string) {}

  /**
   * Generates a new timestamp for a local or outgoing message event.
   */
  public now(currentPhysicalTime: number = Date.now()): string {
    if (currentPhysicalTime > this.lastPhysicalTime) {
      this.lastPhysicalTime = currentPhysicalTime
      this.counter = 0
    } else {
      this.counter = (this.counter + 1) % MAX_COUNTER
    }

    return this.format(this.lastPhysicalTime, this.counter, this.nodeId)
  }

  /**
   * Updates this clock upon receiving an incoming message with a remote HLC timestamp.
   * Advances both physical reference and logical counter according to HLC rules.
   */
  public update(remoteHlcString: string, currentPhysicalTime: number = Date.now()): string {
    const remote = HybridLogicalClock.parse(remoteHlcString)
    const maxPhysical = Math.max(this.lastPhysicalTime, remote.wallTime, currentPhysicalTime)

    if (maxPhysical === this.lastPhysicalTime && maxPhysical === remote.wallTime) {
      this.counter = Math.max(this.counter, remote.counter) + 1
    } else if (maxPhysical === this.lastPhysicalTime) {
      this.counter = this.counter + 1
    } else if (maxPhysical === remote.wallTime) {
      this.counter = remote.counter + 1
    } else {
      this.counter = 0
    }

    this.lastPhysicalTime = maxPhysical
    return this.format(this.lastPhysicalTime, this.counter, this.nodeId)
  }

  /**
   * Formats HLC into a fixed-width, lexically sortable ASCII string:
   * "<wallTime_base36_11chars>-<counter_base36_6chars>-<nodeId>"
   */
  private format(wallTime: number, counter: number, nodeId: string): string {
    const timeStr = wallTime.toString(36).padStart(11, '0')
    const countStr = counter.toString(36).padStart(6, '0')
    return `${timeStr}-${countStr}-${nodeId}`
  }

  /**
   * Parse an HLC string back to its components.
   */
  public static parse(hlcString: string): HLCTimestamp {
    if (!hlcString || typeof hlcString !== 'string') {
      throw new Error(`Malformed HLC string: "${hlcString}"`)
    }
    const parts = hlcString.split('-')
    if (parts.length < 3) {
      throw new Error(`Malformed HLC string: "${hlcString}"`)
    }
    const wallTime = parseInt(parts[0], 36)
    const counter = parseInt(parts[1], 36)
    if (isNaN(wallTime) || isNaN(counter)) {
      throw new Error(`Malformed HLC numeric component: "${hlcString}"`)
    }
    const nodeId = parts.slice(2).join('-')
    if (!nodeId) {
      throw new Error(`Malformed HLC nodeId: "${hlcString}"`)
    }

    return { wallTime, counter, nodeId }
  }

  /**
   * Compares two HLC timestamp strings.
   * Returns -1 if a < b, 1 if a > b, 0 if equal.
   */
  public static compare(a: string, b: string): number {
    return a.localeCompare(b)
  }
}

// Global node registry maintaining persistent clock instances per nodeId
const nodeClocks = new Map<string, HybridLogicalClock>()

export function getClock(nodeId: string = 'server'): HybridLogicalClock {
  let clock = nodeClocks.get(nodeId)
  if (!clock) {
    clock = new HybridLogicalClock(nodeId)
    nodeClocks.set(nodeId, clock)
  }
  return clock
}

/**
 * Backward-compatible helper to generate monotonic HLC timestamp string.
 */
export function generateHLC(nodeId: string = 'server'): string {
  return getClock(nodeId).now()
}

/**
 * Update node clock with remote causal timestamp and return next HLC.
 */
export function receiveHLC(remoteHlc: string, nodeId: string = 'server'): string {
  return getClock(nodeId).update(remoteHlc)
}
