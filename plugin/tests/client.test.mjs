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
    useMemo: (factory) => factory(),
  }
  return { React, reactDom: { createPortal: (node) => node } }
}

/**
 * A React stub with REAL hook state: setters update a shared slot store, and
 * the test re-invokes the component to observe the next state — enough to
 * walk the panel through its loading → ready → preview-open states. Effects
 * run once: the page's only effect is mount-only.
 */
function statefulReactStub() {
  const slots = []
  const state = { cursor: 0, effectsRun: false }
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const slot = state.cursor
      state.cursor += 1
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value }]
    },
    useEffect: (effect) => {
      if (!state.effectsRun) {
        state.effectsRun = true
        effect()
      }
    },
    useRef: (initial) => ({ current: initial }),
    useMemo: (factory) => factory(),
  }
  const render = (component, props = {}) => {
    state.cursor = 0
    return component(props)
  }
  return { React, render }
}

/** Collect every element node in a stub-rendered tree. */
function collect(node, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, found)
    return found
  }
  if (typeof node.type === 'string' || typeof node.type === 'symbol') {
    found.push(node)
    collect(node.children, found)
  }
  return found
}

/** Let the stubbed async chains (mount, inject, list, read) settle. */
const settle = async (rounds = 4) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Evaluate panel-page.js for its exported helpers. The source file is
 * CommonJS living under a "type": "module" package, so it runs in a vm context
 * instead of being imported.
 */
function loadPanelPageModule() {
  const module = { exports: {} }
  const source = readFileSync(path.resolve(here, '..', 'client', 'panel-page.js'), 'utf8')
  vm.runInNewContext(source, { module, exports: module.exports, document: undefined }, { filename: 'panel-page.js' })
  return module.exports
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

  // Four slots are contributed: the session menu row, the frame-wide confirm
  // dialog, the global cleanup page and its sidebar entry.
  assert.deepEqual(injections, [
    'sidebar.workspaces.session.menu.item',
    'shell.overlay',
    'main',
    'sidebar.panellist',
  ])
  assert.equal(registrations.length, 4)

  const menu = registrations.find((entry) => entry.options.name === 'sidebar.workspaces.session.menu.item')
  assert.equal(menu.options.id, 'session-cleaner.delete', 'a fresh id must not shadow a shipped row')
  assert.equal(menu.options.order, 500, 'must sort after the shipped archive row (400)')
  assert.equal(typeof menu.component, 'function')

  const panel = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.equal(panel.options.id, 'session-cleaner')
  // Same level as the shipped rows: Plugins sits at order 0, Automation
  // Tasks at 10 — the cleanup panel sorts right after them.
  assert.equal(panel.options.order, 20)
  assert.equal(typeof panel.component, 'function')
  // A label thunk keeps the row text following the live locale.
  assert.equal(typeof panel.options.label, 'function')
  assert.equal(panel.options.label(), '会话清理')

  const page = registrations.find((entry) => entry.options.name === 'main')
  // The sidebar row selects the page by panel id, resolved as the main-slot
  // key: a diverging key would make selectPanel throw and keep the row dead.
  assert.equal(page.options.key, panel.options.id)
  assert.equal(typeof page.component, 'function')
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
  assert.equal(mounts[0].descriptors.length, 4)
  // The dependency array was created inside the vm sandbox, so expand it into
  // a host-realm array before deep comparison (cross-realm Array prototypes
  // never compare equal). The session-list injection is the refresh channel
  // opened at apply time; the namespace injection happens on first acquire.
  assert.deepEqual(injected.map((keys) => [...keys]), [['sessions'], ['remote.sessionCleaner']])
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

test('a successful delete re-pulls the client session list once', async () => {
  const { React, reactDom } = reactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    throw new Error(`unexpected require: ${id}`)
  })

  const refreshes = []
  const service = {
    preview: async () => ({ targetCount: 1, humanBytes: '12.0 KiB' }),
    delete: async () => ({ ok: true }),
  }
  const scope = {
    'remote.sessionCleaner': service,
    // The client's session-list snapshot service (api-session-controller):
    // refresh() re-runs session/list on the Host and drops rows whose
    // session files no longer exist.
    sessions: { refresh: async () => { refreshes.push(1) } },
  }
  const registrations = []
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
  await row.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  // Fallback card (no primitives lane): find the destructive confirm among
  // the rendered buttons by its label.
  const dialog = overlay.value({})
  const confirm = collect(dialog).find((node) =>
    node.type === 'button' && node.children.flat().includes('Delete permanently'))
  await confirm.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(refreshes.length, 1, 'exactly one session-list refresh after a deletion')
})

