/**
 * session-cleaner Web client half.
 *
 * Adds a "delete session" row to the sidebar Session menu — the one place a
 * user already looks for per-session actions — and confirms before deleting.
 *
 * The Host half owns deletion; this file only presents it. DSH's client module
 * system loads one self-contained bundle and hands it a `require`, so React and
 * react-dom come from the platform module table rather than from package
 * resolution.
 */

const { TYPERT_REMOTE } = require('../src/contract.cjs')
const createSettingsTab = require('./settings-tab.js')

const MESSAGES = Object.freeze({
  en: Object.freeze({
    'menu.delete': 'Delete session',
    'dialog.title': 'Delete this session permanently?',
    'dialog.body': 'The session log, its projection cache and its workspace entry will be removed. Descendant subagent sessions are removed too.',
    'dialog.warning': 'This cannot be undone. DSH keeps no recycle bin and no backup.',
    'dialog.bytes': 'Will free {size}.',
    'dialog.more': '{count} sessions on disk (including descendant subagent sessions).',
    'dialog.loading': 'Checking what would be removed…',
    'dialog.confirm': 'Delete permanently',
    'dialog.cancel': 'Cancel',
    'dialog.close': 'Close',
    'dialog.deleting': 'Deleting…',
    'dialog.failed': 'Deletion failed: {reason}',
    'service.missing': 'The session-cleaner service did not become reachable. Retry the click; if it persists, reload the page.',
    'service.mountFailed': 'Remote mount failed: {reason}',
    'panel.title': 'Session cleanup',
    'panel.hint': 'Every session found on disk. Selecting a session also selects its descendant subagent sessions — they are deleted together; a session running in this app cannot be removed and will be refused.',
    'panel.loading': 'Scanning sessions…',
    'panel.retry': 'Retry',
    'panel.search': 'Filter by id, workspace or path',
    'panel.selectAll': 'Select all shown',
    'panel.clear': 'Clear selection',
    'panel.delete': 'Delete {count} selected ({size})',
    'panel.deleting': 'Deleting…',
    'panel.deleted': 'Deleted {count} session(s), freed {size}.',
    'panel.failed': 'Deletion failed: {reason}',
    'panel.empty': 'No session matches the filter.',
    'panel.child': 'subagent',
    'panel.root': 'Data root: {path}',
    'panel.serviceMissing': 'The session-cleaner service is unavailable. Check the network panel and reload the page.',
  }),
  zh: Object.freeze({
    'menu.delete': '删除会话',
    'dialog.title': '永久删除这个会话？',
    'dialog.body': '会话日志、投影缓存与工作区中的记录都会被移除；由它派生的子代理会话也会一并删除。',
    'dialog.warning': '此操作不可撤销。DSH 没有回收站，也没有备份。',
    'dialog.bytes': '将释放 {size}。',
    'dialog.more': '磁盘上共 {count} 个会话（含派生的子代理会话）。',
    'dialog.loading': '正在统计将要删除的内容…',
    'dialog.confirm': '永久删除',
    'dialog.cancel': '取消',
    'dialog.close': '关闭',
    'dialog.deleting': '正在删除…',
    'dialog.failed': '删除失败：{reason}',
    'service.missing': '会话清理服务未能在 5 秒内就绪。请再点一次「删除会话」；若反复出现，请重新加载页面。',
    'service.mountFailed': 'Remote 契约挂载失败：{reason}',
    'panel.title': '会话清理',
    'panel.hint': '磁盘上的全部会话。勾选主会话会自动带上其派生的子代理会话（它们会被一并删除）；本应用中正在运行的会话无法删除，会被拒绝。',
    'panel.loading': '正在扫描会话…',
    'panel.retry': '重试',
    'panel.search': '按 id、工作区或路径筛选',
    'panel.selectAll': '全选当前列表',
    'panel.clear': '清空选择',
    'panel.delete': '删除选中的 {count} 个（{size}）',
    'panel.deleting': '正在删除…',
    'panel.deleted': '已删除 {count} 个会话，释放 {size}。',
    'panel.failed': '删除失败：{reason}',
    'panel.empty': '没有符合条件的会话。',
    'panel.child': '子代理',
    'panel.root': '数据根目录：{path}',
    'panel.serviceMissing': '会话清理服务不可用。请检查连接后重新加载页面。',
  }),
})

