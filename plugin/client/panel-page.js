/**
 * The global Session-cleanup page: list every session, filter, multi-select,
 * delete — and preview a conversation before deleting it (a Preview button on
 * each row, or a double-click anywhere on the row).
 *
 * Registered as a top-level main panel (the `main` keyed slot) with its own
 * sidebar entry, next to Plugins and Automation Tasks. The session menu row
 * calls the same Host service, so the page adds reach without a second
 * deletion path.
 *
 * The page chrome follows the shipped global pages (ui-schedule, ui-plugin-
 * manager): a full-height scroll area whose content is centered at 960px with
 * a page heading; on macOS the heading also yields to the traffic-light
 * clearance the layout publishes as `--dsh-frame-top-clearance`.
 */

/** Format a byte count for compact display. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Read a service result defensively: RPC may settle unwrapped or wrapped. */
function unwrap(result) {
  if (result !== null && typeof result === 'object' && 'ok' in result && 'value' in result) {
    return result.ok ? result.value : { ok: false, error: result.error?.message ?? 'remote call failed' }
  }
  return result
}

/**
 * One checkbox flip in the panel, kept aligned with the deletion closure:
 * the Host deletes a session's descendants together with it, so the checked
 * set (and the "N sessions (X)" totals built from it) must match that
 * closure exactly.
 *
 * - Selecting a session selects its whole descendant subtree.
 * - Deselecting one drops its subtree AND every selected ancestor: a checked
 *   ancestor would drag the subtree back into the delete set on the Host
 *   side, and the panel totals would understate what actually gets removed.
 *
 * Children link upward through `parent`; the subtree is walked breadth-first
 * so grandchildren join even when their parent is missing from the list.
 */
function toggleWithDescendants(sessions, selected, id) {
  const childrenOf = new Map()
  const parentOf = new Map()
  for (const session of sessions) {
    if (session.parent !== undefined) {
      parentOf.set(session.id, session.parent)
      const list = childrenOf.get(session.parent)
      if (list === undefined) childrenOf.set(session.parent, [session.id])
      else list.push(session.id)
    }
  }

  const next = new Set(selected)
  if (!next.has(id)) {
    next.add(id)
    const queue = [id]
    while (queue.length > 0) {
      for (const child of childrenOf.get(queue.shift()) ?? []) {
        next.add(child)
        queue.push(child)
      }
    }
  } else {
    next.delete(id)
    const queue = [id]
    while (queue.length > 0) {
      for (const child of childrenOf.get(queue.shift()) ?? []) {
        next.delete(child)
        queue.push(child)
      }
    }
    // Un-check every ancestor still selected: keeping one would re-include
    // this subtree in its deletion closure.
    let ancestor = parentOf.get(id)
    while (ancestor !== undefined && next.has(ancestor)) {
      next.delete(ancestor)
      ancestor = parentOf.get(ancestor)
    }
  }
  return next
}

// The shipped global pages pad their heading for the macOS traffic lights
// only ([data-platform='darwin']); on Windows the titlebar already sits above
// the content area, so the clearance must not be added twice.
const isDarwin = typeof document === 'object' && document !== null
  && document.documentElement?.getAttribute?.('data-platform') === 'darwin'

/** Locale date-time for a message stamp; '' when the value is not a date. */
function formatTime(time) {
  try {
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString()
  } catch {
    return ''
  }
}

/** Render transcript messages as read-only rows (badge, stamp, text). */
function renderMessages(React, t, messages) {
  return messages.map((message, index) => {
    const meta = []
    if (typeof message.time === 'number') {
      const stamp = formatTime(message.time)
      if (stamp !== '') meta.push(stamp)
    }
    if (typeof message.model === 'string') meta.push(message.model)
    return React.createElement('div', { key: index, style: messageStyle }, [
      React.createElement('div', { key: 'head', style: messageHeadStyle }, [
        React.createElement('span', {
          key: 'role',
          style: message.role === 'assistant' ? assistantBadgeStyle : userBadgeStyle,
        }, t(message.role === 'assistant' ? 'preview.assistant' : 'preview.user')),
        meta.length === 0 ? null : React.createElement('span', { key: 'meta', style: messageMetaStyle }, meta.join(' · ')),
      ]),
      React.createElement('div', { key: 'text', style: messageTextStyle }, message.text),
    ])
  })
}

