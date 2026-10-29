import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import type { Awareness } from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const MESSAGE_SYNC = 0
export const MESSAGE_AWARENESS = 1
export const MESSAGE_DURABLE_UPDATE = 2
export const MESSAGE_DURABLE_ACK = 3

export const ACK_STATUS_DURABLE = 0
export const ACK_STATUS_FAILED = 1

export type UpdateStatus = 'pending' | 'durable' | 'failed' | 'unknown'

export interface TrackedUpdate {
  updateId: string
  payload: Uint8Array
  status: UpdateStatus
  hlc?: string
  error?: string
  submittedAt: number
  confirmedAt?: number
  attemptCount: number
}

export interface SaveState {
  overallStatus: UpdateStatus
  pendingCount: number
  durableCount: number
  failedCount: number
  unknownCount: number
  latestConfirmedHlc?: string
}

export interface DurableClientOptions {
  ackTimeoutMs?: number
  maxRetries?: number
  connect?: boolean
  autoSubmit?: boolean
  awareness?: Awareness
  WebSocketPolyfill?: any
  token?: string
}

const IGNORED_ORIGINS = new Set([
  'remote',
  'leveldb-restore',
  'postgres-reconcile',
  'durable-apply',
])

/**
 * DurableSyncClient: Production reference client implementing the Converge
 * update-acceptance and durable-acknowledgement protocol.
 *
 * Distinguishes:
 * 1. 'pending'  - Transmitted to server, awaiting durable acknowledgement.
 * 2. 'durable'  - Server committed to PostgreSQL WAL & LevelDB; confirmed with HLC.
 * 3. 'failed'   - Explicitly rejected by server with error description.
 * 4. 'unknown'  - Connection dropped while update was pending; outcome ambiguous until resync.
 */
export class DurableSyncClient {
  public doc: Y.Doc
  public url: string
  public ws: any = null
  public connected: boolean = false
  public clientID: number
  public awareness: Awareness
  public options: Required<Omit<DurableClientOptions, 'awareness' | 'token'>> & {
    awareness?: Awareness
    token?: string
  }

  // Monotonically ordered map of all tracked updates
  public updates = new Map<string, TrackedUpdate>()
  public updateOrder: string[] = []

  private activeTimers = new Map<string, NodeJS.Timeout>()
  private ackWaiters = new Map<
    string,
    {
      resolve: (ack: { status: 'durable' | 'failed'; hlc?: string; error?: string }) => void
      reject: (err: any) => void
    }
  >()
  private eventListeners = new Map<string, Set<Function>>()
  private localUpdateCounter: number = 0
  private connectPromise: Promise<void> | null = null
  private docUpdateListener: ((update: Uint8Array, origin: any) => void) | null = null
  private awarenessUpdateListener:
    | (({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: any) => void)
    | null = null

  constructor(
    urlOrServerUrl: string,
    roomOrDoc?: string | Y.Doc,
    docOrOptions?: Y.Doc | DurableClientOptions,
    maybeOptions?: DurableClientOptions
  ) {
    let finalUrl = urlOrServerUrl
    let finalDoc: Y.Doc
    let opts: DurableClientOptions | undefined

    if (typeof roomOrDoc === 'string') {
      finalUrl = `${urlOrServerUrl.replace(/\/$/, '')}/${roomOrDoc}`
      if (docOrOptions instanceof Y.Doc) {
        finalDoc = docOrOptions
        opts = maybeOptions
      } else {
        finalDoc = new Y.Doc()
        opts = docOrOptions as DurableClientOptions
      }
    } else if (roomOrDoc instanceof Y.Doc) {
      finalDoc = roomOrDoc
      opts = docOrOptions as DurableClientOptions
    } else {
      finalDoc = new Y.Doc()
      opts = roomOrDoc as unknown as DurableClientOptions
    }

    this.url = finalUrl
    this.doc = finalDoc
    this.clientID = this.doc.clientID

    this.options = {
      ackTimeoutMs: opts?.ackTimeoutMs ?? 3000,
      maxRetries: opts?.maxRetries ?? 3,
      connect: opts?.connect ?? false,
      autoSubmit: opts?.autoSubmit ?? true,
      WebSocketPolyfill:
        opts?.WebSocketPolyfill ?? (typeof WebSocket !== 'undefined' ? WebSocket : (globalThis as any).WebSocket),
      awareness: opts?.awareness,
      token: opts?.token,
    }

    this.awareness = this.options.awareness || new awarenessProtocol.Awareness(this.doc)

    // Listen to local awareness updates and broadcast to server
    this.awarenessUpdateListener = ({ added, updated, removed }, origin) => {
      if (origin === 'remote') return
      const changedClients = added.concat(updated, removed)
      if (changedClients.length === 0) return
      if (this.connected && this.ws) {
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
        )
        this.sendRaw(encoding.toUint8Array(encoder))
      }
    }
    this.awareness.on('update', this.awarenessUpdateListener)

    // Auto-submit local Y.Doc updates via durable protocol
    if (this.options.autoSubmit) {
      this.docUpdateListener = (update: Uint8Array, origin: any) => {
        if (
          origin === this ||
          origin === this.awareness ||
          (typeof origin === 'string' && IGNORED_ORIGINS.has(origin)) ||
          (origin && typeof origin === 'object' && origin.constructor && origin.constructor.name === 'IndexeddbPersistence')
        ) {
          return
        }

        const updateId = this.generateUpdateId()
        if (!this.connected) {
          const tracked: TrackedUpdate = {
            updateId,
            payload: update,
            status: 'unknown',
            submittedAt: Date.now(),
            attemptCount: 0,
            error: 'OFFLINE: Queued for sync on reconnect',
          }
          this.updates.set(updateId, tracked)
          this.updateOrder.push(updateId)
          this.emit('save-status', this.getSaveState())
          return
        }

        this.submitUpdate(update, updateId).catch(() => {})
      }
      this.doc.on('update', this.docUpdateListener)
    }

    if (this.options.connect) {
      this.connect().catch((err) => {
        this.emit('connection-error', err)
      })
    }
  }

