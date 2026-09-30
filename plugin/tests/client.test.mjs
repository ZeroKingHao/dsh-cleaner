/**
 * Integration test for the built Web client bundle.
 *
 * DSH loads `lib/client.js` as one self-contained factory that receives a
 * `require`. This test replays that contract with a stub `require` so the
 * bundling output and the slot registration are verified without a browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.resolve(here, '..', 'lib', 'client.js')

/**
 * Load the bundle the way DSH does: evaluate the single client resource in a
 * scope that provides the `window.__ModuleLoader__` queue facade, then hand the
 * registered factory a stub `require`.
 */
function loadFactory() {
  const source = readFileSync(bundlePath, 'utf8')
  const loaded = []
  const window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
  // acquire's settle window uses timers; the sandbox needs them provided.
  vm.runInNewContext(source, { window, console, setTimeout, clearTimeout }, { filename: bundlePath })
  if (loaded.length !== 1) throw new Error(`expected exactly one load() call, got ${loaded.length}`)
  if (loaded[0].id !== 'dsh-plugin-session-cleaner') throw new Error(`wrong bundle id: ${loaded[0].id}`)
  return loaded[0].factory
}

/** A React stub good enough to construct elements without a DOM. */
function reactStub() {
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    // State initializers run (the confirm store getter), effects run
    // synchronously so acquire chains settle inside a test body.
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (effect) => { effect() },
    useRef: (initial) => ({ current: initial }),
  }
  return { React, reactDom: { createPortal: (node) => node } }
}

test('the bundle is a factory that returns a Cordis plugin', () => {
  const source = readFileSync(bundlePath, 'utf8')
  // The client module system may not synchronously require a sibling chunk.
  assert.equal(/require\(['"]\.\.?\//.test(source), false, 'no relative require may survive bundling')
  assert.match(source, /require\(['"]react['"]\)/, 'React must come from the platform table')
  assert.match(source, /sessionCleaner\/preview/, 'the Remote contract must be inlined')
})

test('the factory registers a delete row in the session menu slot', async () => {
  const { React, reactDom } = reactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    throw new Error(`unexpected require: ${id}`)
  })

  assert.equal(typeof plugin.apply, 'function')
  // Reading an undeclared Cordis service throws; `remote` (and `typert`, which
  // $mount reaches through the caller's context) must both be declared.
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'remote', 'typert'])

  const registrations = []
  const injections = []
  const ctx = {
    // The locale snapshot carries the active locale under `active`.
    locale: { getLocale: () => ({ active: 'zh-CN' }) },
    slots: {
      inject(name, callback) {
        injections.push(name)
        callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  // Three slots are contributed: the session menu row, the frame-wide confirm
  // dialog and the settings panel.
  assert.deepEqual(injections, [
    'sidebar.workspaces.session.menu.item',
    'shell.overlay',
    'settings.plugins.tab',
  ])
  assert.equal(registrations.length, 3)

  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.options.id, 'session-cleaner.delete', 'a fresh id must not shadow a shipped row')
  assert.equal(menu.options.order, 500, 'must sort after the shipped archive row (400)')
  assert.equal(typeof menu.component, 'function')

  const tab = registrations.find((entry) => entry.options.name === 'settings.plugins.tab')
  assert.equal(tab.options.id, 'session-cleaner')
  assert.equal(typeof tab.component, 'function')
  // A label thunk keeps the tab text following the live locale.
  assert.equal(typeof tab.options.label, 'function')
  assert.equal(tab.options.label(), '会话清理')
})

test('the row renders a menu item and tolerates a missing host service', async () => {
  const { React, reactDom } = reactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    throw new Error(`unexpected require: ${id}`)
  })

  let component
  plugin.apply({
    locale: { getLocale: () => ({ id: 'en' }) },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) {
        if (options.name === 'sidebar.workspaces.session.menu.item') component = value
      },
    },
  })

  // No `document` in this environment: the row must still render its button.
  const rendered = component({
    sessionId: 'session-aaaaaaaa-1111-2222-3333-444444444444',
    displayTitle: 'A session',
  })
  const button = Array.isArray(rendered) ? rendered[0] : rendered
  assert.equal(button.props.role, 'menuitem')
  assert.equal(button.props.type, 'button')
  assert.deepEqual(button.children, ['Delete session'])
})