module.exports = function createPanelPage(React, t, acquire, readFailure, primitives) {
  const { useState, useEffect, useMemo, useRef } = React
  const Modal = primitives?.Modal
  const Button = primitives?.Button

  return function SessionCleanerPage() {
    const [state, setState] = useState({ phase: 'loading' })
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState(() => new Set())
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState(undefined)
    // The pending conversation preview: { phase: 'loading'|'ready'|'error',
    // sessionId, data?, error? } — undefined while no dialog is open.
    const [preview, setPreview] = useState(undefined)
    const previewSeq = useRef(0)

    const load = async () => {
      setState({ phase: 'loading' })
      setNotice(undefined)
      const service = await acquire()
      if (service === undefined) {
        const reason = readFailure?.()
        setState({ phase: 'error', error: reason === undefined ? t('panel.serviceMissing') : t('service.mountFailed', { reason }) })
        return
      }
      try {
        const data = unwrap(await service.list())
        setState({ phase: 'ready', sessions: data?.sessions ?? [], dshHome: data?.dshHome })
        setSelected(new Set())
      } catch (reason) {
        setState({ phase: 'error', error: String(reason?.message ?? reason) })
      }
    }

    useEffect(() => { load() }, [])

    const sessions = state.phase === 'ready' ? state.sessions : []
    const visible = useMemo(() => {
      const needle = query.trim().toLowerCase()
      if (needle === '') return sessions
      return sessions.filter((session) =>
        session.id.toLowerCase().includes(needle)
        || session.workspaceKey.toLowerCase().includes(needle)
        || (session.cwd ?? '').toLowerCase().includes(needle))
    }, [sessions, query])

    const allVisibleSelected = visible.length > 0 && visible.every((session) => selected.has(session.id))
    const selectedSessions = sessions.filter((session) => selected.has(session.id))
    const selectedBytes = selectedSessions.reduce((sum, session) => sum + session.bytes, 0)

    const toggle = (id) => {
      setSelected(toggleWithDescendants(sessions, selected, id))
    }
    const toggleAll = () => {
      if (allVisibleSelected) {
        setSelected(new Set())
        return
      }
      // Select-each-visible carries each one's descendants in, including
      // descendants a text filter currently hides from the list.
      let next = new Set(selected)
      for (const session of visible) next = toggleWithDescendants(sessions, next, session.id)
      setSelected(next)
    }

    const remove = async () => {
      const ids = [...selected]
      if (ids.length === 0) return
      setBusy(true)
      setNotice(undefined)
      const service = await acquire()
      if (service === undefined) {
        setBusy(false)
        const reason = readFailure?.()
        setNotice({ kind: 'error', text: reason === undefined ? t('panel.serviceMissing') : t('service.mountFailed', { reason }) })
        return
      }
      try {
        const result = unwrap(await service.delete(ids, {}))
        if (result?.ok === false) {
          setNotice({ kind: 'error', text: t('panel.failed', { reason: result.error ?? 'unknown' }) })
        } else {
          setNotice({
            kind: 'done',
            text: t('panel.deleted', {
              count: result?.summary?.sessionsDeleted ?? 0,
              size: formatBytes(result?.summary?.bytesDeleted ?? 0),
            }),
          })
        }
        await load()
      } catch (reason) {
        setNotice({ kind: 'error', text: t('panel.failed', { reason: String(reason?.message ?? reason) }) })
      } finally {
        setBusy(false)
      }
    }

    /**
     * Open the read-only transcript dialog for a session. Only the most
     * recent request may settle: a fast double-click on two different rows
     * would otherwise race, and the older read could overwrite the newer
     * dialog after it opened.
     */
    const openPreview = async (sessionId) => {
      const requestId = previewSeq.current + 1
      previewSeq.current = requestId
      setPreview({ phase: 'loading', sessionId })
      const service = await acquire()
      if (previewSeq.current !== requestId) return
      if (service === undefined) {
        const reason = readFailure?.()
        setPreview({ phase: 'error', sessionId, error: reason === undefined ? t('panel.serviceMissing') : t('service.mountFailed', { reason }) })
        return
      }
      try {
        const data = unwrap(await service.read(sessionId, {}))
        if (previewSeq.current !== requestId) return
        if (data?.ok === false) {
          setPreview({ phase: 'error', sessionId, error: t('preview.failed', { reason: data.error ?? 'unknown' }) })
        } else {
          setPreview({ phase: 'ready', sessionId, data })
        }
      } catch (reason) {
        if (previewSeq.current !== requestId) return
        setPreview({ phase: 'error', sessionId, error: t('preview.failed', { reason: String(reason?.message ?? reason) }) })
      }
    }

    const closePreview = () => {
      previewSeq.current += 1
      setPreview(undefined)
    }

    /**
     * The transcript dialog. The page is a long-lived `main` slot component,
     * so the dialog can live in its tree directly — unlike the session-menu
     * rows, whose dialogs must ride the frame-wide `shell.overlay` because
     * the row unmounts with its menu.
     */
    const renderPreview = () => {
      if (preview === undefined) return null
      const data = preview.phase === 'ready' ? preview.data : undefined

      const body = []
      if (data !== undefined) {
        const meta = [data.workspaceKey, data.humanBytes, data.cwd]
          .filter((part) => typeof part === 'string' && part !== '')
        if (meta.length > 0) {
          body.push(React.createElement('p', { key: 'meta', style: previewMetaStyle }, meta.join(' · ')))
        }
        if (data.truncated === true) {
          body.push(React.createElement('p', { key: 'truncated', style: hintStyle },
            t('preview.truncated', { shown: data.messages.length, total: data.totalMessages })))
        }
        body.push(React.createElement('div', { key: 'messages', style: messageListStyle },
          data.messages.length === 0
            ? React.createElement('p', { key: 'empty', style: hintStyle }, t('preview.empty'))
            : renderMessages(React, t, data.messages)))
      } else if (preview.phase === 'loading') {
        body.push(React.createElement('p', { key: 'loading', style: hintStyle }, t('preview.loading')))
      } else {
        body.push(React.createElement('p', { key: 'error', style: errorStyle }, preview.error))
      }

      if (Modal !== undefined && Button !== undefined) {
        return React.createElement(Modal, {
          open: true,
          onClose: closePreview,
          title: t('preview.title'),
          closeLabel: t('dialog.close'),
          description: data?.title || preview.sessionId,
          footer: React.createElement(Button, { variant: 'outline', onClick: closePreview }, t('dialog.close')),
        }, body)
      }

      // Stand-alone fallback (no primitives lane): the hand-rolled card.
      const rows = [
        React.createElement('h2', { key: 'title', style: previewHeadingStyle }, t('preview.title')),
        React.createElement('p', { key: 'subject', style: previewSubjectStyle }, data?.title || preview.sessionId),
        ...body,
        React.createElement('div', { key: 'actions', style: actionsStyle },
          React.createElement('button', { key: 'close', type: 'button', onClick: closePreview, style: buttonStyle }, t('dialog.close'))),
      ]
      return React.createElement('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('preview.title'),
        style: previewOverlayStyle,
        onClick: (event) => { if (event.target === event.currentTarget) closePreview() },
      }, React.createElement('div', { style: previewPanelStyle }, rows))
    }

    const body = []
    body.push(React.createElement('p', { key: 'hint', style: hintStyle }, t('panel.hint')))

    if (state.phase === 'loading') {
      body.push(React.createElement('p', { key: 'loading', style: hintStyle }, t('panel.loading')))
    } else if (state.phase === 'error') {
      body.push(React.createElement('p', { key: 'error', style: errorStyle }, state.error))
      body.push(React.createElement('button', {
        key: 'retry', type: 'button', onClick: load, style: buttonStyle,
      }, t('panel.retry')))
    } else {
      body.push(React.createElement('div', { key: 'toolbar', style: toolbarStyle }, [
        React.createElement('input', {
          key: 'query',
          type: 'search',
          value: query,
          placeholder: t('panel.search'),
          onChange: (event) => setQuery(event.target.value),
          style: inputStyle,
        }),
        React.createElement('button', {
          key: 'toggle', type: 'button', onClick: toggleAll, style: buttonStyle,
        }, allVisibleSelected ? t('panel.clear') : t('panel.selectAll')),
        React.createElement('button', {
          key: 'delete',
          type: 'button',
          disabled: busy || selected.size === 0,
          onClick: remove,
          style: selected.size === 0 ? disabledDangerStyle : dangerButtonStyle,
        }, busy
          ? t('panel.deleting')
          : t('panel.delete', { count: selected.size, size: formatBytes(selectedBytes) })),
      ]))

      if (notice !== undefined) {
        body.push(React.createElement('p', {
          key: 'notice',
          style: notice.kind === 'error' ? errorStyle : doneStyle,
        }, notice.text))
      }

      if (visible.length === 0) {
        body.push(React.createElement('p', { key: 'empty', style: hintStyle }, t('panel.empty')))
      } else {
        const rows = visible.map((session) => React.createElement('label', {
          key: session.id,
          style: rowStyle,
          // A double-click toggles the checkbox twice on the way in (net no
          // change) and then opens the preview.
          onDoubleClick: () => { void openPreview(session.id) },
        }, [
          React.createElement('input', {
            key: 'check',
            type: 'checkbox',
            checked: selected.has(session.id),
            onChange: () => toggle(session.id),
          }),
          React.createElement('span', { key: 'id', style: idStyle }, session.id),
          React.createElement('span', { key: 'ws', style: metaStyle }, session.workspaceKey),
          session.parent === undefined ? null : React.createElement('span', { key: 'child', style: childBadgeStyle }, t('panel.child')),
          React.createElement('span', { key: 'size', style: sizeStyle }, session.humanBytes),
          React.createElement('button', {
            key: 'preview',
            type: 'button',
            style: previewButtonStyle,
            // Inside the row label: without these the click would reach the
            // label's checkbox instead of the preview.
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              void openPreview(session.id)
            },
          }, t('panel.preview')),
        ]))
        body.push(React.createElement('div', { key: 'list', style: listStyle }, rows))
      }

      body.push(React.createElement('p', { key: 'root', style: hintStyle }, t('panel.root', { path: state.dshHome ?? '' })))
    }

    return React.createElement('section', { style: pageStyle, 'aria-label': t('panel.title') },
      React.createElement('div', { style: scrollStyle },
        React.createElement('div', { style: contentStyle }, [
          React.createElement('h1', { key: 'title', style: headingStyle }, t('panel.title')),
          ...body,
        ])),
      renderPreview())
  }
}

