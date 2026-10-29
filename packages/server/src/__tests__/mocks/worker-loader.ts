/**
 * Mock worker loader for Node.js test environment.
 * Allows client tests to execute in Node/Jest without encountering browser Worker APIs.
 */

export function createWorker(): any {
  return null
}
