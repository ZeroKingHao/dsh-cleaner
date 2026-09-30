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
      records.set(dir.name, {
        id: dir.name,
        workspaceKey,
        dir: sessionDir,
        logFile,
        logName,
        bytes,
        parent: header?.parent,
        cwd: header?.cwd,
        title: header?.title,
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
