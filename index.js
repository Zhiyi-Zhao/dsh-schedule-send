/**
 * Host half of `dsh-schedule-send`.
 *
 * The browser half (`./client.js`) lets the user schedule the message they are
 * writing in a conversation. Scheduling is carried over the session command
 * channel: the client executes `/schedule-send` with one JSON payload, and this
 * file owns everything after that — a durable JSON queue outside the workspace,
 * a periodic sweep, and delivery.
 *
 * Delivery deliberately does not use the built-in Schedule subsystem: that
 * subsystem injects a `[SCHEDULE REMINDER]` framing that tells the model to
 * present the text to the user instead of acting on it. A scheduled send must
 * reach the conversation as an ordinary user message, so this plugin calls the
 * public Host method `ctx.sessionController.prompt(...)`, which resumes a cold
 * session when needed, mints a `source.kind === 'user'` message, and dedupes by
 * `requestId` — the send id doubles as that request id, so a retry after a
 * crash cannot deliver the message twice.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Loader plugin name; it must match the package name. */
export const name = 'dsh-schedule-send'

/** The command registry is the only Host service needed at activation time. */
export const inject = ['commands']

const STORE_VERSION = 1
const MAX_TEXT = 20_000
const SWEEP_INTERVAL_MS = 5_000
const STARTUP_DELAY_MS = 3_000
const MAX_ATTEMPTS = 60
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000
const KEEP_TERMINAL_RECORDS = 50
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const MISSING_SESSION = /not found|no longer exists|does not exist/i

/**
 * Absolute path of the durable queue.
 * @returns The queue file under `$DSH_HOME`, falling back to `~/.dsh`.
 */
function queueFile() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'schedule-send', 'queue.json')
}

/**
 * Render one arbitrary thrown value as a single diagnostic line.
 * @param error - thrown value.
 * @returns A non-empty message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
  try {
    return String(error)
  } catch {
    return 'unrenderable thrown value'
  }
}

/**
 * Format one epoch instant for a Host-side command result.
 * @param epoch - target epoch milliseconds.
 * @param timeZone - optional IANA zone supplied by the browser.
 * @returns A stable human-readable instant.
 */
function formatInstant(epoch, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(epoch))
  } catch {
    return new Date(epoch).toISOString()
  }
}

/**
 * Accept one client-supplied IANA zone only when this runtime understands it.
 * @param value - candidate zone.
 * @returns The zone, or undefined so delivery omits `clientTimeZone`.
 */
function validTimeZone(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value
  } catch {
    return undefined
  }
}

/**
 * Parse one `/schedule-send` payload.
 * @param rawInput - text after the command name.
 * @returns The validated payload, or the reason it is unusable.
 */
function parseSendPayload(rawInput) {
  let value
  try {
    value = JSON.parse(rawInput.trim())
  } catch {
    return { error: 'The scheduled send payload is not valid JSON.' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'The scheduled send payload must be an object.' }
  }
  if (value.v !== 1) return { error: 'Unsupported scheduled send payload version.' }
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    return { error: 'The scheduled send id is invalid.' }
  }
  if (!Number.isSafeInteger(value.at)) return { error: 'The scheduled time is invalid.' }
  if (typeof value.text !== 'string') return { error: 'The scheduled message is invalid.' }
  if (value.tz !== undefined && typeof value.tz !== 'string') {
    return { error: 'The client time zone is invalid.' }
  }
  return { id: value.id, at: value.at, text: value.text, tz: value.tz }
}

/**
 * Parse one `/schedule-send-cancel` payload.
 * @param rawInput - text after the command name.
 * @returns The validated id, or undefined.
 */
function parseCancelPayload(rawInput) {
  let value
  try {
    value = JSON.parse(rawInput.trim())
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.v !== 1) return undefined
  return typeof value.id === 'string' && ID_PATTERN.test(value.id) ? value.id : undefined
}

/**
 * Write one file atomically: a sibling temporary file renamed over the target.
 * @param file - destination path.
 * @param content - complete file body.
 */
async function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, file)
}

/** Durable queue of scheduled sends owned by this Host process. */
class QueueStore {
  /**
   * @param ctx - Host context used only for logging.
   * @param file - absolute queue path.
   */
  constructor(ctx, file) {
    this.ctx = ctx
    this.file = file
    this.state = { version: STORE_VERSION, sends: [] }
    this.ready = false
    this.loading = undefined
    this.writing = Promise.resolve()
  }

  /** Load the queue once; failures degrade to an empty queue with a warning. */
  async load() {
    if (this.ready) return
    this.loading ??= this.#load()
    await this.loading
  }

