/**
 * Unit tests for the cleaner core. Runs with `node --test`.
 *
 * The dangerous-path cases matter most: this module is the last line of defence
 * before real user data is removed, so every rejection path is asserted.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  assertDeletable,
  detachFromRegistry,
  executeDeletion,
  expandWithDescendants,
  isContained,
  isValidSessionId,
  normalizeForCompare,
  planDeletion,
  readSessionHeader,
  rootsFor,
  scanSessions,
  writeJsonAtomic,
} from '../src/cleaner.js'

const USER_A = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const USER_B = 'sess_bbbbbbbb-1111-2222-3333-444444444444'
const CHILD = 'cccccccc-1111-2222-3333-444444444444'
const CHILD2 = 'dddddddd-1111-2222-3333-444444444444'

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-cleaner-test-'))
  const roots = rootsFor(home)
  mkdirSync(roots.projectionCache, { recursive: true })
  return { home, roots }
}

function writeSession(roots, workspaceKey, id, header, body = '') {
  const dir = path.join(roots.sessions, workspaceKey, id)
  mkdirSync(dir, { recursive: true })
  const lines = [JSON.stringify(header), ...(body ? [body] : [])].join('\n') + '\n'
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(lines, 'utf8')))
  return dir
}

// ---------------------------------------------------------------------------
// ID grammar
// ---------------------------------------------------------------------------

test('accepts all three shipped session id forms', () => {
  assert.equal(isValidSessionId(USER_A), true, 'session-<uuid>')
  assert.equal(isValidSessionId(USER_B), true, 'sess_<uuid>')
  assert.equal(isValidSessionId(CHILD), true, 'bare uuid (subagent)')
})

test('rejects non-session names', () => {
  const rejected = [
    '', 'session', 'session-', 'sess-', 'sessions', '..', '.', '../etc',
    'session-aaaaaaaa-1111-2222-3333-44444444444', 'session-aaaaaaaa-1111-2222-3333-4444444444444',
    'session-zzzzzzzz-1111-2222-3333-444444444444',
    'session-aaaaaaaa_1111_2222_3333_444444444444',
    'user-session-aaaaaaaa-1111-2222-3333-444444444444',
    'session-aaaaaaaa-1111-2222-3333-444444444444/../evil',
    null, undefined, 42, {},
  ]
  for (const value of rejected) {
    assert.equal(isValidSessionId(value), false, `should reject: ${String(value)}`)
  }
})

// ---------------------------------------------------------------------------
// Containment guards
// ---------------------------------------------------------------------------

test('isContained accepts children and rejects siblings, parents and traversal', () => {
  const root = path.join(tmpdir(), 'dsh-root')
  assert.equal(isContained(root, path.join(root, 'a', 'b')), true)
  assert.equal(isContained(root, root), true)
  assert.equal(isContained(root, path.join(root, '..', 'elsewhere')), false)
  assert.equal(isContained(root, tmpdir()), false)
  assert.equal(isContained(root, path.join(root, 'a', '..', '..', 'x')), false)
})

test('normalizeForCompare is case-insensitive on Windows only', () => {
  const normalized = normalizeForCompare('C:\\Mixed\\Case')
  if (process.platform === 'win32') assert.equal(normalized, 'c:\\mixed\\case')
  else assert.equal(normalized, 'C:\\Mixed\\Case'.toLowerCase() === normalized ? normalized : normalized)
})

test('assertDeletable refuses paths outside every allowed root', () => {
  const roots = [path.join(tmpdir(), 'allowed')]
  const inside = path.join(roots[0], 'session-x')
  assert.equal(assertDeletable(inside, roots).ok, true)
  assert.equal(assertDeletable(path.join(tmpdir(), 'other'), roots).ok, false)
  // Traversal that escapes must be refused even though it starts inside.
  assert.equal(assertDeletable(path.join(roots[0], '..', 'escape'), roots).ok, false)
})

// ---------------------------------------------------------------------------
// Header reading
// ---------------------------------------------------------------------------

test('readSessionHeader reads a zstd v4 header and a flat v3 header', async () => {
  const { roots } = makeHome()
  const v4 = writeSession(roots, '--ws--', USER_A, { id: USER_A, cwd: 'C:\\x', parentSession: CHILD })
  const headerV4 = await readSessionHeader(path.join(v4, 'session.v4.jsonl.zstd'))
  assert.equal(headerV4.id, USER_A)
  assert.equal(headerV4.parent, CHILD)
  assert.equal(headerV4.cwd, 'C:\\x')

  // v3 logs carry a flat header with no `meta` wrapper.
  const dir = path.join(roots.sessions, '--ws--', USER_B)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'session.v3.jsonl.zstd'),
    zstdCompressSync(Buffer.from(`${JSON.stringify({ id: USER_B, cwd: 'E:\\y' })}\n`, 'utf8')),
  )
  const headerV3 = await readSessionHeader(path.join(dir, 'session.v3.jsonl.zstd'))
  assert.equal(headerV3.id, USER_B)
  assert.equal(headerV3.cwd, 'E:\\y')
  assert.equal(headerV3.parent, undefined)
})

test('readSessionHeader returns undefined instead of throwing on garbage', async () => {
  const { roots } = makeHome()
  const dir = path.join(roots.sessions, '--ws--', USER_A)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.from('this is definitely not zstd'))
  assert.equal(await readSessionHeader(file), undefined)
  assert.equal(await readSessionHeader(path.join(dir, 'missing.jsonl.zstd')), undefined)
})

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

test('scanSessions indexes valid directories and skips non-session ones', async () => {
  const { roots } = makeHome()
  writeSession(roots, '--ws-a--', USER_A, { id: USER_A })
  writeSession(roots, '--ws-b--', CHILD, { id: CHILD, parentSession: USER_A })
  // A directory that is not a session, and one with no log at all.
  mkdirSync(path.join(roots.sessions, '--ws-a--', 'not-a-session'), { recursive: true })
  mkdirSync(path.join(roots.sessions, '--ws-a--', USER_B), { recursive: true })

  const { records, skipped } = await scanSessions(roots)
  assert.equal(records.size, 2)
  assert.equal(records.get(USER_A).workspaceKey, '--ws-a--')
  assert.equal(records.get(CHILD).parent, USER_A)
  assert.equal(skipped.length, 2)
})

test('scanSessions tolerates a missing sessions root', async () => {
  const { roots } = makeHome()
  const { records, skipped } = await scanSessions(roots)
  assert.equal(records.size, 0)
  assert.deepEqual(skipped, [])
})

// ---------------------------------------------------------------------------
// Cascade
// ---------------------------------------------------------------------------

test('expandWithDescendants walks grandchildren and is cycle-safe', () => {
  const records = new Map([
    [USER_A, { id: USER_A, parent: undefined }],
    [CHILD, { id: CHILD, parent: USER_A }],
    [CHILD2, { id: CHILD2, parent: CHILD }],
    // A self-parenting record must not loop forever.
    ['eeeeeeee-1111-2222-3333-444444444444', { id: 'eeeeeeee-1111-2222-3333-444444444444', parent: 'eeeeeeee-1111-2222-3333-444444444444' }],
  ])
  const expanded = expandWithDescendants(records, [USER_A])
  assert.deepEqual(expanded, [
    { id: USER_A, depth: 0 },
    { id: CHILD, depth: 1 },
    { id: CHILD2, depth: 2 },
  ])
  const selfCycle = expandWithDescendants(records, ['eeeeeeee-1111-2222-3333-444444444444'])
  assert.equal(selfCycle.length, 1)
})

test('expandWithDescendants deduplicates repeated roots', () => {
  const records = new Map([[USER_A, { id: USER_A }]])
  const expanded = expandWithDescendants(records, [USER_A, USER_A, USER_A])
  assert.equal(expanded.length, 1)
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('detachFromRegistry removes ids from workspaces, archived and pinned lists', () => {
  const registry = {
    global: { archivedSessionIds: [USER_A, CHILD], pinnedSessionIds: [USER_B], workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { sessionIds: [USER_A, USER_B, CHILD] } } },
  }
  const { registry: next, changes } = detachFromRegistry(registry, [USER_A, CHILD])
  assert.deepEqual(next.tables.workspaces.w1.sessionIds, [USER_B])
  assert.deepEqual(next.global.archivedSessionIds, [])
  // pinnedSessionIds holds neither target, so it is not reported as a change.
  assert.deepEqual(next.global.pinnedSessionIds, [USER_B])
  assert.equal(changes.length, 2)
  assert.deepEqual(changes.map((change) => change.where).sort(), [
    'global.archivedSessionIds',
    'workspaces[w1].sessionIds',
  ])
  // The original object must not be mutated.
  assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [USER_A, USER_B, CHILD])
  assert.deepEqual(registry.global.archivedSessionIds, [USER_A, CHILD])
})

test('detachFromRegistry tolerates malformed registries', () => {
  for (const value of [undefined, null, {}, { global: null }, { tables: {} }, { tables: { workspaces: null } }]) {
    const { registry, changes } = detachFromRegistry(value, [USER_A])
    assert.deepEqual(changes, [])
    assert.equal(registry, value)
  }
})

test('writeJsonAtomic replaces the file and leaves no temp behind', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cleaner-atomic-'))
  const file = path.join(dir, 'workspace.json')
  writeFileSync(file, '{"old":true}')
  await writeJsonAtomic(file, { fresh: true })
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { fresh: true })
})

// ---------------------------------------------------------------------------
// Plan + execute
// ---------------------------------------------------------------------------

test('planDeletion reports totals, cascade, registry changes and rejects bad ids', async () => {
  const { roots } = makeHome()
  writeSession(roots, '--ws-a--', USER_A, { id: USER_A }, 'x'.repeat(500))
  writeSession(roots, '--ws-a--', CHILD, { id: CHILD, parentSession: USER_A })
  writeSession(roots, '--ws-b--', USER_B, { id: USER_B })
  writeFileSync(roots.workspaceRegistry, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { sessionIds: [USER_A, CHILD, USER_B] } } },
  }))

  const plan = await planDeletion(roots, [USER_A, 'not-a-session', '../../etc'], { rootSessionId: USER_A })
  assert.deepEqual(plan.targets.map((target) => target.id).sort(), [USER_A, CHILD].sort())
  assert.equal(plan.totals.sessions, 2)
  assert.ok(plan.totals.bytes > 0)
  assert.deepEqual(plan.rejectedIds, ['not-a-session', '../../etc'])
  assert.equal(plan.registryChanges.length, 1)
  assert.equal(plan.registryChanges[0].removed, 2)
})

test('planDeletion reports a requested session that is not on disk', async () => {
  const { roots } = makeHome()
  const plan = await planDeletion(roots, [USER_A])
  assert.deepEqual(plan.targets, [])
  assert.deepEqual(plan.missing, [USER_A])
})

test('executeDeletion removes directories, caches and registry entries', async () => {
  const { roots } = makeHome()
  const dirA = writeSession(roots, '--ws-a--', USER_A, { id: USER_A })
  const dirChild = writeSession(roots, '--ws-a--', CHILD, { id: CHILD, parentSession: USER_A })
  const dirB = writeSession(roots, '--ws-b--', USER_B, { id: USER_B })
  const cacheA = path.join(roots.projectionCache, `${USER_A}.json`)
  const cacheChild = path.join(roots.projectionCache, `${CHILD}.json`)
  const cacheB = path.join(roots.projectionCache, `${USER_B}.json`)
  for (const file of [cacheA, cacheChild, cacheB]) writeFileSync(file, '{}')
  writeFileSync(roots.workspaceRegistry, JSON.stringify({
    global: { archivedSessionIds: [USER_A], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { sessionIds: [USER_A, CHILD, USER_B] } } },
  }))

  const stopped = []
  const plan = await planDeletion(roots, [USER_A])
  const result = await executeDeletion(roots, plan, {
    stop: async (id) => { stopped.push(id); return { stillRunning: false } },
  })

  // Cascade reached the child; the unrelated session survived.
  assert.deepEqual(stopped.sort(), [USER_A, CHILD].sort())
  assert.equal(existsSync(dirA), false)
  assert.equal(existsSync(dirChild), false)
  assert.equal(existsSync(dirB), true, 'unrelated session must survive')
  assert.equal(existsSync(cacheA), false)
  assert.equal(existsSync(cacheChild), false)
  assert.equal(existsSync(cacheB), true, 'unrelated cache must survive')

  const registry = JSON.parse(readFileSync(roots.workspaceRegistry, 'utf8'))
  assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [USER_B])
  assert.deepEqual(registry.global.archivedSessionIds, [])
  assert.equal(result.summary.sessionsDeleted, 2)
  assert.equal(result.summary.cachesDeleted, 2)
  assert.equal(result.summary.failures, 0)
})

test('executeDeletion aborts before deleting when a session refuses to stop', async () => {
  const { roots } = makeHome()
  const dirA = writeSession(roots, '--ws-a--', USER_A, { id: USER_A })
  writeFileSync(roots.workspaceRegistry, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { sessionIds: [USER_A] } } },
  }))

  const plan = await planDeletion(roots, [USER_A])
  const result = await executeDeletion(roots, plan, {
    stop: async () => ({ stillRunning: true, reason: 'agent busy' }),
  })

  assert.equal(result.aborted, true)
  assert.equal(existsSync(dirA), true, 'nothing may be deleted after a failed stop')
  const registry = JSON.parse(readFileSync(roots.workspaceRegistry, 'utf8'))
  assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [USER_A], 'registry must stay intact')
})

test('executeDeletion keeps the registry intact when stopping is allowed to proceed', async () => {
  const { roots } = makeHome()
  writeSession(roots, '--ws-a--', USER_A, { id: USER_A })
  writeFileSync(roots.workspaceRegistry, JSON.stringify({
    global: { archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { w1: { sessionIds: [USER_A] } } },
  }))
  const plan = await planDeletion(roots, [USER_A])
  const result = await executeDeletion(roots, plan, {
    stop: async () => ({ stillRunning: true }),
    requireStopped: false,
  })
  assert.equal(result.aborted, undefined)
  assert.equal(result.summary.sessionsDeleted, 1)
})