/** Pick a locale from the DSH locale service, falling back to English. */
function detectLocale(ctx) {
  try {
    // The LocaleRuntime snapshot carries the active locale as `active`, which is
    // either the lowercase id itself or a locale record holding it under `id`.
    const snapshot = ctx.locale?.getLocale?.() ?? ctx.locale?.getSnapshot?.()
    const active = snapshot?.active
    const id = typeof active === 'string' ? active : active?.id ?? ''
    return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/** Read a service result defensively: RPC may settle unwrapped or wrapped. */
function unwrap(result) {
  if (result !== null && typeof result === 'object' && 'ok' in result && 'value' in result) {
    return result.ok ? result.value : { ok: false, error: result.error?.message ?? 'remote call failed' }
  }
  return result
}

/**
 * A menu row cannot own the dialog it opens. Choosing the row closes the menu,
 * and the row unmounts in that very commit — so a dialog rendered inside it is
 * dropped before it can paint, and the click looks like it did nothing at all.
 *
 * The row therefore publishes a request here and returns; a frame-wide
 * `shell.overlay` entry, which outlives every menu, renders the dialog. The
 * shipped rename and archive dialogs use the same split.
 */
function createConfirmStore() {
  let state = { request: undefined }
  const listeners = new Set()
  const publish = (next) => {
    state = next
    for (const listener of [...listeners]) listener()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    get() {
      return state
    },
    request(sessionId, displayTitle) {
      publish({ request: { sessionId, displayTitle } })
    },
    dismiss() {
      publish({ request: undefined })
    },
  }
}

module.exports = function createPlugin(require) {
  const React = require('react')

  // Implicit baseline external of the module-loader lane: resolved through the
  // frozen platform module table like React, never bundled (see the
  // ui-workspace README's "动态客户端包" note). Absent only on stand-alone
  // stubs, where the plain-button fallback below keeps the row working.
  let MenuItemButton
  let IconTrashOutlineRegular
  let Modal
  let Button
  try {
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    MenuItemButton = primitives.MenuItemButton
    IconTrashOutlineRegular = primitives.IconTrashOutlineRegular
    Modal = primitives.Modal
    Button = primitives.Button
  } catch { /* optional in this composition */ }

  /** One live dialog per activation; the overlay entry reads it. */
  const confirmStore = createConfirmStore()

  /** Subscribe a component to the pending confirm request. */
  function useConfirmRequest() {
    const [state, setState] = React.useState(confirmStore.get)
    React.useEffect(() => confirmStore.subscribe(() => setState(confirmStore.get())), [])
    return state.request
  }

  return {
    name: 'sessionCleanerClient',
    // The shell publishes `slots` only once its layout has mounted, and the
    // Remote face is a Cordis service the same way. Reading an undeclared
    // service on a Cordis context THROWS ("cannot get property "remote"
    // without inject"): acquire() used to swallow that rejection, resolve to
    // undefined forever, and leave the dialog stuck on "checking…". `typert`
    // is required in turn because $mount() registers the contribution through
    // the CALLER's context (`callerCtx.typert.remotes.register`).
    inject: ['slots', 'locale', 'remote', 'typert'],
    apply(ctx) {
      const t = (key, vars) => {
        const table = MESSAGES[detectLocale(ctx)] ?? MESSAGES.en
        const template = table[key] ?? MESSAGES.en[key] ?? key
        if (vars === undefined) return template
        return template.replace(/\{(\w+)\}/g, (_match, name) => String(vars[name] ?? ''))
      }

      let mountPromise
      let servicePromise
      /** Human-readable reason from the most recent acquire failure, if any. */
      let acquireFailure

      const readFailure = () => acquireFailure

      /**
       * Mount the contract once, then resolve the Host namespace.
       *
       * Two independently cached steps, because they fail differently:
       *
       * - `$mount` registers the contribution under the package name in the
       *   Typert Remote store, which REJECTS a second registration ("Remote
       *   package … is already registered"). It must run at most once and its
       *   success is cached forever; only a failed mount may be retried.
       * - The namespace itself is a Cordis service provided under the property
       *   name `remote.<namespace>` (the gateway composes the key with
       *   `remoteServiceKey()` and the Service base class registers the
       *   instance via `ctx.provide(name, this)`). It is therefore read as
       *   `scope['remote.sessionCleaner']` — NOT as `scope.remote.sessionCleaner`,
       *   which would be a property lookup on the mount manager and always
       *   `undefined`. A click can land before the namespace fiber has
       *   published, so the inject waits inside a settle window; a window that
       *   lapses may be re-entered by the next click (the mount stays cached).
       */
      const mount = async () => {
        try {
          // Reading `ctx.remote` without the service in `inject` throws; the
          // try keeps a mis-declared inject visible as a reported reason
          // instead of an uncaught rejection out of the dialog effect.
          const remote = ctx.remote
          if (remote === undefined || typeof remote.$mount !== 'function') {
            acquireFailure = 'ctx.remote is not available in this composition'
            return false
          }
          await remote.$mount(TYPERT_REMOTE)
          acquireFailure = undefined
          return true
        } catch (reason) {
          acquireFailure = String(reason?.message ?? reason)
          return false
        }
      }

      const acquire = async () => {
        if (mountPromise === undefined) mountPromise = mount()
        const mounted = await mountPromise
        if (!mounted) {
          // The mount itself failed (or no remote yet): a later click retries it.
          mountPromise = undefined
          return undefined
        }
        if (servicePromise === undefined) {
          servicePromise = new Promise((resolve) => {
            let settled = false
            const timer = setTimeout(() => {
              if (settled) return
              settled = true
              resolve(undefined)
            }, 5000)
            try {
              ctx.inject(['remote.sessionCleaner'], (scope) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve(scope['remote.sessionCleaner'])
              })
            } catch (reason) {
              settled = true
              clearTimeout(timer)
              acquireFailure = String(reason?.message ?? reason)
              resolve(undefined)
            }
          })
        }
        const service = await servicePromise
        if (service === undefined) {
          if (acquireFailure === undefined) {
            acquireFailure = 'the remote.sessionCleaner namespace did not publish within the settle window'
          }
          servicePromise = undefined
          return undefined
        }
        acquireFailure = undefined
        return service
      }

      /**
       * The sidebar menu row. It only closes the menu and publishes the request:
       * it must not hold dialog state, because it unmounts as the menu closes.
       */
      function DeleteSessionRow(props) {
        const { sessionId, displayTitle } = props
        // Slot-level hook: it returns the menu's [open, setOpen] pair, so the
        // setter has to be destructured. Calling the pair itself threw a
        // TypeError before the request below ever ran — which is why the row
        // appeared but did nothing when clicked.
        const menuOpenState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : undefined
        const setMenuOpen = Array.isArray(menuOpenState) && typeof menuOpenState[1] === 'function'
          ? menuOpenState[1]
          : () => {}

        const onSelect = () => {
          setMenuOpen(false)
          confirmStore.request(sessionId, displayTitle)
        }

        // The shipped rows render through the platform's MenuItemButton: same
        // typography, spacing, hover and keyboard walk as pin/rename/fork/
        // archive, with the leading icon slot every shipped row uses. The
        // default 16px Regular stroke matches the pin/rename/fork icons.
        if (MenuItemButton !== undefined && IconTrashOutlineRegular !== undefined) {
          return React.createElement(MenuItemButton, {
            icon: React.createElement(IconTrashOutlineRegular),
            onSelect,
          }, t('menu.delete'))
        }

        return React.createElement('button', {
          type: 'button',
          role: 'menuitem',
          style: menuItemStyle,
          onClick: onSelect,
        }, t('menu.delete'))
      }

      /**
       * The confirmation dialog, mounted once into `shell.overlay`. Rendering
       * nothing while no request is pending keeps the overlay list inert.
       */
      function ConfirmDialog() {
        const request = useConfirmRequest()
        const sessionId = request?.sessionId
        const displayTitle = request?.displayTitle
        const [preview, setPreview] = React.useState(undefined)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(undefined)

        React.useEffect(() => {
          if (sessionId === undefined) return undefined
          let cancelled = false
          setPreview(undefined)
          setError(undefined)
          setBusy(false)
          void (async () => {
            const service = await acquire()
            if (cancelled) return
            if (service === undefined) {
              const reason = readFailure()
              setError(reason === undefined ? t('service.missing') : t('service.mountFailed', { reason }))
              return
            }
            try {
              const value = unwrap(await service.preview([sessionId]))
              if (!cancelled) setPreview(value)
            } catch (reason) {
              if (!cancelled) setError(String(reason?.message ?? reason))
            }
          })()
          return () => { cancelled = true }
        }, [sessionId])

        // A frame-wide list entry is always mounted: returning a hidden node
        // rather than null keeps the idle state from reading as "no entry".
        if (request === undefined) return React.createElement('span', { hidden: true })

        const confirm = async () => {
          const service = await acquire()
          if (service === undefined) {
            const reason = readFailure()
            setError(reason === undefined ? t('service.missing') : t('service.mountFailed', { reason }))
            return
          }
          setBusy(true)
          setError(undefined)
          try {
            const result = unwrap(await service.delete([sessionId], {}))
            if (result?.ok === false) {
              setError(result.error ?? 'unknown failure')
              return
            }
            confirmStore.dismiss()
          } catch (reason) {
            setError(String(reason?.message ?? reason))
          } finally {
            setBusy(false)
          }
        }

        const body = []
        body.push(React.createElement('p', { key: 'body', style: bodyStyle }, t('dialog.body')))
        body.push(React.createElement('p', { key: 'warn', style: warnStyle }, t('dialog.warning')))
        // While an error is shown the loading line is dropped: "checking…"
        // next to a failure reads as if something were still in flight.
        if (preview === undefined && error === undefined) {
          body.push(React.createElement('p', { key: 'size', style: metaStyle }, t('dialog.loading')))
        } else if (preview !== undefined) {
          body.push(React.createElement('p', { key: 'size', style: metaStyle }, t('dialog.bytes', { size: preview.humanBytes })))
          if (preview.targetCount > 1) {
            body.push(React.createElement('p', { key: 'more', style: metaStyle }, t('dialog.more', { count: preview.targetCount })))
          }
        }
        if (error !== undefined) {
          body.push(React.createElement('p', { key: 'error', style: errorStyle }, t('dialog.failed', { reason: error })))
        }

        // The shipped rename / stop-and-archive / risk dialogs all render
        // through the platform Modal + Button pair (the same implicit baseline
        // external as the menu row): backdrop blur, card, header with a close
        // affordance, footer actions and control metrics then match the host
        // dialogs exactly. The action pairing follows RiskConfirmation:
        // outline for cancel, primary for the confirm action.
        if (Modal !== undefined && Button !== undefined) {
          return React.createElement(Modal, {
            open: true,
            onClose: () => { if (!busy) confirmStore.dismiss() },
            title: t('dialog.title'),
            closeLabel: t('dialog.close'),
            description: displayTitle || sessionId,
            footer: React.createElement(React.Fragment, null,
              React.createElement(Button, {
                key: 'cancel',
                variant: 'outline',
                disabled: busy,
                onClick: () => confirmStore.dismiss(),
              }, t('dialog.cancel')),
              React.createElement(Button, {
                key: 'confirm',
                variant: 'primary',
                disabled: busy || preview === undefined,
                onClick: confirm,
              }, busy ? t('dialog.deleting') : t('dialog.confirm'))),
          }, body)
        }

        // Stand-alone fallback (no primitives lane): the hand-rolled card.
        const rows = []
        rows.push(React.createElement('h2', { key: 'title', style: titleStyle }, t('dialog.title')))
        rows.push(React.createElement('p', { key: 'subject', style: subjectStyle }, displayTitle || sessionId))
        rows.push(...body)
        rows.push(React.createElement('div', { key: 'actions', style: actionsStyle }, [
          React.createElement('button', {
            key: 'cancel',
            type: 'button',
            disabled: busy,
            onClick: () => confirmStore.dismiss(),
            style: buttonStyle,
          }, t('dialog.cancel')),
          React.createElement('button', {
            key: 'confirm',
            type: 'button',
            disabled: busy || preview === undefined,
            onClick: confirm,
            style: dangerButtonStyle,
          }, busy ? t('dialog.deleting') : t('dialog.confirm')),
        ]))

        return React.createElement('div', {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('dialog.title'),
          style: overlayStyle,
          onClick: (event) => { if (event.target === event.currentTarget && !busy) confirmStore.dismiss() },
        }, React.createElement('div', { style: panelStyle }, rows))
      }

      try {
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-cleaner.delete',
          order: 500,
        }, DeleteSessionRow))
      } catch { /* the slot is optional: the Host half stays usable without it */ }

      try {
        // Frame-wide, so the dialog survives the menu that opened it.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-cleaner.confirm',
          order: 90,
        }, ConfirmDialog))
      } catch { /* no overlay host in this composition: deletion stays available through the settings tab */ }

      try {
        // A `label` thunk is re-read on every projection, so the tab text
        // follows a live locale change without re-registering.
        const panel = createSettingsTab(React, t, acquire, readFailure)
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'session-cleaner',
          order: 200,
          label: () => t('panel.title'),
        }, panel))
      } catch { /* the settings section may not be mounted in this build */ }
    },
  }
}

