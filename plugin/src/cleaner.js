/**
 * session-cleaner core: pure, testable logic for completely removing DSH sessions.
 *
 * Design commitments:
 *  - Never guess a path. Every deletion target is validated THREE times:
 *      1. the session id matches the shipped id grammar,
 *      2. the on-disk directory/file name equals that id exactly,
 *      3. the normalized absolute path is contained in an allowed root.
 *    A target failing any check is skipped and reported, never deleted.
 *  - Removal order matters: stop the session BEFORE touching its files, and
 *    detach registry references BEFORE deleting files, so the UI never shows a
 *    row whose log has already vanished.
 */

import { existsSync } from 'node:fs'
import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Shipped session directory grammar. Three forms coexist on disk:
 *   - `session-<uuid>` — user sessions writing `session.v4.jsonl.zstd`,
 *   - `sess_<uuid>`    — legacy user sessions writing `session.v3.jsonl.zstd`,
 *   - `<uuid>`         — subagent / delegated child sessions.
 * All three are valid deletion targets; anything else is not a session.
 */
const SESSION_ID = /^(?:(?:session-|sess_))?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** A session log directly inside a session directory. */
const LOG_NAME = /^session\.v\d+\.jsonl(?:\.zstd)?$/

export function resolveDshHome(options = {}) {
  const candidates = [
    options.dshHome,
    process.env.DSH_HOME,
    path.join(homedir(), '.dsh'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return path.resolve(candidate)
  }
  throw new Error('session-cleaner: cannot resolve the DSH home directory')
}

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID.test(id)
}