  on(event: string, fn: Function): this {
    let set = this.eventListeners.get(event)
    if (!set) {
      set = new Set()
      this.eventListeners.set(event, set)
    }
    set.add(fn)
    return this
  }

  off(event: string, fn: Function): this {
    const set = this.eventListeners.get(event)
    if (set) {
      set.delete(fn)
      if (set.size === 0) {
        this.eventListeners.delete(event)
      }
    }
    return this
  }

  emit(event: string, ...args: any[]): void {
    const set = this.eventListeners.get(event)
    if (set) {
      for (const fn of Array.from(set)) {
        try {
          fn(...args)
        } catch (err) {
          console.error(`[DurableSyncClient] Error in listener for "${event}":`, err)
        }
      }
    }
  }

  public generateUpdateId(): string {
    this.localUpdateCounter++
    return `up-${this.clientID}-${Date.now()}-${this.localUpdateCounter}-${Math.random().toString(36).slice(2, 6)}`
  }

  async connect(): Promise<void> {
    if (this.connected) return Promise.resolve()
    if (this.connectPromise) return this.connectPromise

    const WSClass = this.options.WebSocketPolyfill
    if (!WSClass) {
      throw new Error('No WebSocket implementation available')
    }

    this.emit('status', { status: 'connecting' })

    this.connectPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const subprotocols = this.options.token
        ? ['converge.v1', `converge.token.${this.options.token}`]
        : ['converge.v1']
      const ws = new WSClass(this.url, subprotocols)
      this.ws = ws

      if ('binaryType' in ws) {
        ws.binaryType = 'arraybuffer'
      }

      const onOpen = () => {
        this.connected = true
        this.emit('status', { status: 'connected' })

        // 1. Send initial syncStep1
        const encoder = encoding.createEncoder()
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.writeSyncStep1(encoder, this.doc)
        this.sendRaw(encoding.toUint8Array(encoder))

        // 2. Send local awareness states if any
        const awarenessStates = this.awareness.getStates()
        if (awarenessStates.size > 0) {
          const enc = encoding.createEncoder()
          encoding.writeVarUint(enc, MESSAGE_AWARENESS)
          encoding.writeVarUint8Array(
            enc,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(awarenessStates.keys()))
          )
          this.sendRaw(encoding.toUint8Array(enc))
        }

        // 3. Retry all unconfirmed updates upon reconnect
        this.retryAllUnconfirmed().catch((err) => {
          console.warn('[DurableSyncClient] retryAllUnconfirmed failed on connect:', err)
        })

        if (!settled) {
          settled = true
          resolve()
        }
      }

      const onMessage = (raw: any) => {
        const data = raw.data !== undefined ? raw.data : raw
        this.handleMessage(data)
      }

      const onClose = () => {
        this.handleDisconnect()
      }

      const onError = (err: any) => {
        this.emit('connection-error', err)
        if (!settled && !this.connected) {
          settled = true
          reject(err)
        }
      }