test('the sidebar entry renders the trash glyph at the size the row hands it', async () => {
  const { React, reactDom } = reactStub()
  const primitives = {
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
        if (options.name === 'sidebar.panellist') component = value
      },
    },
  })

  // The sidebar hands `{ size, active }`; the glyph forwards the size so the
  // row stays metrically identical to the shipped entries.
  const glyph = component({ size: 18, active: false })
  assert.equal(glyph.type, primitives.IconTrashOutlineRegular)
  assert.equal(glyph.props.size, 18)
})

test('the cleanup page renders the global-page chrome with a level-1 heading', async () => {
  const { React, reactDom } = reactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return reactDom
    throw new Error(`unexpected require: ${id}`)
  })

  let component
  plugin.apply({
    locale: { getLocale: () => ({ active: 'en' }) },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) {
        if (options.name === 'main') component = value
      },
    },
  })

  // The stub runs effects synchronously; acquire resolves to undefined (no
  // remote in this ctx), so the page settles on its service-missing state —
  // which still has to carry the page shell and heading.
  const rendered = component({})
  assert.equal(rendered.type, 'section')
  assert.equal(rendered.props['aria-label'], 'Session cleanup')
  const scroll = rendered.children[0]
  const content = scroll.children[0]
  // The content div receives its children as one array argument, which the
  // stub preserves as a nested array.
  const heading = content.children[0][0]
  assert.equal(heading.type, 'h1')
  assert.deepEqual(heading.children, ['Session cleanup'])
})