export function normalizeForCompare(target) {
  const resolved = path.resolve(target)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** True when `target` is `root` itself or lives underneath it. */
export function isContained(root, target) {
  const base = normalizeForCompare(root)
  const candidate = normalizeForCompare(target)
  if (candidate === base) return true
  const withSep = base.endsWith(path.sep) ? base : base + path.sep
  return candidate.startsWith(withSep)
}

/** A capture with a bounded argument vector — never a shell string. */

/**
 * Read the first line of a session log, transparently handling zstd compression.
 *
 * Decompression uses Node's built-in zstd support (Node >= 23.8) rather than a
 * `zstd` executable: header linkage backs descendant discovery, and a missing
 * external tool would silently degrade deletion into a no-op cascade.
 *
 * Returns `undefined` when the header cannot be read; linkage is an
 * optimization, so an unreadable header must never fail a scan.
 */
export async function readSessionHeader(logFile) {
  try {
    let text
    if (logFile.endsWith('.zstd')) {
      const handle = await open(logFile, 'r')
      let compressed
      try {
        const info = await handle.stat()
        compressed = Buffer.alloc(Number(info.size))
        let offset = 0
        while (offset < compressed.length) {
          const { bytesRead } = await handle.read(compressed, offset, compressed.length - offset, offset)
          if (bytesRead <= 0) break
          offset += bytesRead
        }
        compressed = compressed.subarray(0, offset)
      } finally {
        await handle.close()
      }
      text = zstdDecompressSync(compressed).toString('utf8')
    } else {
      const handle = await open(logFile, 'r')
      try {
        const buffer = Buffer.alloc(64 * 1024)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    }
    const firstLine = text.split('\n', 1)[0]?.trim()
    if (!firstLine) return undefined
    const parsed = JSON.parse(firstLine)
    const meta = parsed?.meta ?? parsed?.header ?? parsed
    if (!meta || typeof meta !== 'object') return undefined
    return {
      id: typeof meta.id === 'string' ? meta.id : undefined,
      parent: typeof meta.parentSession === 'string' ? meta.parentSession : undefined,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
      title: typeof meta.title === 'string' ? meta.title : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Read the projection cache that rides beside a session log.
 *
 * The cache is the reliable TITLE source — the log header's title is usually
 * empty, and the real one only ever arrives as a later `session/title` event —
 * and it covers subagent sessions too. It also carries `identity.cwd` and
 * `identity.createdAt`, which the header may lack. Returns `undefined` when the
 * file is missing or malformed: like the header, this is display metadata and
 * must never fail a scan.
 */
export async function readProjectionCache(cacheFile) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8'))
    const record = parsed?.record
    if (record === null || typeof record !== 'object') return undefined
    const title = record.rows?.title?.val
    const createdAt = record.identity?.createdAt
    const cwd = record.identity?.cwd
    return {
      title: typeof title === 'string' && title.length > 0 ? title : undefined,
      createdAt: typeof createdAt === 'number' ? createdAt : undefined,
      cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined,
    }
  } catch {
    return undefined
  }
}

/** A line longer than this is a streaming carrier, not preview material. */
const MAX_TRANSCRIPT_LINE_CHARS = 1024 * 1024

/** Cheap pre-filter: only lines naming an event worth keeping get parsed. */
const TRANSCRIPT_INTEREST = /user\/message|assistant\/message|session\/title|"session"/

/** The zstd frame magic every frame starts with. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a multi-frame zstd log.
 *
 * DSH appends one zstd frame per writing episode, and BOTH of Node's zstd
 * APIs decode only the first frame of a file (the streaming decompressor
 * ends at the first frame boundary too), so the file is split at the frame
 * magic and every slice decompressed on its own. A magic sequence occurring
 * inside compressed data — astronomically rare — would slice one real frame
 * in half; both halves then fail to decode and only that one frame is lost,
 * which a read-only preview can tolerate (and report).
 */
function decodeZstdFrames(buffer) {
  const offsets = []
  for (let pos = 0; (pos = buffer.indexOf(ZSTD_MAGIC, pos)) !== -1; pos += 1) offsets.push(pos)

  const chunks = []
  let failedFrames = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      failedFrames += 1
    }
  }
  return {
    text: chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8'),
    decodedFrames: chunks.length,
    failedFrames,
  }
}

/** Join the text blocks of a message content array; reasoning/tool blocks drop. */
function joinTextBlocks(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

function clampCount(value, fallback) {
  const count = Math.trunc(Number(value))
  return Number.isFinite(count) && count > 0 ? count : fallback
}

/**
 * Read a session log as a display-oriented conversation transcript.
 *
 * Only the events a preview needs are kept: the conversation messages and the
 * title event (the header's title is usually empty; the real one arrives as
 * `session/title`). Messages are projected to `{ role, text, time, model? }`:
 * text blocks are joined, turns without text (pure reasoning, tool calls) and
 * DSH-injected context events are dropped, and both the message count and the
 * per-message length are capped so a huge log cannot flood the panel. A
 * missing log rejects and undecodable frames are reported as `failedFrames`
 * instead of failing the read.
 */
export async function readSessionTranscript(logFile, options = {}) {
  const maxMessages = clampCount(options.maxMessages, 500)
  const maxChars = clampCount(options.maxCharsPerMessage, 8000)

  const raw = await readFile(logFile)
  let text
  let failedFrames = 0
  if (logFile.endsWith('.zstd')) {
    const decoded = decodeZstdFrames(raw)
    text = decoded.text
    failedFrames = decoded.failedFrames
  } else {
    text = raw.toString('utf8')
  }

  const collected = []
  let title
  let createdAt

  for (const line of text.split('\n')) {
    if (line.length > MAX_TRANSCRIPT_LINE_CHARS) continue
    if (!TRANSCRIPT_INTEREST.test(line)) continue
    let event
    try { event = JSON.parse(line) } catch { continue }

    if (event?.type === 'session/title') {
      if (typeof event.data?.title === 'string' && event.data.title.length > 0) title = event.data.title
    } else if (event?.type === 'session') {
      const meta = event.meta ?? event.header ?? event
      if (typeof meta?.createdAt === 'number') createdAt = meta.createdAt
    } else if (event?.type === 'user/message' || event?.type === 'assistant/message') {
      const fromUser = event.type === 'user/message'
      const holder = fromUser ? event.data : (event.data?.message ?? event.data)
      const textOfMessage = joinTextBlocks(holder?.content)
      if (textOfMessage.trim() === '') continue
      const entry = { role: fromUser ? 'user' : 'assistant', text: textOfMessage }
      if (typeof event.time === 'number') entry.time = event.time
      if (!fromUser && typeof holder?.source?.model === 'string') entry.model = holder.source.model
      if (fromUser && holder?.source?.kind !== 'user') entry.injected = true
      collected.push(entry)
    }
  }

  // DSH's runtime-context snapshots and skill catalogs ride user/message
  // events too, under a source.kind other than 'user'. When a real human
  // turn exists they are noise; when none does, keep everything — a preview
  // must never come back empty over a kind-value difference.
  const hasHumanInput = collected.some((entry) => entry.injected !== true)
  const kept = hasHumanInput ? collected.filter((entry) => entry.injected !== true) : collected

  const messages = []
  let truncated = false
  for (const entry of kept) {
    if (messages.length >= maxMessages) {
      truncated = true
      break
    }
    const message = {
      role: entry.role,
      text: entry.text.length > maxChars ? `${entry.text.slice(0, maxChars)}…` : entry.text,
    }
    if (entry.time !== undefined) message.time = entry.time
    if (entry.model !== undefined) message.model = entry.model
    messages.push(message)
  }

  return { title, createdAt, messages, totalMessages: kept.length, truncated, failedFrames }
}

/**
 * Index every session directory under `<dshHome>/sessions/<workspaceKey>/<sessionId>/`.
 * The directory listing is the authority: a session unknown to the listing is
 * not on disk, and a directory whose name is not a valid session id is ignored.
 */
export async function scanSessions(roots) {
  const records = new Map()
  let workspaceKeys = []
  try {
    const entries = await readdir(roots.sessions, { withFileTypes: true })
    workspaceKeys = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return { records, workspaceKeys, skipped: [] }
  }

  const skipped = []
  for (const workspaceKey of workspaceKeys) {
    const workspaceDir = path.join(roots.sessions, workspaceKey)
    let sessionDirs
    try {
      sessionDirs = await readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of sessionDirs) {
      if (!dir.isDirectory()) continue
      const sessionDir = path.join(workspaceDir, dir.name)
      if (!isValidSessionId(dir.name)) {
        skipped.push({ path: sessionDir, reason: 'directory name is not a valid session id' })
        continue
      }
      if (!isContained(roots.sessions, sessionDir)) {
        skipped.push({ path: sessionDir, reason: 'path escapes the sessions root' })
        continue
      }
      let files = []
      try {
        files = (await readdir(sessionDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
      } catch {
        continue
      }
      const logName = files.find((name) => LOG_NAME.test(name))
      if (logName === undefined) {
        skipped.push({ path: sessionDir, reason: 'no session log found in the session directory' })
        continue
      }
      const logFile = path.join(sessionDir, logName)
      let bytes = 0
      try {
        bytes = (await stat(logFile)).size
      } catch {
        bytes = 0
      }
      const header = await readSessionHeader(logFile)
      const cache = await readProjectionCache(path.join(roots.projectionCache, `${dir.name}.json`))
      records.set(dir.name, {
        id: dir.name,
        workspaceKey,
        dir: sessionDir,
        logFile,
        logName,
        bytes,
        parent: header?.parent,
        cwd: header?.cwd ?? cache?.cwd,
        // The cache title beats the header's (the header's is usually empty);
        // the header cwd is authoritative, the cache's only fills a gap.
        title: cache?.title ?? header?.title,
        createdAt: cache?.createdAt,
      })
    }
  }
  return { records, workspaceKeys, skipped }
}

/**
 * Expand a set of session ids into `{ id, depth }` pairs including every
 * descendant, following the durable `parentSession` link.
 */
export function expandWithDescendants(records, rootIds) {
  const children = new Map()
  for (const record of records.values()) {
    if (typeof record.parent !== 'string' || record.parent.length === 0) continue
    const list = children.get(record.parent)
    if (list === undefined) children.set(record.parent, [record.id])
    else list.push(record.id)
  }

  const seen = new Set()
  const out = []
  const queue = []
  for (const id of rootIds) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    queue.push({ id, depth: 0 })
  }
  while (queue.length > 0) {
    const current = queue.shift()
    out.push(current)
    for (const child of children.get(current.id) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      queue.push({ id: child, depth: current.depth + 1 })
    }
  }
  return out
}

/** Read the durable workspace registry; a missing or malformed file yields an empty shape. */
export async function readWorkspaceRegistry(roots) {
  try {
    const raw = await readFile(roots.workspaceRegistry, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Remove session ids from every place the workspace registry can hold one:
 * each workspace's `sessionIds`, plus the global `archivedSessionIds` and
 * `pinnedSessionIds` lists.
 *
 * Returns the SAME object when nothing matched, so callers can cheaply detect
 * a no-op without a deep clone.
 */
export function detachFromRegistry(registry, ids) {
  const remove = new Set(ids)
  if (registry === undefined || registry === null || typeof registry !== 'object') {
    return { registry, changes: [] }
  }

  // Collect first so an unchanged registry is never cloned.
  const changes = []
  const global = registry.global
  if (global !== null && typeof global === 'object') {
    for (const key of ['archivedSessionIds', 'pinnedSessionIds', 'sessionIds']) {
      const list = global[key]
      if (!Array.isArray(list)) continue
      const removed = list.filter((id) => remove.has(id)).length
      if (removed > 0) changes.push({ where: `global.${key}`, removed })
    }
  }
  const workspaces = registry.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const [workspaceId, workspace] of Object.entries(workspaces)) {
      const list = workspace?.sessionIds
      if (!Array.isArray(list)) continue
      const removed = list.filter((id) => remove.has(id)).length
      if (removed > 0) changes.push({ where: `workspaces[${workspaceId}].sessionIds`, removed })
    }
  }
  if (changes.length === 0) return { registry, changes }

  const next = structuredClone(registry)
  const nextGlobal = next.global
  if (nextGlobal !== null && typeof nextGlobal === 'object') {
    for (const key of ['archivedSessionIds', 'pinnedSessionIds', 'sessionIds']) {
      const list = nextGlobal[key]
      if (Array.isArray(list)) nextGlobal[key] = list.filter((id) => !remove.has(id))
    }
  }
  const nextWorkspaces = next.tables?.workspaces
  if (nextWorkspaces !== null && typeof nextWorkspaces === 'object') {
    for (const workspace of Object.values(nextWorkspaces)) {
      const list = workspace?.sessionIds
      if (Array.isArray(list)) workspace.sessionIds = list.filter((id) => !remove.has(id))
    }
  }
  return { registry: next, changes }
}

/** Write JSON atomically: a sibling temp file, then a rename over the target. */
export async function writeJsonAtomic(file, value) {
  const temp = `${file}.session-cleaner.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/** Candidate paths for the optional SQLite full-text search index. */
export async function findSearchIndexes(roots) {
  const found = []
  const storages = roots.storages
  let entries = []
  try {
    entries = await readdir(storages, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.(?:db|sqlite|sqlite3)$/i.test(entry.name)) continue
    found.push(path.join(storages, entry.name))
  }
  return found
}

/**
 * Build a deletion plan. Pure with respect to the filesystem apart from reads.
 *
 * Returns `{ root, targets, descendants, registry, registryChanges, searchIndexes, skipped, totals }`.
 */
export async function planDeletion(roots, sessionIds, options = {}) {
  const requested = [...new Set(sessionIds.filter(isValidSessionId))]
  const rejectedIds = sessionIds.filter((id) => !isValidSessionId(id))

  const { records, skipped } = await scanSessions(roots)
  const expanded = expandWithDescendants(records, requested)

  const targets = []
  const missing = []
  for (const entry of expanded) {
    const record = records.get(entry.id)
    if (record === undefined) {
      // A requested root that is absent from the listing cannot be deleted; a
      // descendant that is absent simply has no files.
      if (entry.depth === 0) missing.push(entry.id)
      continue
    }
    targets.push({
      id: record.id,
      depth: entry.depth,
      isRoot: entry.depth === 0,
      workspaceKey: record.workspaceKey,
      dir: record.dir,
      logFile: record.logFile,
      bytes: record.bytes,
      cwd: record.cwd,
      title: record.title,
    })
  }

  const registry = await readWorkspaceRegistry(roots)
  const projected = detachFromRegistry(registry, targets.map((target) => target.id))
  const searchIndexes = await findSearchIndexes(roots)

  const totals = targets.reduce((sum, target) => sum + target.bytes, 0)
  return {
    root: options.rootSessionId,
    dshHome: roots.dshHome,
    targets,
    requested,
    rejectedIds,
    missing,
    registryChanges: projected.changes,
    searchIndexes,
    skipped,
    totals: { sessions: targets.length, bytes: totals },
  }
}

/** Validate one concrete path immediately before deleting it. */
export function assertDeletable(target, allowedRoots) {
  const normalized = path.resolve(target)
  if (!allowedRoots.some((root) => isContained(root, normalized))) {
    return { ok: false, reason: `outside the allowed roots: ${normalized}` }
  }
  return { ok: true }
}

/**
 * Execute a plan. Order is deliberate and must not be reordered:
 *   1. stop every running session,
 *   2. detach registry references,
 *   3. delete session directories and projection caches,
 *   4. purge derived search indexes that can no longer be reconciled.
 *
 * `stop` is injected so this module stays testable and free of runtime coupling.
 */
export async function executeDeletion(roots, plan, options = {}) {
  const { stop, now = () => Date.now() } = options
  const allowedRoots = [roots.sessions, roots.storages]
  const result = {
    startedAt: now(),
    stopped: [],
    registryChanges: [],
    deleted: [],
    failed: [],
    searchIndexesRemoved: [],
    searchIndexesKept: [],
  }

  // 1. Stop each session before any file is touched. A still-running agent
  //    would keep appending to a log we just deleted, resurrecting a half
  //    session. A target that refuses to stop aborts the whole run before
  //    anything is deleted, so a partial outcome is never reported as success.
  for (const target of plan.targets) {
    const outcome = await stop(target.id)
    result.stopped.push({ id: target.id, ...outcome })
    if (outcome?.stillRunning === true && options.requireStopped !== false) {
      result.failed.push({ id: target.id, stage: 'stop', reason: 'session is still running' })
      return { ...result, aborted: true }
    }
  }

  const blocked = new Set(result.failed.map((entry) => entry.id))

  // 2. Detach registry references first, so no row survives its own log.
  let registry = await readWorkspaceRegistry(roots)
  if (registry !== undefined) {
    const removable = plan.targets.filter((target) => !blocked.has(target.id)).map((target) => target.id)
    const projected = detachFromRegistry(registry, removable)
    if (projected.changes.length > 0) {
      try {
        await writeJsonAtomic(roots.workspaceRegistry, projected.registry)
        registry = projected.registry
        result.registryChanges = projected.changes
      } catch (error) {
        result.failed.push({ id: '*', stage: 'registry', reason: String(error?.message ?? error) })
      }
    }
  }

  // 3. Delete each session directory and its projection cache.
  for (const target of plan.targets) {
    if (blocked.has(target.id)) continue
    const check = assertDeletable(target.dir, allowedRoots)
    if (!check.ok) {
      result.failed.push({ id: target.id, stage: 'validate', reason: check.reason })
      continue
    }
    try {
      await rm(target.dir, { recursive: true, force: true })
      result.deleted.push({ id: target.id, kind: 'session-dir', path: target.dir, bytes: target.bytes })
    } catch (error) {
      result.failed.push({ id: target.id, stage: 'session-dir', reason: String(error?.message ?? error) })
      continue
    }
    const cacheFile = path.join(roots.projectionCache, `${target.id}.json`)
    const cacheCheck = assertDeletable(cacheFile, allowedRoots)
    if (!cacheCheck.ok) {
      result.failed.push({ id: target.id, stage: 'cache-validate', reason: cacheCheck.reason })
      continue
    }
    if (existsSync(cacheFile)) {
      try {
        await rm(cacheFile, { force: true })
        result.deleted.push({ id: target.id, kind: 'projection-cache', path: cacheFile })
      } catch (error) {
        result.failed.push({ id: target.id, stage: 'projection-cache', reason: String(error?.message ?? error) })
      }
    }
  }

  // 4. Derived search indexes are disposable: removing unreconcilable ones is
  //    safe because they are rebuilt from the surviving logs on next search.
  for (const indexFile of plan.searchIndexes) {
    const check = assertDeletable(indexFile, allowedRoots)
    if (!check.ok) {
      result.searchIndexesKept.push({ path: indexFile, reason: check.reason })
      continue
    }
    try {
      const info = await stat(indexFile)
      await rm(indexFile, { force: true })
      result.searchIndexesRemoved.push({ path: indexFile, bytes: info.size })
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${indexFile}${suffix}`
        if (existsSync(sidecar)) await rm(sidecar, { force: true })
      }
    } catch (error) {
      result.searchIndexesKept.push({ path: indexFile, reason: String(error?.message ?? error) })
    }
  }

  result.finishedAt = now()
  result.summary = {
    sessionsDeleted: result.deleted.filter((entry) => entry.kind === 'session-dir').length,
    cachesDeleted: result.deleted.filter((entry) => entry.kind === 'projection-cache').length,
    bytesDeleted: result.deleted.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0),
    failures: result.failed.length,
  }
  return result
}

/** Default roots derived from a DSH home directory. */
export function rootsFor(dshHome) {
  const home = path.resolve(dshHome)
  return {
    dshHome: home,
    sessions: path.join(home, 'sessions'),
    storages: path.join(home, 'storages'),
    projectionCache: path.join(home, 'storages', 'session_projcache', 'sessions'),
    workspaceRegistry: path.join(home, 'storages', 'workspace.json'),
  }
}
