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

let _ldb: LeveldbPersistenceInstance | null = null

function getLeveldb(): LeveldbPersistenceInstance {
  if (_ldb) return _ldb
  fs.mkdirSync(DB_DIR, { recursive: true })
  // y-leveldb is CJS-only with no type declarations — dynamic require is intentional.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LeveldbPersistence } = require('y-leveldb') as {
    LeveldbPersistence: LeveldbPersistenceConstructor
  }
  _ldb = new LeveldbPersistence(DB_DIR)
  console.log(`[persistence] LevelDB opened at ${DB_DIR}`)
  return _ldb
}

// ── Public persistence interface expected by room.ts ──────────────────────────
export interface Persistence {
  /**
   * Called once when a room's Y.Doc is first created.
   * Loads all persisted updates into ydoc, then subscribes to future
   * updates so every change is flushed to disk automatically.
   */
  bindState(docName: string, ydoc: Y.Doc): Promise<void>
}

export function getPersistence(): Persistence {
  return {
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
        if (origin === 'leveldb-restore') return
        ldb.storeUpdate(docName, update).catch((err: unknown) => {
          console.error(`[persistence] storeUpdate failed for "${docName}":`, err)
        })
      })
    },
  }
}
