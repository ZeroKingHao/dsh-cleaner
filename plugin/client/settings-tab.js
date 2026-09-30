/**
 * The Plugins-settings panel: list every session, filter, multi-select, delete.
 *
 * Registered into `settings.plugins.tab` alongside the session menu row. Both
 * call the same Host service, so the panel adds reach without a second
 * deletion path.
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

module.exports = function createSettingsTab(React, t, acquire, readFailure) {
  const { useState, useEffect, useMemo } = React

  return function SessionCleanerPanel() {
    const [state, setState] = useState({ phase: 'loading' })
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState(() => new Set())
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState(undefined)

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
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelected(next)
    }
    const toggleAll = () => {
      setSelected(allVisibleSelected ? new Set() : new Set(visible.map((session) => session.id)))
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

    const children = []
    children.push(React.createElement('h3', { key: 'title', style: headingStyle }, t('panel.title')))
    children.push(React.createElement('p', { key: 'hint', style: hintStyle }, t('panel.hint')))

    if (state.phase === 'loading') {
      children.push(React.createElement('p', { key: 'loading', style: hintStyle }, t('panel.loading')))
      return React.createElement('div', { style: rootStyle }, children)
    }
    if (state.phase === 'error') {
      children.push(React.createElement('p', { key: 'error', style: errorStyle }, state.error))
      children.push(React.createElement('button', {
        key: 'retry', type: 'button', onClick: load, style: buttonStyle,
      }, t('panel.retry')))
      return React.createElement('div', { style: rootStyle }, children)
    }

    children.push(React.createElement('div', { key: 'toolbar', style: toolbarStyle }, [
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
      children.push(React.createElement('p', {
        key: 'notice',
        style: notice.kind === 'error' ? errorStyle : doneStyle,
      }, notice.text))
    }

    if (visible.length === 0) {
      children.push(React.createElement('p', { key: 'empty', style: hintStyle }, t('panel.empty')))
    } else {
      const rows = visible.map((session) => React.createElement('label', {
        key: session.id,
        style: rowStyle,
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
      ]))
      children.push(React.createElement('div', { key: 'list', style: listStyle }, rows))
    }

    children.push(React.createElement('p', { key: 'root', style: hintStyle }, t('panel.root', { path: state.dshHome ?? '' })))
    return React.createElement('div', { style: rootStyle }, children)
  }
}

const rootStyle = Object.freeze({ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' })
const headingStyle = Object.freeze({ margin: '0', fontSize: '14px', fontWeight: 600 })
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
  display: 'flex', flexDirection: 'column', maxHeight: '320px', overflowY: 'auto',
  border: '1px solid var(--dsw-alias-border-l2, light-dark(rgba(0,0,0,.08), rgba(255,255,255,.12)))',
  borderRadius: '10px',
})
const rowStyle = Object.freeze({
  display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 10px', cursor: 'pointer',
  borderBottom: '1px solid var(--dsw-alias-border-l1, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)))',
})
const idStyle = Object.freeze({ flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
const metaStyle = Object.freeze({ fontSize: '11px', opacity: 0.6, whiteSpace: 'nowrap' })
const childBadgeStyle = Object.freeze({
  fontSize: '10px', padding: '1px 6px', borderRadius: '999px', whiteSpace: 'nowrap',
  background: 'var(--dsw-alias-interactive-bg-hover, light-dark(rgba(38,49,72,.06), rgba(255,255,255,.08)))',
})
const sizeStyle = Object.freeze({ fontSize: '11px', opacity: 0.7, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' })