test('the cleanup page opens a conversation preview from a row', async () => {
  const { React, render } = statefulReactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require: ${id}`)
  })

  const USER = 'session-aaaaaaaa-1111-2222-3333-444444444444'
  const readCalls = []
  const service = {
    list: async () => ({
      sessions: [{
        id: USER, workspaceKey: '--ws--', bytes: 10, humanBytes: '10 B',
        parent: undefined, cwd: 'F:\\x', title: undefined,
      }],
    }),
    read: async (sessionId, options) => {
      readCalls.push([sessionId, options])
      return {
        ok: true, id: sessionId, workspaceKey: '--ws--', cwd: 'F:\\x',
        bytes: 10, humanBytes: '10 B', title: 'A titled conversation',
        createdAt: 1790000000000, messages: [
          { role: 'user', text: 'hello', time: 1790000001000 },
          { role: 'assistant', text: 'hi', time: 1790000002000, model: 'deepseek-flash' },
        ],
        totalMessages: 2, truncated: false,
      }
    },
  }
  let component
  plugin.apply({
    locale: { getLocale: () => ({ active: 'en' }) },
    remote: { $mount: async () => {} },
    inject(keys, callback) { callback({ 'remote.sessionCleaner': service }) },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) {
        if (options.name === 'main') component = value
      },
    },
  })

  // The first render mounts and starts loading; after the settle the second
  // render shows the group headers (the list itself starts collapsed).
  render(component)
  await settle()
  const ready = render(component)
  // A filter that matches auto-expands the group, revealing its rows.
  const search = collect(ready).find((node) => node.type === 'input' && node.props.type === 'search')
  search.props.onChange({ target: { value: USER } })
  const filtered = render(component)
  const labels = collect(filtered).filter((node) => node.type === 'label')
  assert.equal(labels.length, 1)
  assert.equal(typeof labels[0].props.onDoubleClick, 'function', 'a row double-click opens the preview')

  // Rapidly clicking the checkbox is check/uncheck only: the trailing
  // dblclick must stop on the checkbox, never reach the label's preview
  // handler above.
  const rowCheck = collect(labels[0]).find((node) => node.type === 'input' && node.props.type === 'checkbox')
  let propagationStopped = false
  assert.equal(typeof rowCheck.props.onDoubleClick, 'function', 'the checkbox owns its dblclick')
  rowCheck.props.onDoubleClick({ stopPropagation() { propagationStopped = true } })
  assert.equal(propagationStopped, true, 'the checkbox swallows its own double-click')

  const previewButton = collect(labels[0]).find(
    (node) => node.type === 'button' && node.children.flat().includes('Preview'))
  assert.notEqual(previewButton, undefined, 'each row carries a preview button')
  await previewButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle()
  // The arguments were created inside the vm sandbox; expand them into
  // host-realm values before comparing (cross-realm prototypes never equal).
  assert.equal(readCalls.length, 1)
  assert.equal(readCalls[0][0], USER)
  assert.deepEqual({ ...readCalls[0][1] }, {}, 'the button reaches the Host read with empty options')

  // The settled third render shows the dialog: a wide, resizable card.
  const withDialog = render(component)
  const dialog = collect(withDialog).find((node) => node.props?.role === 'dialog')
  assert.notEqual(dialog, undefined)
  assert.equal(dialog.props['aria-label'], 'Conversation preview')
  assert.equal(dialog.props.style.width, 'min(92vw, 920px)', 'wide by default')
  const grip = collect(withDialog).find((node) => node.props?.['aria-label'] === 'Resize (double-click to reset)')
  assert.notEqual(grip, undefined, 'the corner resize grip is rendered')
  // No panel DOM in the stub: the drag starter must bail out, not throw.
  grip.props.onPointerDown({})
  const paragraphs = collect(withDialog)
    .filter((node) => node.type === 'p')
    .map((node) => node.children.flat().join(''))
  assert.ok(paragraphs.some((text) => text.includes('A titled conversation')), 'the title from the log is shown')
  assert.ok(paragraphs.some((text) => text.includes(USER)), 'the session id sits under the preview title')
  assert.ok(paragraphs.some((text) => text.includes('F:\\x')), 'the workspace path is shown (not its encoded key)')
  const messageTexts = collect(withDialog)
    .filter((node) => node.type === 'div' && node.props?.key === 'text')
    .map((node) => node.children.flat().join(''))
  assert.deepEqual(messageTexts, ['hello', 'hi'], 'both sides of the conversation are rendered')

  // Closing drops the dialog; a double-click reopens it through the same read.
  const closeButton = collect(withDialog).find(
    (node) => node.type === 'button' && node.children.flat().includes('Close'))
  closeButton.props.onClick()
  assert.equal(collect(render(component)).find((node) => node.props?.role === 'dialog'), undefined)
  await labels[0].props.onDoubleClick()
  await settle()
  assert.equal(readCalls.length, 2, 'a row double-click reads the transcript too')
})

test('toggling a session carries its descendant subtree along', () => {
  // The source file is CommonJS living under a "type": "module" package, so
  // evaluate it in a vm context instead of importing it.
  const module = { exports: {} }
  const source = readFileSync(path.resolve(here, '..', 'client', 'panel-page.js'), 'utf8')
  vm.runInNewContext(source, { module, exports: module.exports, document: undefined }, { filename: 'panel-page.js' })
  const createPanelPage = module.exports
  const toggleWithDescendants = module.exports.toggleWithDescendants
  assert.equal(typeof createPanelPage, 'function')
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

test('buildWorkspaceGroups groups by workspace, names from cwd and nests subagents', () => {
  const { buildWorkspaceGroups, collectSessions } = loadPanelPageModule()

  const PARENT = 'session-parent'
  const CHILD_A = 'child-a'
  const CHILD_B = 'child-b'
  const ORPHAN = 'orphan'
  const sessions = [
    { id: PARENT, workspaceKey: '--ws-a--', cwd: 'F:\\alpha', bytes: 100, createdAt: 3000, title: 'P' },
    { id: CHILD_A, workspaceKey: '--ws-a--', cwd: 'F:\\alpha', bytes: 50, createdAt: 4000, parent: PARENT },
    { id: CHILD_B, workspaceKey: '--ws-a--', cwd: 'F:\\alpha', bytes: 10, createdAt: 3500, parent: PARENT },
    // The parent is gone from the list: the subagent must root its own tree
    // instead of vanishing.
    { id: ORPHAN, workspaceKey: '--ws-a--', cwd: 'F:\\alpha', bytes: 5, parent: 'gone' },
    { id: 'other', workspaceKey: '--ws-b--', bytes: 500, createdAt: 2000 },
  ]

  const groups = buildWorkspaceGroups(sessions)
  assert.equal(groups.length, 2)
  // Groups sort by total bytes: ws-b (500) outranks ws-a (165).
  assert.equal(groups[0].key, '--ws-b--')
  assert.equal(groups[0].name, '--ws-b--', 'no cwd anywhere: the raw key is the name')
  assert.equal(groups[0].path, undefined)
  assert.equal(groups[1].key, '--ws-a--')
  assert.equal(groups[1].name, 'alpha')
  assert.equal(groups[1].path, 'F:\\alpha')
  assert.equal(groups[1].count, 4)
  assert.equal(groups[1].childCount, 3)

  const [parent, orphan] = groups[1].roots
  assert.equal(parent.session.id, PARENT)
  assert.equal(parent.orphan, false)
  // Subagents sort oldest first (spawn order); roots newest first. The arrays
  // come from the vm realm, so they are spread into host arrays first —
  // cross-realm prototypes never compare strictly equal.
  assert.deepEqual([...parent.children.map((node) => node.session.id)], [CHILD_B, CHILD_A])
  assert.equal(orphan.session.id, ORPHAN)
  assert.equal(orphan.orphan, true)

  // Flattening walks parents before children.
  assert.deepEqual([...collectSessions(groups[1].roots).map((session) => session.id)], [PARENT, CHILD_B, CHILD_A, ORPHAN])
})

test('setSelection drives bulk affordances through the row cascade', () => {
  const { setSelection } = loadPanelPageModule()
  const sessions = [
    { id: 'root' },
    { id: 'child', parent: 'root' },
    { id: 'other' },
  ]

  // Select-all carries the hidden descendant along.
  const selected = setSelection(sessions, new Set(), ['root', 'other'], true)
  assert.deepEqual([...selected].sort(), ['child', 'other', 'root'])

  // Deselecting the group removes exactly its closure.
  const deselected = setSelection(sessions, selected, ['root', 'child'], false)
  assert.deepEqual([...deselected], ['other'])
})

test('collectDescendants walks the parent links breadth-first', () => {
  const { collectDescendants } = loadPanelPageModule()
  const sessions = [
    { id: 'root' },
    { id: 'a', parent: 'root' },
    { id: 'b', parent: 'root' },
    { id: 'grand', parent: 'a' },
    { id: 'other' },
  ]
  // The vm realm's arrays are spread into host arrays before comparing.
  assert.deepEqual([...collectDescendants(sessions, 'root').map((session) => session.id)], ['a', 'b', 'grand'])
  assert.deepEqual([...collectDescendants(sessions, 'other')], [])
})

test('the cleanup page groups workspaces, nests subagents and reveals ids in the preview', async () => {
  const { React, render } = statefulReactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require: ${id}`)
  })

  const PARENT = 'session-aaaaaaaa-1111-2222-3333-444444444444'
  const CHILD = 'bbbbbbbb-1111-2222-3333-444444444444'
  const OTHER = 'session-cccccccc-1111-2222-3333-444444444444'
  const readCalls = []
  const service = {
    list: async () => ({
      sessions: [
        { id: PARENT, workspaceKey: '--ws-a--', bytes: 10, humanBytes: '10 B', parent: undefined, cwd: 'F:\\alpha', title: 'Parent title', createdAt: 2000 },
        { id: CHILD, workspaceKey: '--ws-a--', bytes: 4, humanBytes: '4 B', parent: PARENT, cwd: 'F:\\alpha', title: 'Child title', createdAt: 3000 },
        { id: OTHER, workspaceKey: '--ws-b--', bytes: 100, humanBytes: '100 B', parent: undefined, cwd: 'G:\\beta', title: 'Other title', createdAt: 1000 },
      ],
    }),
    read: async (sessionId) => {
      readCalls.push(sessionId)
      return {
        ok: true, id: sessionId, workspaceKey: '--ws-a--', cwd: 'F:\\alpha',
        bytes: 10, humanBytes: '10 B', title: 'Parent title', createdAt: 2000,
        messages: [], totalMessages: 0, truncated: false,
      }
    },
  }
  let component
  plugin.apply({
    locale: { getLocale: () => ({ active: 'en' }) },
    remote: { $mount: async () => {} },
    inject(keys, callback) { callback({ 'remote.sessionCleaner': service }) },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) {
        if (options.name === 'main') component = value
      },
    },
  })

  render(component)
  await settle()
  const ready = render(component)

  // Collapsed by default: every group header shows, no session rows yet.
  const headers = collect(ready).filter((node) => node.props?.role === 'group')
  assert.equal(headers.length, 2)
  assert.equal(collect(ready).filter((node) => node.type === 'label').length, 0, 'groups start collapsed')
  // The header is titled with the cwd's last segment plus the full path.
  const alphaHeader = headers.find((node) => node.props['aria-label'] === 'alpha')
  assert.notEqual(alphaHeader, undefined)
  const headerSpans = collect(alphaHeader).filter((node) => node.type === 'span')
  assert.ok(headerSpans.some((span) => span.children[0] === 'alpha'))
  assert.ok(headerSpans.some((span) => span.children[0] === 'F:\\alpha'))

  // Expanding the group reveals the parent row, titled rather than id-ed.
  alphaHeader.props.onClick()
  const expanded = render(component)
  let labels = collect(expanded).filter((node) => node.type === 'label')
  assert.equal(labels.length, 1, 'the parent row shows; its subagent stays nested')
  assert.equal(labels[0].props.key, PARENT)
  const rowSpans = collect(labels[0]).filter((node) => node.type === 'span')
  assert.ok(rowSpans.some((span) => span.children[0] === 'Parent title'), 'the row is titled')
  assert.ok(rowSpans.every((span) => span.children[0] !== PARENT), 'the id is not the row label')

  // The group checkbox selects the whole group through the cascade — the
  // still-hidden subagent included, as the delete-button totals attest.
  collect(alphaHeader).find((node) => node.type === 'input').props.onChange()
  const totals = collect(render(component))
    .filter((node) => node.type === 'button')
    .map((node) => node.children.flat().join(''))
  assert.ok(totals.some((text) => text.includes('Delete 2 selected (14 B)')))

  // Expanding the parent row reveals the subagent, badged and selected.
  const parentExpander = collect(labels[0]).find((node) => node.type === 'button' && node.props['aria-label'] === 'Expand')
  assert.notEqual(parentExpander, undefined, 'the parent row carries a caret button')
  assert.deepEqual(parentExpander.children, ['▶'], 'the caret is the collapsed triangle glyph')
  parentExpander.props.onClick({ preventDefault() {}, stopPropagation() {} })
  const withChild = render(component)
  labels = collect(withChild).filter((node) => node.type === 'label')
  assert.equal(labels.length, 2)
  const childLabel = labels.find((node) => node.props.key === CHILD)
  assert.notEqual(childLabel, undefined)
  assert.ok(collect(childLabel).some((node) => node.type === 'span' && node.children[0] === 'subagent'))
  assert.equal(collect(childLabel).find((node) => node.type === 'input').props.checked, true)

  // The preview dialog shows the session id under the title, and the
  // subagent ids that would be deleted along with it, badged as subagents.
  const parentRow = labels.find((node) => node.props.key === PARENT)
  const previewButton = collect(parentRow).find((node) => node.type === 'button' && node.children.flat().includes('Preview'))
  await previewButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle()
  const withDialog = render(component)
  assert.equal(readCalls.length, 1)
  // The id line sits under the preview title: a label span plus the id text.
  const idLine = collect(withDialog).find((node) => node.props?.key === 'sessionid')
  assert.notEqual(idLine, undefined)
  assert.equal(idLine.children[0][1], PARENT)
  assert.equal(collect(idLine).find((node) => node.type === 'span').children[0], 'Session ID: ')
  assert.ok(collect(withDialog)
    .filter((node) => node.type === 'p')
    .some((node) => node.children.flat().join('').includes('Subagent sessions (1)')), 'the descendant block is announced')
  // Scope to a div: the list's subagent row is a label carrying the same key.
  const childRow = collect(withDialog).find((node) => node.type === 'div' && node.props?.key === CHILD)
  assert.notEqual(childRow, undefined)
  assert.ok(collect(childRow).some((node) => node.type === 'span' && node.children[0] === 'subagent'))
  assert.ok(collect(childRow).some((node) => node.type === 'span' && node.children[0] === CHILD))
})