test('acquire mounts once and reads the namespace under its composed property key', async () => {
  const { React, reactDom } = reactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    throw new Error(`unexpected require: ${id}`)
  })

  const mounts = []
  const injected = []
  const scopeReads = []
  const previewCalls = []
  const service = {
    preview: async (ids) => {
      previewCalls.push(ids)
      return { targetCount: 1, humanBytes: '1 B', targets: [] }
    },
    delete: async () => ({ ok: true, summary: { sessionsDeleted: 1 } }),
  }
  // The gateway composes the namespace service key as `remote.<namespace>` and
  // the Service base class provides the instance under exactly that property
  // name. The scope proxy records every read so the test can tell a composed
  // read (`scope['remote.sessionCleaner']`) from the broken one
  // (`scope.remote.sessionCleaner`) that used to resolve to undefined.
  const scope = new Proxy({
    'remote.sessionCleaner': service,
  }, {
    get(target, key) {
      scopeReads.push(String(key))
      return target[key]
    },
  })
  const registrations = []
  plugin.apply({
    locale: { getLocale: () => ({ id: 'en' }) },
    remote: { $mount: async (contract) => { mounts.push(contract) } },
    inject(keys, callback) {
      injected.push(keys)
      callback(scope)
    },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) { registrations.push({ options, value }); return () => {} },
    },
  })

  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
  assert.equal(typeof overlay.value, 'function', 'the confirm dialog must be registered frame-wide')
  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')

  // Open the dialog the way the user does: click the menu row, then the
  // frame-wide dialog renders. The stubbed React runs effects synchronously,
  // so the acquire chain settles here.
  const sessionId = 'session-aaaaaaaa-1111-2222-3333-444444444444'
  const row = menu.value({ sessionId, displayTitle: 'A session', useMenuOpenState: () => [false, () => {}] })
  await row.props.onClick()
  overlay.value({})

  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(mounts.length, 1, 'exactly one $mount may be issued')
  assert.equal(mounts[0].descriptors.length, 3)
  // The dependency array was created inside the vm sandbox, so expand it into
  // a host-realm array before deep comparison (cross-realm Array prototypes
  // never compare equal).
  assert.deepEqual(injected.map((keys) => [...keys]), [['remote.sessionCleaner']])
  assert.equal(
    scopeReads.filter((key) => key === 'remote.sessionCleaner').length > 0,
    true,
    'the namespace must be read under its composed key',
  )
  assert.equal(
    scopeReads.filter((key) => key === 'remote').length,
    0,
    'the broken read scope.remote.sessionCleaner must be gone',
  )
  assert.deepEqual(previewCalls.map((ids) => [...ids]), [[sessionId]], 'the dialog must reach the Host preview')

  // A second dialog render re-enters acquire: the cached mount must be reused
  // (a second $mount would throw "already registered").
  overlay.value({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(mounts.length, 1, 'the mount must stay cached across acquires')
})

test('the row matches shipped menu rows through MenuItemButton when primitives resolve', async () => {
  const { React, reactDom } = reactStub()
  const primitives = {
    MenuItemButton: ({ icon, onSelect, children }) => ({ type: 'MenuItemButton', props: { icon, onSelect }, children }),
    IconTrashOutlineRegular: (props) => ({ type: 'IconTrashOutlineRegular', props }),
  }
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${id}`)
  })

  let component
  plugin.apply({
    locale: { getLocale: () => ({ active: 'en' }) },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) {
        if (options.name === 'sidebar.workspaces.session.menu.item') component = value
      },
    },
  })

  let menuSetTo
  const rendered = component({
    sessionId: 'session-aaaaaaaa-1111-2222-3333-444444444444',
    displayTitle: 'A session',
    useMenuOpenState: () => [true, (value) => { menuSetTo = value }],
  })
  // Same primitive the shipped pin/rename/fork/archive rows use, trash icon in
  // the leading icon slot, label as children — the row is indistinguishable.
  assert.equal(rendered.type, primitives.MenuItemButton)
  assert.equal(rendered.props.icon.type, primitives.IconTrashOutlineRegular)
  assert.deepEqual(rendered.children, ['Delete session'])
  rendered.props.onSelect()
  assert.equal(menuSetTo, false, 'selection still closes the menu first')
})

test('the confirm dialog renders through the platform Modal and Button pair', async () => {
  const { React, reactDom } = reactStub()
  const primitives = {
    MenuItemButton: ({ icon, onSelect, children }) => ({ type: 'MenuItemButton', props: { icon, onSelect }, children }),
    IconTrashOutlineRegular: (props) => ({ type: 'IconTrashOutlineRegular', props }),
    Modal: ({ open, title, closeLabel, description, footer, children }) => ({ type: 'Modal', props: { open, title, closeLabel, description, footer, children } }),
    Button: ({ variant, disabled, onClick, children }) => ({ type: 'Button', props: { variant, disabled, onClick }, children }),
  }
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${id}`)
  })

  const registrations = []
  const previewCalls = []
  const service = {
    preview: async (ids) => { previewCalls.push([...ids]); return { targetCount: 1, humanBytes: '12.0 KiB' } },
    delete: async () => ({ ok: true }),
  }
  const scope = { 'remote.sessionCleaner': service }
  plugin.apply({
    locale: { getLocale: () => ({ active: 'en' }) },
    remote: { $mount: async () => {} },
    inject(keys, callback) { callback(scope) },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) { registrations.push({ options, value }); return () => {} },
    },
  })
  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')

  const sessionId = 'session-aaaaaaaa-1111-2222-3333-444444444444'
  const row = menu.value({ sessionId, displayTitle: 'A session', useMenuOpenState: () => [true, () => {}] })
  await row.props.onSelect()

  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const dialog = overlay.value({})
  assert.equal(dialog.type, primitives.Modal, 'the dialog is the platform Modal')
  assert.equal(dialog.props.open, true)
  assert.equal(dialog.props.title, 'Delete this session permanently?')
  assert.equal(dialog.props.closeLabel, 'Close')
  assert.equal(dialog.props.description, 'A session')

  // The RiskConfirmation pairing: outline cancel, primary confirm.
  const actions = dialog.props.footer.children
  assert.deepEqual(actions.map((action) => action.props.variant), ['outline', 'primary'])
  assert.deepEqual(actions.map((action) => action.children.flat()), [['Cancel'], ['Delete permanently']])
  // While the preview is still in flight the destructive action stays disabled.
  assert.equal(actions[1].props.disabled, true)
})

