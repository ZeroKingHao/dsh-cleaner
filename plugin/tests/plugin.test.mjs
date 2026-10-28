/**
 * Integration test for the Host half.
 *
 * Drives the real `apply()` against a minimal Cordis stub so the plugin's
 * wiring is exercised, not just its core: symbol exports, service publication,
 * Remote mounting, Tool registration, the Tool schema contract the registry
 * enforces, and the guard that refuses to delete the calling session.
 *
 * The stub records what the plugin did, so a regression in wiring fails here
 * rather than silently at load time inside the app.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import * as plugin from '../src/index.js'
import { rootsFor } from '../src/cleaner.js'

/** Minimal Cordis context: records registrations, exposes nothing else. */
function makeContext({ agents = new Map(), initiator, services } = {}) {
  const tools = new Map()
  const provided = new Map()
  const mounts = []
  const effects = []
  const injections = []
  const events = []

  const ctx = {
    emit(name, ...args) { events.push([name, ...args]) },
    agents: {
      get: (id) => agents.get(id),
      ...(initiator === undefined ? {} : { currentInitiator: () => initiator }),
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    provide(key, value) {
      provided.set(key, value)
      return () => provided.delete(key)
    },
    effect(callback, label) {
      const dispose = callback()
      effects.push({ label, dispose })
      return () => dispose?.()
    },
    get(key) {
      return key === 'remote' ? { $mount: async (contract) => { mounts.push(contract) } } : undefined
    },
    // Only present when the test wants the plugin to see injected services
    // (the live workspace registry): applies the callback immediately, the
    // way Cordis does once every dependency has settled.
    ...(services === undefined ? {} : {
      inject(deps, callback) {
        const scope = {}
        for (const dep of deps) scope[dep] = services[dep]
        const dispose = callback(scope)
        injections.push({ deps, dispose })
        return () => { for (const { dispose } of injections.splice(0)) dispose?.() }
      },
    }),
  }
  return { ctx, tools, provided, mounts, effects, injections, events }
}

/** One deletable session inside a fresh DSH_HOME; returns its directory. */
function makeSession(home, id) {
  const roots = rootsFor(home)
  const dir = path.join(roots.sessions, '--ws--', id)
  mkdirSync(dir, { recursive: true })
  mkdirSync(roots.projectionCache, { recursive: true })
  writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${JSON.stringify({ id })}\n`)))
  return dir
}

/** Run the body with DSH_HOME pointed at a throwaway home directory. */
async function withTempHome(body) {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-cleaner-plugin-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await body(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('the Host module exports the Cordis plugin shape', () => {
  assert.equal(typeof plugin.apply, 'function', 'apply must be exported')
  assert.equal(typeof plugin.name, 'string')
  assert.ok(Array.isArray(plugin.inject), 'inject must be an array')
  assert.ok(plugin.inject.includes('tools'), 'the Tool registry is required')
  assert.ok(plugin.inject.includes('agents'), 'agent lookup is required for stopping')
})

test('apply() publishes the service, mounts Remote and registers the Tool', async () => {
  const { ctx, tools, provided, mounts, effects } = makeContext()
  plugin.apply(ctx)

  // The service the Web client and the Tool both call.
  const service = provided.get('sessionCleaner')
  assert.ok(service !== undefined, 'the sessionCleaner service must be provided')
  for (const method of ['list', 'preview', 'read', 'delete']) {
    assert.equal(typeof service[method], 'function', `service.${method} must exist`)
  }
  assert.ok(service.typertRemote !== undefined, 'the Remote binding must be attached')
  assert.equal(service.typertRemote.serviceKey, 'sessionCleaner')

  // The Remote contract is mounted by the Web CLIENT half; the Host half only
  // binds `typertRemote` on the service and never mounts consumer descriptors
  // (mounting them Host-side registers gateway state with no typert record).
  assert.equal(mounts.length, 0, 'the Host half must not mount Remote descriptors')

  // The model-facing Tool.
  const tool = tools.get('session_delete')
  assert.ok(tool !== undefined, 'session_delete must be registered')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')

  // The registry enforces output.schema and output.render; assert the same shape.
  assert.equal(typeof tool.output.schema, 'object')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.properties.sessionIds.type, 'array')
  assert.equal(tool.parameters.properties.dryRun.type, 'boolean')
  // Canonical JSON Schema: required is a top-level array. A per-property
  // `required: true` passed the registry but the model provider rejected it
  // (`true is not of type "array"`), failing every conversation.
  assert.deepEqual(tool.parameters.required, ['sessionIds'])
  assert.equal(tool.parameters.properties.sessionIds.required, undefined)

  // Regression guard mirroring assertSupportedJsonSchema's keyword rules:
  // seven types only, and each keyword only on its own type.
  const ALLOWED = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  const KEYWORD_TYPES = { properties: 'object', required: 'object', additionalProperties: 'object', items: 'array' }
  const assertSupported = (node, where) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    assert.ok(!Array.isArray(node.type), `${where}.type must not be an array`)
    if (typeof node.type === 'string') {
      assert.ok(ALLOWED.has(node.type), `${where}: unsupported JSON schema type "${node.type}"`)
      for (const [keyword, owner] of Object.entries(KEYWORD_TYPES)) {
        if (Object.hasOwn(node, keyword)) {
          assert.equal(node.type, owner, `${where}.${keyword} is not supported on type "${node.type}"`)
        }
      }
    }
    if (Array.isArray(node.required)) {
      for (const name of node.required) assert.equal(typeof name, 'string', `${where}.required entries must be strings`)
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'properties' && child !== null && typeof child === 'object') {
        for (const [name, sub] of Object.entries(child)) assertSupported(sub, `${where}.properties.${name}`)
      } else if (key === 'items') {
        assertSupported(child, `${where}.items`)
      }
    }
  }
  assertSupported(tool.output.schema, 'output.schema')
  assertSupported(tool.parameters, 'parameters')

  // render() must produce content blocks from the declared value.
  const blocks = tool.output.render({}, { ok: true, targetCount: 0 })
  assert.ok(Array.isArray(blocks) && blocks[0].type === 'text')

  assert.equal(effects.length, 1, 'one effect must own the Tool registration')
})

test('the Tool defaults to a dry run that deletes nothing', async () => {
  const { ctx, tools } = makeContext()
  plugin.apply(ctx)
  const tool = tools.get('session_delete')

  const result = await tool.execute({ sessionIds: [] })
  assert.equal(result.dryRun, true)
  assert.equal(result.ok, true)
  // An empty id list must never reach the deletion path.
  assert.equal(result.targetCount, 0)
  assert.match(result.message, /Would delete/)
})

test('the Tool refuses to delete the session that is running the call', async () => {
  const { ctx, tools } = makeContext({ initiator: { id: 'session-guard' } })
  plugin.apply(ctx)
  const tool = tools.get('session_delete')

  const result = await tool.execute({ sessionIds: ['session-guard'], dryRun: false })
  assert.equal(result.ok, false)
  assert.match(result.error, /refused/)
})

test('the service refuses a delete set containing the guarded session', async () => {
  const { ctx, provided } = makeContext()
  plugin.apply(ctx)
  const service = provided.get('sessionCleaner')

  const result = await service.delete(['session-aaaaaaaa-1111-2222-3333-444444444444'], {
    guard: 'session-aaaaaaaa-1111-2222-3333-444444444444',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /currently open/)
})

test('the service rejects an empty or invalid id list without touching disk', async () => {
  const { ctx, provided } = makeContext()
  plugin.apply(ctx)
  const service = provided.get('sessionCleaner')

  for (const ids of [[], ['not-a-session'], ['../../etc'], undefined]) {
    const result = await service.delete(ids, {})
    assert.equal(result.ok, false, `must refuse: ${JSON.stringify(ids)}`)
    assert.match(result.error, /no valid session ids/)
  }
})

test('preview reports the data root and never deletes', async () => {
  const { ctx, provided } = makeContext()
  plugin.apply(ctx)
  const service = provided.get('sessionCleaner')

  const preview = await service.preview(['session-aaaaaaaa-1111-2222-3333-444444444444'])
  assert.equal(typeof preview.targetCount, 'number')
  assert.equal(preview.targetCount, 0, 'an unknown session has nothing to delete')
  assert.match(preview.note, /permanent/i)
  assert.ok(Array.isArray(preview.registryChanges))
})

test('read refuses invalid or unknown session ids without touching a log', async () => {
  const { ctx, provided } = makeContext()
  plugin.apply(ctx)
  const service = provided.get('sessionCleaner')

  for (const id of ['not-a-session', '../../etc', undefined, null]) {
    const result = await service.read(id)
    assert.equal(result.ok, false, `must refuse: ${String(id)}`)
    assert.match(result.error, /not a valid session id/)
  }

  // A well-formed id that is absent from disk: the scan locates logs, so an
  // unknown id is refused before any file is opened.
  const missing = await service.read('session-aaaaaaaa-1111-2222-3333-444444444444')
  assert.equal(missing.ok, false)
  assert.match(missing.error, /not found/)
})

test('unregistering the effect removes the Tool', () => {
  const { ctx, tools, effects } = makeContext()
  plugin.apply(ctx)
  assert.ok(tools.has('session_delete'))
  effects[0].dispose()
  assert.equal(tools.has('session_delete'), false)
})

test('a live workspace registry detaches through the service and owns the file', async () => {
  await withTempHome(async (home) => {
    const id = 'session-aaaaaaaa-1111-2222-3333-444444444444'
    const dir = makeSession(home, id)
    const roots = rootsFor(home)
    writeFileSync(roots.workspaceRegistry, JSON.stringify({
      global: { archivedSessionIds: [id], pinnedSessionIds: [] },
      tables: { workspaces: { w1: { sessionIds: [id] } } },
    }))
    const fileBefore = readFileSync(roots.workspaceRegistry, 'utf8')

    const calls = []
    // Set after makeContext returns; lets the registry stubes assert that the
    // client-removal event has already been emitted by the time any registry
    // mutation starts.
    const eventsBox = { current: null }
    const expectRemovalEventFirst = (stage) => {
      assert.ok(
        eventsBox.current?.some(([name]) => name === 'api-session/removed'),
        `the removal event must precede the ${stage} mutation`,
      )
    }
    const registry = {
      archivedSessionIds: [id],
      pinnedSessionIds: [],
      list: () => [{
        id: 'w1',
        sessionIds: [id],
        detachSession: async (sessionId) => { expectRemovalEventFirst('detach'); calls.push(['detach', 'w1', sessionId]) },
      }],
      unarchiveSession: async (sessionId) => { expectRemovalEventFirst('unarchive'); calls.push(['unarchive', sessionId]) },
      unpinSession: async (sessionId) => { expectRemovalEventFirst('unpin'); calls.push(['unpin', sessionId]) },
    }

    const { ctx, provided, events } = makeContext({ services: { workspaceRegistry: registry } })
    eventsBox.current = events
    plugin.apply(ctx)
    const service = provided.get('sessionCleaner')

    const result = await service.delete([id], {})
    assert.equal(result.ok, true)
    assert.equal(result.registrySync, 'live-registry')
    // Archive first, pin never (the id is not pinned), then the entity detach.
    assert.deepEqual(calls, [['unarchive', id], ['detach', 'w1', id]])
    assert.equal(events.filter(([name]) => name === 'api-session/removed').length, 1,
      'one removal event per deleted session')
    assert.equal(existsSync(dir), false, 'the session files are deleted')
    assert.equal(readFileSync(roots.workspaceRegistry, 'utf8'), fileBefore,
      'while the registry service is live, this plugin must not write the file')
    assert.deepEqual(result.registryChanges, [
      { where: 'global.archivedSessionIds', removed: 1 },
      { where: 'workspaces[w1].sessionIds', removed: 1 },
    ])
    assert.equal(result.warnings.length, 0)
  })
})

test('a live registry that refuses only warns — the deletion itself stands', async () => {
  await withTempHome(async (home) => {
    const id = 'session-aaaaaaaa-1111-2222-3333-444444444444'
    const dir = makeSession(home, id)
    const registry = {
      archivedSessionIds: [],
      pinnedSessionIds: [],
      list: () => { throw new Error('registry exploded') },
    }

    const { ctx, provided } = makeContext({ services: { workspaceRegistry: registry } })
    plugin.apply(ctx)
    const service = provided.get('sessionCleaner')

    const result = await service.delete([id], {})
    assert.equal(result.ok, true, 'files are gone: a failing detach is a warning, not a failure')
    assert.equal(existsSync(dir), false)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /registry exploded/)
  })
})

test('without a live registry the service falls back to editing the registry file', async () => {
  await withTempHome(async (home) => {
    const id = 'session-aaaaaaaa-1111-2222-3333-444444444444'
    const dir = makeSession(home, id)
    const roots = rootsFor(home)
    writeFileSync(roots.workspaceRegistry, JSON.stringify({
      global: { archivedSessionIds: [], pinnedSessionIds: [] },
      tables: { workspaces: { w1: { sessionIds: [id] } } },
    }))

    const { ctx, provided } = makeContext()
    plugin.apply(ctx)
    const service = provided.get('sessionCleaner')

    const result = await service.delete([id], {})
    assert.equal(result.ok, true)
    assert.equal(result.registrySync, 'registry-file')
    assert.equal(existsSync(dir), false)
    const registry = JSON.parse(readFileSync(roots.workspaceRegistry, 'utf8'))
    assert.deepEqual(registry.tables.workspaces.w1.sessionIds, [], 'the file fallback still detaches')
  })
})