test('a text filter auto-expands matching groups and keeps the tree shape', async () => {
  const { React, render } = statefulReactStub()
  const factory = loadFactory()
  const plugin = factory((id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return { createPortal: (node) => node }
    throw new Error(`unexpected require: ${id}`)
  })

  const PARENT = 'session-aaaaaaaa-1111-2222-3333-444444444444'
  const CHILD = 'bbbbbbbb-1111-2222-3333-444444444444'
  const service = {
    list: async () => ({
      sessions: [
        { id: PARENT, workspaceKey: '--ws-a--', bytes: 10, humanBytes: '10 B', parent: undefined, cwd: 'F:\\alpha', title: 'Parent title', createdAt: 2000 },
        { id: CHILD, workspaceKey: '--ws-a--', bytes: 4, humanBytes: '4 B', parent: PARENT, cwd: 'F:\\alpha', title: 'Child title', createdAt: 3000 },
        { id: 'session-cccccccc-1111-2222-3333-444444444444', workspaceKey: '--ws-b--', bytes: 100, humanBytes: '100 B', parent: undefined, cwd: 'G:\\beta', title: 'Other title', createdAt: 1000 },
      ],
    }),
    read: async () => ({}),
  }
  let component
  plugin.apply({
    locale: { getLocale: () => ({ active: 'en' }) },
    remote: { $mount: async () => {} },
    inject(keys, callback) { callback({ 'remote.sessionCleaner': service }) },
    slots: {
      inject(_name, callback) { callback() },
      register(options, value) {
        if (options.name === 'main') component = value
      },
    },
  })

  render(component)
  await settle()
  const ready = render(component)
  const search = collect(ready).find((node) => node.type === 'input' && node.props.type === 'search')

  // Matching only the subagent keeps its parent row for the tree shape, and
  // the matched group opens without a click.
  search.props.onChange({ target: { value: 'child title' } })
  const filtered = render(component)
  const labels = collect(filtered).filter((node) => node.type === 'label')
  assert.deepEqual(labels.map((label) => label.props.key).sort(), [CHILD, PARENT].sort())
  assert.equal(collect(filtered).some((node) => node.props?.['aria-label'] === 'beta'), false, 'the unmatched group is gone')

  // Matching the workspace path keeps the whole group.
  search.props.onChange({ target: { value: 'G:\\beta' } })
  const byPath = render(component)
  assert.equal(collect(byPath).filter((node) => node.type === 'label').length, 1)

  // No match anywhere: the empty hint replaces the list.
  search.props.onChange({ target: { value: 'zzz' } })
  const none = render(component)
  assert.equal(collect(none).filter((node) => node.type === 'label').length, 0)
  const paragraphs = collect(none).filter((node) => node.type === 'p').map((node) => node.children.flat().join(''))
  assert.ok(paragraphs.some((text) => text.includes('No session matches')))
})