const overlayStyle = Object.freeze({
  position: 'fixed', inset: '0', zIndex: 1000, display: 'flex',
  alignItems: 'center', justifyContent: 'center',
  // An overlay host usually disables hit-testing on its container so it cannot
  // block the app beneath it; the dialog has to opt back in.
  pointerEvents: 'auto',
  background: 'light-dark(rgba(15,17,21,.32), rgba(0,0,0,.5))',
})
const panelStyle = Object.freeze({
  minWidth: '320px', maxWidth: '440px', padding: '20px', borderRadius: '16px',
  background: 'var(--dsw-alias-bg-module-platform, light-dark(#ffffff, #353638))',
  color: 'var(--dsw-alias-label-primary, light-dark(#0f1115, #f9fafb))',
  boxShadow: '0 8px 32px rgba(0,0,0,.24)', font: 'inherit',
})
const titleStyle = Object.freeze({ margin: '0 0 8px', fontSize: '15px', fontWeight: 600 })
const subjectStyle = Object.freeze({ margin: '0 0 12px', fontSize: '13px', opacity: 0.75, wordBreak: 'break-all' })
const bodyStyle = Object.freeze({ margin: '0 0 8px', fontSize: '13px', lineHeight: '20px' })
const warnStyle = Object.freeze({ margin: '0 0 8px', fontSize: '13px', lineHeight: '20px', color: 'light-dark(#b42318, #ff9c94)' })
const metaStyle = Object.freeze({ margin: '0 0 8px', fontSize: '12px', opacity: 0.7 })
const errorStyle = Object.freeze({ margin: '0 0 8px', fontSize: '12px', color: 'light-dark(#b42318, #ff9c94)', wordBreak: 'break-word' })
const actionsStyle = Object.freeze({ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' })
const buttonStyle = Object.freeze({
  padding: '6px 14px', borderRadius: '8px', cursor: 'pointer', font: 'inherit',
  border: '1px solid var(--dsw-alias-border-l3, light-dark(rgba(0,0,0,.12), rgba(255,255,255,.16)))',
  background: 'transparent', color: 'inherit',
})
const dangerButtonStyle = Object.freeze({
  ...buttonStyle, border: 'none', background: 'light-dark(#d92d20, #f04438)', color: '#ffffff',
})
const menuItemStyle = Object.freeze({
  display: 'block', width: '100%', padding: '6px 12px', textAlign: 'left',
  border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit',
})
