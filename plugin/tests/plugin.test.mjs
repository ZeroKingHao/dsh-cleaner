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
import test from 'node:test'

import * as plugin from '../src/index.js'

/** Minimal Cordis context: records registrations, exposes nothing else. */
function makeContext({ agents = new Map(), initiator } = {}) {
  const tools = new Map()
  const provided = new Map()
  const mounts = []
  const effects = []

  const ctx = {
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
  }
  return { ctx, tools, provided, mounts, effects }
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
  for (const method of ['list', 'preview', 'delete']) {
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

test('unregistering the effect removes the Tool', () => {
  const { ctx, tools, effects } = makeContext()
  plugin.apply(ctx)
  assert.ok(tools.has('session_delete'))
  effects[0].dispose()
  assert.equal(tools.has('session_delete'), false)
})