test('renderMessages lays out both sides of a transcript', () => {
  // The source file is CommonJS living under a "type": "module" package, so
  // evaluate it in a vm context instead of importing it.
  const module = { exports: {} }
  const source = readFileSync(path.resolve(here, '..', 'client', 'panel-page.js'), 'utf8')
  vm.runInNewContext(source, { module, exports: module.exports, document: undefined }, { filename: 'panel-page.js' })
  const renderMessages = module.exports.renderMessages
  assert.equal(typeof renderMessages, 'function')

  const { React } = reactStub()
  const rows = renderMessages(React, (key) => key, [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi', time: 1790000002000, model: 'deepseek-flash' },
  ])
  assert.equal(rows.length, 2)

  // The stub preserves a single array child argument as a nested array.
  const [userHead, userText] = rows[0].children[0]
  const [userBadge, userMeta] = userHead.children[0]
  assert.equal(userBadge.children[0], 'preview.user')
  assert.equal(userMeta, null, 'no time and no model: no meta span')
  assert.equal(userText.children[0], 'hello')

  const [assistantHead, assistantText] = rows[1].children[0]
  const [assistantBadge, assistantMeta] = assistantHead.children[0]
  assert.equal(assistantBadge.children[0], 'preview.assistant')
  assert.match(String(assistantMeta.children[0]), /deepseek-flash/, 'the model rides the meta span')
  assert.equal(assistantText.children[0], 'hi')
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
