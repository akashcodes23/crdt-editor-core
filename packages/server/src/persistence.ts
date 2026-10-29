import * as Y from 'yjs'
import path from 'path'
import fs from 'fs'

// ── y-leveldb types (no official @types package) ──────────────────────────────
interface LeveldbPersistenceInstance {
  /** Load all stored updates for docName into ydoc */
  getYDoc(docName: string): Promise<Y.Doc>
  /** Persist a single binary update for docName */
  storeUpdate(docName: string, update: Uint8Array): Promise<void>
  /** Delete all data for docName */
  clearDocument(docName: string): Promise<void>
}

interface LeveldbPersistenceConstructor {
  new(location: string): LeveldbPersistenceInstance
}

// ── Singleton ─────────────────────────────────────────────────────────────────
const DB_DIR = path.resolve(process.cwd(), 'data', 'leveldb')

declare global {
  // eslint-disable-next-line no-var
  var __converge_leveldb__: LeveldbPersistenceInstance | null | undefined
  // eslint-disable-next-line no-var
  var __converge_persistence__: Persistence | null | undefined
}

function getLeveldb(): LeveldbPersistenceInstance {
  if (globalThis.__converge_leveldb__) return globalThis.__converge_leveldb__
  const dbDir = process.env.LEVELDB_DIR || DB_DIR
  fs.mkdirSync(dbDir, { recursive: true })
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LeveldbPersistence } = require('y-leveldb')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const level = require('level')
  const customLevel = (loc: string, opts: any) => {
    const db = level(loc, opts)
    if (db && typeof db.on === 'function') {
      db.on('error', (err: any) => {
        console.warn('[persistence] LevelDB instance error handled:', err?.message || err)
      })
    }
    return db
  }
  const ldb = new LeveldbPersistence(dbDir, { level: customLevel }) as LeveldbPersistenceInstance
  console.log(`[persistence] LevelDB opened at ${dbDir}`)
  globalThis.__converge_leveldb__ = ldb
  return ldb
}

export async function closePersistence(): Promise<void> {
  const ldb = globalThis.__converge_leveldb__
  if (ldb && typeof (ldb as any).destroy === 'function') {
    await (ldb as any).destroy()
    globalThis.__converge_leveldb__ = null
  }
  globalThis.__converge_persistence__ = null
}

// ── Public persistence interface expected by room.ts ──────────────────────────
export interface Persistence {
  /**
   * Called once when a room's Y.Doc is first created.
   * Loads all persisted updates into ydoc, then subscribes to future
   * updates so every change is flushed to disk automatically.
   */
  bindState(docName: string, ydoc: Y.Doc): Promise<void>
  /**
   * Flushes any in-flight LevelDB writes for docName.
   */
  flushDocument(docName: string): Promise<void>
  /**
   * Directly stores a single update to LevelDB and awaits completion.
   */
  storeUpdate(docName: string, update: Uint8Array): Promise<void>
}

const leveldbWriteQueues = new Map<string, Promise<void>>()

export function getPersistence(): Persistence {
  if (globalThis.__converge_persistence__) return globalThis.__converge_persistence__
  const instance: Persistence = {
    async bindState(docName: string, ydoc: Y.Doc): Promise<void> {
      const ldb = getLeveldb()

      // 1. Load all previously persisted updates from LevelDB into a temp doc
      const persistedDoc = await ldb.getYDoc(docName)

      // 2. Persist whatever state the (fresh) in-memory ydoc already has
      //    (usually empty on first run, but safe to call regardless)
      const initialUpdate = Y.encodeStateAsUpdate(ydoc)
      await ldb.storeUpdate(docName, initialUpdate)

      // 3. Merge persisted state into live ydoc with origin 'leveldb-restore'
      // This prevents triggering duplicate database operations during initialization
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedDoc), 'leveldb-restore')

      // 4. Subscribe so every future incremental update is persisted immediately
      ydoc.on('update', (update: Uint8Array, origin: any) => {
        if (origin === 'leveldb-restore' || origin === 'durable-apply' || origin === 'postgres-reconcile') return
        const writePromise = ldb.storeUpdate(docName, update).catch((err: unknown) => {
          console.error(`[persistence] storeUpdate failed for "${docName}":`, err)
        })
        const queue = leveldbWriteQueues.get(docName) || Promise.resolve()
        leveldbWriteQueues.set(
          docName,
          queue.then(() => writePromise)
        )
      })
    },

    async storeUpdate(docName: string, update: Uint8Array): Promise<void> {
      const ldb = getLeveldb()
      const writePromise = ldb.storeUpdate(docName, update)
      const queue = leveldbWriteQueues.get(docName) || Promise.resolve()
      leveldbWriteQueues.set(
        docName,
        queue.then(() => writePromise)
      )
      await writePromise
    },

    async flushDocument(docName: string): Promise<void> {
      const queue = leveldbWriteQueues.get(docName)
      if (queue) {
        await queue
      }
    },
  }
  globalThis.__converge_persistence__ = instance
  return instance
}