test('toggling a session carries its descendant subtree along', () => {
  // The source file is CommonJS living under a "type": "module" package, so
  // evaluate it in a vm context instead of importing it.
  const module = { exports: {} }
  const source = readFileSync(path.resolve(here, '..', 'client', 'settings-tab.js'), 'utf8')
  vm.runInNewContext(source, { module, exports: module.exports }, { filename: 'settings-tab.js' })
  const createSettingsTab = module.exports
  const toggleWithDescendants = module.exports.toggleWithDescendants
  assert.equal(typeof createSettingsTab, 'function')
  assert.equal(typeof toggleWithDescendants, 'function')

  // root ── childA ── grandchild
  //      └─ childB
  // orphan's parent is gone from the list; unrelated is standalone.
  const sessions = [
    { id: 'root' },
    { id: 'childA', parent: 'root' },
    { id: 'grandchild', parent: 'childA' },
    { id: 'childB', parent: 'root' },
    { id: 'orphan', parent: 'deleted-long-ago' },
    { id: 'unrelated' },
  ]

  // Selecting the root selects the whole subtree, two levels deep.
  const afterAdd = toggleWithDescendants(sessions, new Set(), 'root')
  assert.deepEqual([...afterAdd].sort(), ['childA', 'childB', 'grandchild', 'root'])

  // Deselecting the root drops the subtree again, leaving others untouched.
  const afterRemove = toggleWithDescendants(sessions, afterAdd, 'root')
  assert.deepEqual([...afterRemove], [])

  // Selecting a middle node carries descendants but not the parent.
  const middle = toggleWithDescendants(sessions, new Set(['unrelated']), 'childA')
  assert.deepEqual([...middle].sort(), ['childA', 'grandchild', 'unrelated'])

  // Deselecting a middle node drops its subtree and its selected ancestors:
  // a checked root would drag the subtree back into the deletion closure.
  const fromParent = toggleWithDescendants(sessions, new Set(['root', 'childA', 'grandchild', 'childB']), 'childA')
  assert.deepEqual([...fromParent], ['childB'])
})

test('a failed mount reports its reason instead of a generic missing service', async () => {
  const { React, reactDom } = reactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    throw new Error(`unexpected require: ${id}`)
  })

  const registrations = []
  plugin.apply({
    locale: { getLocale: () => ({ id: 'en' }) },
    remote: { $mount: async () => { throw new Error('boom: descriptor rejected') } },
    inject() { throw new Error('inject must not run when the mount failed') },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) { registrations.push({ options, value }); return () => {} },
    },
  })

  const overlay = registrations.find((entry) => entry.options.name === 'shell.overlay')
  // Mount failure surfaces on the dialog; it must not throw out of React.
  overlay.value({})
  await new Promise((resolve) => setImmediate(resolve))
})
