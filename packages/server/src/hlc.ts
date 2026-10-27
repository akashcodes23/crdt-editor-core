// packages/server/src/hlc.ts

let lastTime = 0;
let counter = 0;

/**
 * Generates a lexically sortable, strictly monotonic timestamp string.
 * Example format: "000018a4a58-0000-server1"
 */
export function generateHLC(nodeId: string): string {
  const now = Date.now();
  
  if (now > lastTime) {
    lastTime = now;
    counter = 0;
  } else {
    // If wall clock stood still or moved backwards, increment the logical counter
    counter++;
  }

  // Base36 encoding padded for lexical sorting
  const timeStr = lastTime.toString(36).padStart(11, '0');
  const countStr = counter.toString(36).padStart(4, '0');
  
  return `${timeStr}-${countStr}-${nodeId}`;
}
