import { HybridLogicalClock, getClock, generateHLC, receiveHLC } from '../hlc'

describe('HLC Semantics, Monotonicity, and Boundary Verification', () => {
  it('Verifies strict monotonicity under rapid successive calls', () => {
    const clock = new HybridLogicalClock('node-a')
    const timestamps: string[] = []

    for (let i = 0; i < 100; i++) {
      timestamps.push(clock.now())
    }

    for (let i = 1; i < timestamps.length; i++) {
      const prev = timestamps[i - 1]
      const curr = timestamps[i]
      expect(curr > prev).toBe(true)
      expect(HybridLogicalClock.compare(curr, prev)).toBe(1)
    }
  })

  it('Verifies immunity to NTP clock regression (backwards time jumps)', () => {
    const clock = new HybridLogicalClock('node-regression')
    const initialWallTime = 1700000000000

    // 1. Clock generates timestamp at T = 1700000000000
    const t1 = clock.now(initialWallTime)
    const parsed1 = HybridLogicalClock.parse(t1)
    expect(parsed1.wallTime).toBe(initialWallTime)
    expect(parsed1.counter).toBe(0)

    // 2. Physical clock jumps backwards by 5000ms (NTP regression)
    const regressedWallTime = initialWallTime - 5000
    const t2 = clock.now(regressedWallTime)
    const parsed2 = HybridLogicalClock.parse(t2)

    // Clock must maintain the highest wallTime observed and increment logical counter
    expect(parsed2.wallTime).toBe(initialWallTime)
    expect(parsed2.counter).toBe(1)
    expect(t2 > t1).toBe(true)
    expect(HybridLogicalClock.compare(t2, t1)).toBe(1)

    // 3. Further call under regressed time continues logical counter increment
    const t3 = clock.now(regressedWallTime + 100)
    const parsed3 = HybridLogicalClock.parse(t3)
    expect(parsed3.wallTime).toBe(initialWallTime)
    expect(parsed3.counter).toBe(2)
    expect(t3 > t2).toBe(true)

    // 4. Time catches up beyond original wall time
    const advancedWallTime = initialWallTime + 1000
    const t4 = clock.now(advancedWallTime)
    const parsed4 = HybridLogicalClock.parse(t4)
    expect(parsed4.wallTime).toBe(advancedWallTime)
    expect(parsed4.counter).toBe(0)
    expect(t4 > t3).toBe(true)
  })

  it('Verifies causal order tracking on message exchange', () => {
    const clockA = new HybridLogicalClock('node-a')
    const clockB = new HybridLogicalClock('node-b')

    const baseTime = 1700000000000
    // Node A produces an event
    const sendTimestamp = clockA.now(baseTime)

    // Node B receives the event while its physical clock is slightly behind
    const recvTimestamp = clockB.update(sendTimestamp, baseTime - 100)

    // Causality rule: send event must strictly precede receive event
    expect(recvTimestamp > sendTimestamp).toBe(true)
    expect(HybridLogicalClock.compare(recvTimestamp, sendTimestamp)).toBe(1)

    const parsedSend = HybridLogicalClock.parse(sendTimestamp)
    const parsedRecv = HybridLogicalClock.parse(recvTimestamp)

    // Node B adopted Node A's higher wallTime and advanced counter
    expect(parsedRecv.wallTime).toBe(parsedSend.wallTime)
    expect(parsedRecv.counter).toBeGreaterThan(parsedSend.counter)
  })

  it('Verifies deterministic tie-breaking and lexical sorting with equal timestamps', () => {
    const fixedTime = 1700000050000
    const clock1 = new HybridLogicalClock('alpha')
    const clock2 = new HybridLogicalClock('beta')

    const ts1 = clock1.now(fixedTime)
    const ts2 = clock2.now(fixedTime)

    const p1 = HybridLogicalClock.parse(ts1)
    const p2 = HybridLogicalClock.parse(ts2)

    // Wall times and counters are identical
    expect(p1.wallTime).toBe(p2.wallTime)
    expect(p1.counter).toBe(p2.counter)

    // Node IDs break the tie lexically
    expect(ts1 < ts2).toBe(true)
    expect(HybridLogicalClock.compare(ts1, ts2)).toBe(-1)
  })

  it('Verifies strict parsing and rejection of malformed or invalid HLC strings', () => {
    const validHlc = '00000100000-000001-node1'
    const parsed = HybridLogicalClock.parse(validHlc)
    expect(parsed.nodeId).toBe('node1')

    // Invalid formats must throw descriptive errors
    expect(() => HybridLogicalClock.parse('')).toThrow(/Malformed HLC string/)
    expect(() => HybridLogicalClock.parse(null as any)).toThrow(/Malformed HLC string/)
    expect(() => HybridLogicalClock.parse('only-two')).toThrow(/Malformed HLC string/)
    expect(() => HybridLogicalClock.parse('!invalid!-@#-node')).toThrow(/Malformed HLC numeric component/)
    expect(() => HybridLogicalClock.parse('zzzz-zzzz-')).toThrow(/Malformed HLC nodeId/)
  })

  it('Verifies checkpoint boundary comparisons and range semantics', () => {
    const hlc0 = generateHLC('node-bound')
    const hlc1 = generateHLC('node-bound')
    const hlc2 = generateHLC('node-bound')

    // Test boundary operator consistency
    expect(hlc1 > hlc0).toBe(true)
    expect(hlc2 > hlc1).toBe(true)

    // Emulate SQL WHERE hlc_timestamp <= cutoff AND hlc_timestamp > cutoff
    const timestamps = [hlc0, hlc1, hlc2]
    const cutoff = hlc1

    const compacted = timestamps.filter((t) => t <= cutoff)
    const retained = timestamps.filter((t) => t > cutoff)

    expect(compacted).toEqual([hlc0, hlc1])
    expect(retained).toEqual([hlc2])
    expect(compacted.length + retained.length).toBe(timestamps.length)
  })
})