      if (typeof ws.addEventListener === 'function') {
        ws.addEventListener('open', onOpen)
        ws.addEventListener('message', onMessage)
        ws.addEventListener('close', onClose)
        ws.addEventListener('error', onError)
      } else if (typeof ws.on === 'function') {
        ws.on('open', onOpen)
        ws.on('message', onMessage)
        ws.on('close', onClose)
        ws.on('error', onError)
      } else {
        ws.onopen = onOpen
        ws.onmessage = onMessage
        ws.onclose = onClose
        ws.onerror = onError
      }
    }).finally(() => {
      this.connectPromise = null
    })

    return this.connectPromise
  }

  private sendRaw(bytes: Uint8Array): void {
    if (this.ws && (this.ws.readyState === 1 || this.ws.readyState === (this.ws.constructor?.OPEN ?? 1))) {
      this.ws.send(bytes)
    }
  }

  private handleMessage(data: any): void {
    try {
      let uint8: Uint8Array
      if (data instanceof Uint8Array) {
        uint8 = data
      } else if (data instanceof ArrayBuffer) {
        uint8 = new Uint8Array(data)
      } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
        uint8 = new Uint8Array(data)
      } else {
        uint8 = new Uint8Array(data)
      }

      const decoder = decoding.createDecoder(uint8)
      const msgType = decoding.readVarUint(decoder)

      if (msgType === MESSAGE_SYNC) {
        const replyEncoder = encoding.createEncoder()
        encoding.writeVarUint(replyEncoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, replyEncoder, this.doc, 'remote')
        if (encoding.length(replyEncoder) > 1 && this.connected) {
          this.sendRaw(encoding.toUint8Array(replyEncoder))
        }
      } else if (msgType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder)
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, 'remote')
      } else if (msgType === MESSAGE_DURABLE_ACK) {
        const updateId = decoding.readVarString(decoder)
        const statusCode = decoding.readVarUint(decoder)
        const hlc = decoding.readVarString(decoder)
        const error = decoding.readVarString(decoder)

        this.processAck(updateId, statusCode === ACK_STATUS_DURABLE ? 'durable' : 'failed', hlc, error)
      }
    } catch (err) {
      console.error('[DurableSyncClient] message parse error:', err)
    }
  }

  private processAck(
    updateId: string,
    status: 'durable' | 'failed',
    hlc?: string,
    error?: string
  ): void {
    const timer = this.activeTimers.get(updateId)
    if (timer) {
      clearTimeout(timer)
      this.activeTimers.delete(updateId)
    }

    const tracked = this.updates.get(updateId)
    if (tracked) {
      tracked.status = status
      tracked.hlc = hlc || undefined
      tracked.error = error || undefined
      if (status === 'durable') {
        tracked.confirmedAt = Date.now()
      }
    }

    this.emit('save-status', this.getSaveState())

    const waiter = this.ackWaiters.get(updateId)
    if (waiter) {
      this.ackWaiters.delete(updateId)
      waiter.resolve({ status, hlc: hlc || undefined, error: error || undefined })
    }
  }

  private handleDisconnect(): void {
    this.connected = false

    // Clear timers and mark all in-flight pending updates as 'unknown' outcome
    for (const [updateId, timer] of this.activeTimers) {
      clearTimeout(timer)
      const tracked = this.updates.get(updateId)
      if (tracked && tracked.status === 'pending') {
        tracked.status = 'unknown'
        tracked.error = 'CONNECTION_LOST: Update outcome unknown until reconnection'
      }
    }
    this.activeTimers.clear()

    // Settle waiting promises
    for (const [updateId, waiter] of this.ackWaiters) {
      waiter.reject(new Error(`CONNECTION_LOST: Update "${updateId}" outcome unknown`))
    }
    this.ackWaiters.clear()

    // Clear remote awareness states
    const remoteClients = Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.doc.clientID)
    if (remoteClients.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, remoteClients, 'remote')
    }

    this.emit('status', { status: 'disconnected' })
    this.emit('save-status', this.getSaveState())
  }

  /**
   * Submits an update under the durable acknowledgement contract.
   * If updateId is not supplied, generates a timestamped client-scoped ID.
   */
  async submitUpdate(
    update: Uint8Array,
    existingUpdateId?: string
  ): Promise<{ status: 'durable' | 'failed'; hlc?: string; error?: string }> {
    if (!this.connected || !this.ws) {
      throw new Error('Client not connected')
    }

    // Reuse existing logical updateId on retry, or create new one
    const updateId = existingUpdateId || this.generateUpdateId()

    let tracked = this.updates.get(updateId)
    if (!tracked) {
      tracked = {
        updateId,
        payload: update,
        status: 'pending',
        submittedAt: Date.now(),
        attemptCount: 1,
      }
      this.updates.set(updateId, tracked)
      this.updateOrder.push(updateId)
    } else {
      tracked.status = 'pending'
      tracked.attemptCount += 1
      tracked.error = undefined
    }

    this.emit('save-status', this.getSaveState())

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_DURABLE_UPDATE)
    encoding.writeVarString(encoder, updateId)
    encoding.writeVarUint8Array(encoder, update)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.activeTimers.delete(updateId)
        this.ackWaiters.delete(updateId)
        if (tracked) {
          tracked.status = 'unknown'
          tracked.error = `TIMEOUT: Durable ACK not received within ${this.options.ackTimeoutMs}ms`
        }
        this.emit('save-status', this.getSaveState())
        reject(new Error(`DURABLE_ACK_TIMEOUT: Update "${updateId}" timed out`))
      }, this.options.ackTimeoutMs)

      this.activeTimers.set(updateId, timer)
      this.ackWaiters.set(updateId, { resolve, reject })

      this.sendRaw(encoding.toUint8Array(encoder))
    })
  }

  /**
   * Retries an update using the identical logical updateId.
   */
  async retryUpdate(
    updateId: string
  ): Promise<{ status: 'durable' | 'failed'; hlc?: string; error?: string }> {
    const tracked = this.updates.get(updateId)
    if (!tracked) {
      throw new Error(`Cannot retry untracked update "${updateId}"`)
    }
    return this.submitUpdate(tracked.payload, updateId)
  }

  /**
   * Retries all unconfirmed ('unknown', 'failed', 'pending') updates.
   */
  async retryAllUnconfirmed(): Promise<
    Array<{ updateId: string; status: 'durable' | 'failed'; hlc?: string; error?: string }>
  > {
    if (!this.connected) return []
    const results: Array<{ updateId: string; status: 'durable' | 'failed'; hlc?: string; error?: string }> = []
    const unconfirmedIds = this.updateOrder.filter((id) => {
      const u = this.updates.get(id)
      return u && (u.status === 'unknown' || u.status === 'failed' || u.status === 'pending')
    })

    for (const updateId of unconfirmedIds) {
      const tracked = this.updates.get(updateId)
      if (!tracked) continue
      if (tracked.attemptCount >= this.options.maxRetries) {
        tracked.status = 'failed'
        tracked.error = `MAX_RETRIES_EXCEEDED: Exceeded ${this.options.maxRetries} retry attempts`
        this.emit('save-status', this.getSaveState())
        results.push({ updateId, status: 'failed', error: tracked.error })
        continue
      }
      try {
        const res = await this.retryUpdate(updateId)
        results.push({ updateId, ...res })
      } catch (err: any) {
        results.push({ updateId, status: 'failed', error: err?.message || String(err) })
      }
    }

    this.emit('save-status', this.getSaveState())
    return results
  }

  /**
   * Returns the save status of the document:
   * 'durable' if all submitted updates are durably confirmed,
   * 'pending' if any update is in flight,
   * 'failed' if any update failed,
   * 'unknown' if any update outcome is ambiguous after disconnect.
   */
  getSaveState(): SaveState {
    let pendingCount = 0
    let durableCount = 0
    let failedCount = 0
    let unknownCount = 0
    let latestConfirmedHlc: string | undefined

    for (const updateId of this.updateOrder) {
      const u = this.updates.get(updateId)!
      if (u.status === 'pending') pendingCount++
      else if (u.status === 'durable') {
        durableCount++
        if (u.hlc) latestConfirmedHlc = u.hlc
      } else if (u.status === 'failed') failedCount++
      else if (u.status === 'unknown') unknownCount++
    }

    let overallStatus: UpdateStatus = 'durable'
    if (failedCount > 0) overallStatus = 'failed'
    else if (unknownCount > 0) overallStatus = 'unknown'
    else if (pendingCount > 0) overallStatus = 'pending'

    return {
      overallStatus,
      pendingCount,
      durableCount,
      failedCount,
      unknownCount,
      latestConfirmedHlc,
    }
  }

  async reconnect(): Promise<void> {
    await this.disconnect()
    return this.connect()
  }

  async disconnect(): Promise<void> {
    this.connected = false
    if (this.ws) {
      try {
        if (typeof this.ws.close === 'function') {
          this.ws.close()
        }
      } catch {}
      this.ws = null
    }
    this.handleDisconnect()
  }

  destroy(): void {
    if (this.docUpdateListener) {
      this.doc.off('update', this.docUpdateListener)
      this.docUpdateListener = null
    }
    if (this.awarenessUpdateListener) {
      this.awareness.off('update', this.awarenessUpdateListener)
      this.awarenessUpdateListener = null
    }
    this.awareness.destroy()
    this.disconnect()
    this.eventListeners.clear()
  }
}