  /** Read, validate, and normalize the persisted queue. */
  async #load() {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      let text
      try {
        text = await readFile(this.file, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        return
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        await this.#quarantine(error)
        return
      }
      this.state = normalizeQueueState(parsed)
    } catch (error) {
      this.ctx.logger.warn(`schedule-send: could not read the queue: ${messageOf(error)}`)
    } finally {
      this.ready = true
    }
  }

  /** Move an unreadable queue aside so the next save starts clean. */
  async #quarantine(error) {
    const target = `${this.file}.corrupt-${Date.now()}`
    try {
      await rename(this.file, target)
      this.ctx.logger.warn(`schedule-send: the queue was unreadable (${messageOf(error)}); moved to ${target}`)
    } catch (moveError) {
      this.ctx.logger.warn(`schedule-send: the queue was unreadable and could not be moved: ${messageOf(moveError)}`)
    }
  }

  /** Persist the current state atomically, serialized behind earlier writes. */
  save() {
    this.prune()
    const snapshot = JSON.stringify(this.state)
    this.writing = this.writing
      .then(() => writeAtomic(this.file, `${snapshot}\n`))
      .catch((error) => {
        this.ctx.logger.warn(`schedule-send: could not write the queue: ${messageOf(error)}`)
      })
    return this.writing
  }

  /** Drop old terminal records, keeping a short history. */
  prune() {
    const terminal = this.state.sends.filter(record => record.status !== 'pending' && record.status !== 'delivering')
    if (terminal.length <= KEEP_TERMINAL_RECORDS) return
    const excess = terminal.length - KEEP_TERMINAL_RECORDS
    const removed = new Set(terminal.slice(0, excess).map(record => record.id))
    this.state.sends = this.state.sends.filter(record => !removed.has(record.id))
  }

  /**
   * Find one record.
   * @param id - send identity.
   * @returns The record, when present.
   */
  find(id) {
    return this.state.sends.find(record => record.id === id)
  }

  /**
   * Records whose target time and retry deadline are both due.
   * @param now - current epoch milliseconds.
   * @returns Due records in target order.
   */
  due(now) {
    return this.state.sends
      .filter(record => record.status === 'pending'
        && record.at <= now
        && (record.nextAttemptAt === undefined || record.nextAttemptAt <= now))
      .sort((left, right) => left.at - right.at)
  }

  /**
   * Append one new pending record.
   * @param record - complete record.
   */
  add(record) {
    this.state.sends.push(record)
  }
}

/**
 * Normalize one decoded queue value.
 * @param parsed - decoded JSON.
 * @returns A queue state safe to mutate.
 */
function normalizeQueueState(parsed) {
  const state = { version: STORE_VERSION, sends: [] }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.sends)) return state
  for (const value of parsed.sends) {
    if (value === null || typeof value !== 'object') continue
    if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) continue
    if (typeof value.sessionId !== 'string' || value.sessionId === '') continue
    if (!Number.isSafeInteger(value.at)) continue
    if (typeof value.text !== 'string' || value.text === '') continue
    const status = value.status === 'cancelled' || value.status === 'failed' || value.status === 'delivered'
      ? value.status
      // A process that stopped mid-delivery resumes as pending: the prompt
      // request id makes the retry idempotent.
      : 'pending'
    state.sends.push({
      id: value.id,
      sessionId: value.sessionId,
      at: value.at,
      text: value.text,
      ...(typeof value.tz === 'string' && value.tz !== '' ? { tz: value.tz } : {}),
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
      status,
      attempts: Number.isSafeInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
      ...(Number.isSafeInteger(value.nextAttemptAt) ? { nextAttemptAt: value.nextAttemptAt } : {}),
      ...(typeof value.lastError === 'string' ? { lastError: value.lastError } : {}),
      ...(typeof value.deliveredAt === 'string' ? { deliveredAt: value.deliveredAt } : {}),
    })
  }
  return state
}

/**
 * Deliver one due record into its original session.
 * @param ctx - Host context.
 * @param store - owning queue.
 * @param record - mutable record being delivered.
 */
async function deliver(ctx, store, record) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') {
    ctx.logger.warn('schedule-send: ctx.sessionController is unavailable; scheduled sends stay queued')
    return
  }
  record.status = 'delivering'
  await store.save()
  try {
    await controller.prompt({
      requestId: record.id,
      sessionId: record.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: record.text }],
      ...(record.tz === undefined ? {} : { clientTimeZone: record.tz }),
    }, new AbortController().signal)
    record.status = 'delivered'
    record.deliveredAt = new Date().toISOString()
    delete record.nextAttemptAt
    delete record.lastError
    await store.save()
    ctx.logger.info(`schedule-send: delivered "${record.id}" to session "${record.sessionId}"`)
    // Make the accepted user message durable before this process can stop; a
    // failure here only costs a possible no-op retry, which the request id
    // deduplicates.
    try {
      const agent = ctx.get('agents')?.get(record.sessionId)
      if (agent !== undefined) await ctx.get('sessions')?.flush(agent.session)
    } catch (error) {
      ctx.logger.warn(`schedule-send: flush after delivery failed: ${messageOf(error)}`)
    }
  } catch (error) {
    const missing = error?.code === 'session/not-found' || MISSING_SESSION.test(messageOf(error))
    record.attempts += 1
    record.lastError = messageOf(error)
    if (missing || record.attempts >= MAX_ATTEMPTS) {
      record.status = 'failed'
      delete record.nextAttemptAt
      ctx.logger.warn(`schedule-send: giving up on "${record.id}": ${record.lastError}`)
    } else {
      record.status = 'pending'
      record.nextAttemptAt = Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * record.attempts)
      ctx.logger.warn(`schedule-send: delivery of "${record.id}" failed (attempt ${record.attempts}): ${record.lastError}`)
    }
    await store.save()
  }
}