const pageStyle = Object.freeze({
  width: '100%', minWidth: 0, height: '100%', minHeight: 0,
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  background: 'var(--dsw-alias-bg-base, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: '14px', lineHeight: '1.6',
})
const scrollStyle = Object.freeze({ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable' })
const contentStyle = Object.freeze({
  maxWidth: '960px', margin: '0 auto',
  padding: '0 clamp(24px, 4vw, 48px) 48px',
  display: 'flex', flexDirection: 'column', gap: '10px',
})
const headingStyle = Object.freeze({
  margin: '0',
  fontSize: '20px', fontWeight: 500, lineHeight: '28px',
  paddingTop: isDarwin ? 'calc(28px + var(--dsh-frame-top-clearance, 0px))' : '28px',
})
const hintStyle = Object.freeze({ margin: '0', fontSize: '12px', opacity: 0.7, lineHeight: '18px' })
const errorStyle = Object.freeze({ margin: '0', fontSize: '12px', color: 'light-dark(#b42318, #ff9c94)', wordBreak: 'break-word' })
const doneStyle = Object.freeze({ margin: '0', fontSize: '12px', color: 'light-dark(#067647, #75e0a7)' })
const toolbarStyle = Object.freeze({ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' })
const inputStyle = Object.freeze({
  flex: '1 1 180px', minWidth: '140px', padding: '6px 10px', borderRadius: '8px', font: 'inherit',
  border: '1px solid var(--dsw-alias-border-l3, light-dark(rgba(0,0,0,.12), rgba(255,255,255,.16)))',
  background: 'transparent', color: 'inherit',
})
const buttonStyle = Object.freeze({
  padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap',
  border: '1px solid var(--dsw-alias-border-l3, light-dark(rgba(0,0,0,.12), rgba(255,255,255,.16)))',
  background: 'transparent', color: 'inherit',
})
const dangerButtonStyle = Object.freeze({
  ...buttonStyle, border: 'none', background: 'light-dark(#d92d20, #f04438)', color: '#ffffff',
})
const disabledDangerStyle = Object.freeze({
  ...dangerButtonStyle, opacity: 0.45, cursor: 'not-allowed',
})
const listStyle = Object.freeze({
  display: 'flex', flexDirection: 'column',
  border: '1px solid var(--dsw-alias-border-l2, light-dark(rgba(0,0,0,.08), rgba(255,255,255,.12)))',
  borderRadius: '10px',
})
const rowStyle = Object.freeze({
  display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 10px', cursor: 'pointer',
  userSelect: 'none',
  borderBottom: '1px solid var(--dsw-alias-border-l1, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)))',
})
const idStyle = Object.freeze({ flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
const metaStyle = Object.freeze({ fontSize: '11px', opacity: 0.6, whiteSpace: 'nowrap' })
const childBadgeStyle = Object.freeze({
  fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
  background: 'var(--dsw-alias-interactive-bg-hover, light-dark(rgba(38,49,72,.06), rgba(255,255,255,.08)))',
})
const sizeStyle = Object.freeze({ fontSize: '11px', opacity: 0.7, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' })
const previewButtonStyle = Object.freeze({
  flexShrink: 0, padding: '2px 10px', borderRadius: '6px', font: 'inherit', fontSize: '11px',
  whiteSpace: 'nowrap', cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l3, light-dark(rgba(0,0,0,.12), rgba(255,255,255,.16)))',
  background: 'transparent', color: 'inherit',
})
const previewOverlayStyle = Object.freeze({
  position: 'fixed', inset: '0', zIndex: 1000, display: 'flex',
  alignItems: 'center', justifyContent: 'center',
  // An overlay host usually disables hit-testing on its container so it cannot
  // block the app beneath it; the dialog has to opt back in.
  pointerEvents: 'auto',
  background: 'light-dark(rgba(15,17,21,.32), rgba(0,0,0,.5))',
})
const previewPanelStyle = Object.freeze({
  minWidth: '380px', maxWidth: '720px', maxHeight: '80vh', display: 'flex', flexDirection: 'column',
  padding: '20px', borderRadius: '16px',
  background: 'var(--dsw-alias-bg-module-platform, light-dark(#ffffff, #353638))',
  color: 'var(--dsw-alias-label-primary, light-dark(#0f1115, #f9fafb))',
  boxShadow: '0 8px 32px rgba(0,0,0,.24)', font: 'inherit',
})
const previewHeadingStyle = Object.freeze({ margin: '0 0 8px', fontSize: '15px', fontWeight: 600 })
const previewSubjectStyle = Object.freeze({ margin: '0 0 12px', fontSize: '13px', opacity: 0.75, wordBreak: 'break-all' })
const previewMetaStyle = Object.freeze({ margin: '0 0 8px', fontSize: '12px', opacity: 0.7, wordBreak: 'break-all' })
const messageListStyle = Object.freeze({
  display: 'flex', flexDirection: 'column', gap: '12px',
  maxHeight: '60vh', overflowY: 'auto', padding: '2px',
})
const messageStyle = Object.freeze({ display: 'flex', flexDirection: 'column', gap: '4px' })
const messageHeadStyle = Object.freeze({ display: 'flex', gap: '8px', alignItems: 'baseline' })
const messageMetaStyle = Object.freeze({ fontSize: '11px', opacity: 0.55, whiteSpace: 'nowrap' })
const userBadgeStyle = Object.freeze({
  fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
  background: 'light-dark(rgba(38,49,72,.08), rgba(255,255,255,.14))',
})
const assistantBadgeStyle = Object.freeze({
  fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
  background: 'light-dark(rgba(12,123,220,.14), rgba(56,132,255,.24))',
})
const messageTextStyle = Object.freeze({
  fontSize: '13px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
})
const actionsStyle = Object.freeze({ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '16px' })

// Attached after the main export so the factory assignment above cannot
// overwrite it; the bundle itself only ever uses the factory.
module.exports.toggleWithDescendants = toggleWithDescendants
module.exports.renderMessages = renderMessages