/**
 * Install the queue, the two session commands, and the delivery sweep.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  const store = new QueueStore(ctx, queueFile())
  let sweeping = false
  let disposed = false

  const sweep = async () => {
    if (disposed || sweeping || !store.ready) return
    sweeping = true
    try {
      const now = Date.now()
      for (const record of store.due(now)) {
        if (disposed) return
        await deliver(ctx, store, record)
      }
    } catch (error) {
      ctx.logger.warn(`schedule-send: sweep failed: ${messageOf(error)}`)
    } finally {
      sweeping = false
    }
  }

  ctx.effect(() => {
    const startup = setTimeout(() => { void sweep() }, STARTUP_DELAY_MS)
    const tick = setInterval(() => { void sweep() }, SWEEP_INTERVAL_MS)
    return () => {
      disposed = true
      clearTimeout(startup)
      clearInterval(tick)
    }
  }, 'schedule-send: delivery sweep')

  void store.load().then(() => {
    if (!disposed) void sweep()
  })

  ctx.effect(() => {
    const disposeSend = ctx.commands.register({
      name: 'schedule-send',
      description: 'Queue the current composer message for later delivery into this conversation. '
        + 'It is issued by the composer schedule control, not typed by hand.',
      handler: async ({ agent, rawInput }) => {
        if (agent === undefined || agent.session === undefined) {
          return { kind: 'error', text: 'Scheduling needs a live conversation.' }
        }
        const payload = parseSendPayload(rawInput)
        if (payload.error !== undefined) return { kind: 'error', text: payload.error }
        if (payload.at <= Date.now()) {
          return { kind: 'error', text: 'The scheduled time must be strictly in the future.' }
        }
        if (payload.text.trim() === '') {
          return { kind: 'error', text: 'The message to schedule must not be empty.' }
        }
        if (payload.text.length > MAX_TEXT) {
          return { kind: 'error', text: `The message must be at most ${MAX_TEXT} characters.` }
        }
        await store.load()
        const existing = store.find(payload.id)
        if (existing !== undefined) {
          return existing.sessionId === agent.session.id
            ? { kind: 'success', text: `Already scheduled for ${formatInstant(existing.at, existing.tz)}.` }
            : { kind: 'error', text: 'That scheduled send id is already in use.' }
        }
        const timeZone = validTimeZone(payload.tz)
        const record = {
          id: payload.id,
          sessionId: agent.session.id,
          at: payload.at,
          text: payload.text,
          ...(timeZone === undefined ? {} : { tz: timeZone }),
          createdAt: new Date().toISOString(),
          status: 'pending',
          attempts: 0,
        }
        store.add(record)
        await store.save()
        void sweep()
        return { kind: 'success', text: `Scheduled for ${formatInstant(record.at, record.tz)}.` }
      },
    })
    const disposeCancel = ctx.commands.register({
      name: 'schedule-send-cancel',
      description: 'Cancel one still-queued scheduled send created from the composer schedule control.',
      handler: async ({ agent, rawInput }) => {
        const id = parseCancelPayload(rawInput)
        if (id === undefined) return { kind: 'error', text: 'The scheduled send id is invalid.' }
        await store.load()
        const record = store.find(id)
        if (record === undefined) {
          return { kind: 'error', text: 'That scheduled send is no longer queued; it may already have been sent.' }
        }
        if (agent !== undefined && record.sessionId !== agent.session.id) {
          return { kind: 'error', text: 'That scheduled send belongs to another conversation.' }
        }
        if (record.status === 'pending') {
          record.status = 'cancelled'
          record.cancelledAt = new Date().toISOString()
          await store.save()
          return { kind: 'success', text: `Cancelled the scheduled send for ${formatInstant(record.at, record.tz)}.` }
        }
        if (record.status === 'delivering') {
          return { kind: 'error', text: 'That scheduled send is being delivered right now and can no longer be cancelled.' }
        }
        return { kind: 'error', text: 'That scheduled send already left the queue.' }
      },
    })
    return () => {
      disposeSend()
      disposeCancel()
    }
  }, 'schedule-send: commands')
}
