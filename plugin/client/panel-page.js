/**
 * The global Session-cleanup page: list every session grouped by workspace,
 * filter, multi-select, delete — and preview a conversation before deleting it
 * (a Preview button on each row, or a double-click anywhere on the row).
 *
 * Rows are titled (the id only appears inside the preview dialog, under the
 * title). Workspace groups collapse by default; subagent sessions nest under
 * their parent row, with an expand caret of their own, and orphaned subagents
 * (their parent is gone) root themselves so they stay visible.
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

/**
 * Drive a set of session ids toward a wanted checked state through the row
 * cascade, so bulk affordances ("select all" of the toolbar, of a workspace
 * group) keep the checked set aligned with the Host's deletion closure.
 */
function setSelection(sessions, selected, ids, wanted) {
  let next = new Set(selected)
  for (const id of ids) {
    if (next.has(id) !== wanted) next = toggleWithDescendants(sessions, next, id)
  }
  return next
}

/** Last path segment of a Windows or POSIX path; '' when there is none. */
function baseName(value) {
  const parts = String(value).split(/[\\/]/).filter((part) => part.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/**
 * Group sessions by workspace and nest subagents under their parents.
 *
 * A group's display path is the most common `cwd` among its sessions (each
 * session reports its own; they agree within a workspace), its name the path's
 * last segment, falling back to the raw workspace key when no session reports
 * a cwd. A session whose parent is missing from the group roots its own tree
 * — an orphaned subagent stays visible instead of vanishing from the list.
 * Roots sort newest first; subagents sort oldest first (spawn order). Groups
 * sort by total bytes, largest first.
 */
function buildWorkspaceGroups(sessions) {
  const byWorkspace = new Map()
  for (const session of sessions) {
    const list = byWorkspace.get(session.workspaceKey)
    if (list === undefined) byWorkspace.set(session.workspaceKey, [session])
    else list.push(session)
  }

  const groups = []
  for (const [workspaceKey, list] of byWorkspace) {
    const cwdCounts = new Map()
    for (const session of list) {
      if (typeof session.cwd === 'string' && session.cwd !== '') {
        cwdCounts.set(session.cwd, (cwdCounts.get(session.cwd) ?? 0) + 1)
      }
    }
    let path
    let best = 0
    for (const [cwd, count] of cwdCounts) {
      if (count > best) {
        best = count
        path = cwd
      }
    }
    const name = baseName(path ?? '') || workspaceKey

    const ids = new Set(list.map((session) => session.id))
    const childrenOf = new Map()
    for (const session of list) {
      if (session.parent === undefined) continue
      const siblings = childrenOf.get(session.parent)
      if (siblings === undefined) childrenOf.set(session.parent, [session])
      else siblings.push(session)
    }
    const buildNode = (session) => ({
      session,
      orphan: session.parent !== undefined && !ids.has(session.parent),
      children: (childrenOf.get(session.id) ?? []).map(buildNode),
    })
    const roots = list
      .filter((session) => session.parent === undefined || !ids.has(session.parent))
      .map(buildNode)
    const sortTree = (nodes) => {
      nodes.sort((left, right) => (left.session.createdAt ?? 0) - (right.session.createdAt ?? 0))
      for (const node of nodes) sortTree(node.children)
      return nodes
    }
    roots.sort((left, right) => (right.session.createdAt ?? 0) - (left.session.createdAt ?? 0))
    for (const node of roots) sortTree(node.children)

    groups.push({
      key: workspaceKey,
      name,
      path,
      roots,
      count: list.length,
      childCount: list.filter((session) => session.parent !== undefined).length,
      bytes: list.reduce((sum, session) => sum + (session.bytes ?? 0), 0),
    })
  }
  groups.sort((left, right) => right.bytes - left.bytes)
  return groups
}

/** Flatten a display forest back into its sessions, parents before children. */
function collectSessions(nodes, out = []) {
  for (const node of nodes) {
    out.push(node.session)
    collectSessions(node.children, out)
  }
  return out
}

/**
 * The descendant subagent sessions of one id, breadth-first over the loaded
 * `parent` links — the ids the Host would delete together with it.
 */
function collectDescendants(sessions, sessionId) {
  const childrenOf = new Map()
  for (const session of sessions) {
    if (session.parent === undefined) continue
    const list = childrenOf.get(session.parent)
    if (list === undefined) childrenOf.set(session.parent, [session])
    else list.push(session)
  }
  const out = []
  const queue = [sessionId]
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()) ?? []) {
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}

/** Does a session match the filter needle across its display fields? */
function sessionMatches(session, needle) {
  return session.id.toLowerCase().includes(needle)
    || (session.title ?? '').toLowerCase().includes(needle)
    || session.workspaceKey.toLowerCase().includes(needle)
    || (session.cwd ?? '').toLowerCase().includes(needle)
}

/**
 * Keep the nodes a filter still shows. A matching node keeps its whole subtree
 * (the user matched the parent, the children come along); a non-matching node
 * survives only through matching descendants, which keeps the tree shape
 * intact when only a subagent matches.
 */
function filterNodes(nodes, needle) {
  const out = []
  for (const node of nodes) {
    const children = filterNodes(node.children, needle)
    if (sessionMatches(node.session, needle)) out.push(node)
    else if (children.length > 0) out.push({ session: node.session, orphan: node.orphan, children })
  }
  return out
}

/** A group survives a filter through its name/path or any surviving session. */
function filterGroup(group, needle) {
  if (group.name.toLowerCase().includes(needle) || (group.path ?? '').toLowerCase().includes(needle)) return group
  const roots = filterNodes(group.roots, needle)
  if (roots.length === 0) return undefined
  return { ...group, roots }
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

/** Locale date for a session's creation stamp; '' when unknown. */
function formatDay(time) {
  try {
    const date = new Date(time)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleDateString()
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
  // Optional: called after a successful batch deletion so the client can
  // re-pull its session list and drop the deleted rows from the sidebar.
  const afterDelete = primitives?.afterDelete

  return function SessionCleanerPage() {
    const [state, setState] = useState({ phase: 'loading' })
    const [query, setQuery] = useState('')
    const [selected, setSelected] = useState(() => new Set())
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState(undefined)
    // Workspace groups and parent rows the user has expanded; both default to
    // collapsed, and a text filter overrides them (matches must be visible).
    const [openWorkspaces, setOpenWorkspaces] = useState(() => new Set())
    const [openSessions, setOpenSessions] = useState(() => new Set())
    // The pending conversation preview: { phase: 'loading'|'ready'|'error',
    // sessionId, data?, error? } — undefined while no dialog is open.
    const [preview, setPreview] = useState(undefined)
    const previewSeq = useRef(0)
    // The preview dialog's user-chosen size; undefined = the responsive
    // default. The state lives in the page (which outlives the dialog), so a
    // chosen size survives closing and reopening.
    const [previewSize, setPreviewSize] = useState(undefined)
    const previewPanelRef = useRef(null)

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

    // Escape closes the preview, matching the platform Modal's behaviour.
    useEffect(() => {
      if (preview === undefined || typeof document?.addEventListener !== 'function') return undefined
      const onKeyDown = (event) => { if (event.key === 'Escape') closePreview() }
      document.addEventListener('keydown', onKeyDown)
      return () => { document.removeEventListener('keydown', onKeyDown) }
    }, [preview === undefined])

    const sessions = state.phase === 'ready' ? state.sessions : []
    const filtering = query.trim() !== ''
    const groups = useMemo(() => buildWorkspaceGroups(sessions), [sessions])
    const visibleGroups = useMemo(() => {
      const needle = query.trim().toLowerCase()
      if (needle === '') return groups
      return groups
        .map((group) => filterGroup(group, needle))
        .filter((group) => group !== undefined)
    }, [groups, query])
    const visibleSessions = useMemo(
      () => visibleGroups.flatMap((group) => collectSessions(group.roots)),
      [visibleGroups],
    )

    const allVisibleSelected = visibleSessions.length > 0 && visibleSessions.every((session) => selected.has(session.id))
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
      setSelected(setSelection(sessions, selected, visibleSessions.map((session) => session.id), true))
    }
    /** The group header checkbox: drive every session under the group toward one state. */
    const toggleGroup = (groupSessions) => {
      const wanted = !(groupSessions.length > 0 && groupSessions.every((session) => selected.has(session.id)))
      setSelected(setSelection(sessions, selected, groupSessions.map((session) => session.id), wanted))
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
          // The files are gone: refresh the client session list so the
          // sidebar drops these rows without a restart.
          try { afterDelete?.() } catch { /* best effort */ }
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

    /** Flip one membership in an expansion Set (workspaces, parent rows). */
    const toggleSet = (setter, value) => setter((previous) => {
      const next = new Set(previous)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })

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
     * Drag-resize the preview dialog from its corner grip: pointer deltas
     * become an explicit size, clamped to the viewport. A double-click on the
     * grip returns to the responsive default.
     */
    const startPreviewResize = (event) => {
      event.preventDefault?.()
      event.stopPropagation?.()
      const panel = previewPanelRef.current
      if (panel == null || typeof window?.addEventListener !== 'function') return
      const startX = event.clientX
      const startY = event.clientY
      const startWidth = panel.offsetWidth
      const startHeight = panel.offsetHeight
      const onMove = (moveEvent) => {
        const width = Math.round(Math.min(Math.max(480, startWidth + moveEvent.clientX - startX), window.innerWidth - 48))
        const height = Math.round(Math.min(Math.max(320, startHeight + moveEvent.clientY - startY), window.innerHeight - 48))
        setPreviewSize({ width, height })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    }

    /**
     * The transcript dialog: a wide, user-resizable card.
     *
     * The platform Modal is fixed at min(380px, 100%) wide with no size
     * override, so a transcript — the one dialog that wants screen real
     * estate — renders through this own card instead, dressed in the same
     * design aliases (layer-2 fill, prominent elevation, blurred mask) to
     * stay indistinguishable from the shipped dialogs. The page is a
     * long-lived `main` slot component, so the dialog can live in its tree
     * directly — unlike the session-menu rows, whose dialogs must ride the
     * frame-wide `shell.overlay` because the row unmounts with its menu.
     */
    const renderPreview = () => {
      if (preview === undefined) return null
      const data = preview.phase === 'ready' ? preview.data : undefined

      const body = []
      // The id sits directly under the title in every phase: the dialog's
      // subject stays identifiable even while the transcript is loading.
      body.push(React.createElement('p', { key: 'sessionid', style: previewIdStyle }, [
        React.createElement('span', { key: 'label', style: previewIdLabelStyle }, `${t('preview.sessionId')}: `),
        preview.sessionId,
      ]))
      const descendants = collectDescendants(sessions, preview.sessionId)
      if (descendants.length > 0) {
        body.push(React.createElement('div', { key: 'children', style: previewChildrenStyle }, [
          React.createElement('p', { key: 'head', style: previewChildrenHeadStyle },
            t('preview.children', { count: descendants.length })),
          ...descendants.map((session) => React.createElement('div', { key: session.id, style: previewChildRowStyle }, [
            React.createElement('span', { key: 'badge', style: childBadgeStyle }, t('panel.child')),
            React.createElement('span', {
              key: 'id',
              style: previewChildIdStyle,
              title: session.title ?? session.id,
            }, session.id),
          ])),
        ]))
      }
      if (data !== undefined) {
        // The workspace arrives as its encoded key; the cwd is the same place
        // in human form, so only size and cwd are shown.
        const meta = [data.humanBytes, data.cwd]
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

      const panelStyle = previewSize === undefined
        ? previewPanelStyle
        : { ...previewPanelStyle, width: `${previewSize.width}px`, height: `${previewSize.height}px` }

      return React.createElement('div', { style: previewOverlayStyle }, [
        React.createElement('div', {
          key: 'mask',
          style: previewMaskStyle,
          onClick: () => { closePreview() },
        }),
        React.createElement('div', {
          key: 'panel',
          ref: previewPanelRef,
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('preview.title'),
          style: panelStyle,
        }, [
          React.createElement('div', { key: 'header', style: previewHeaderStyle }, [
            React.createElement('h2', { key: 'title', style: previewHeadingStyle }, t('preview.title')),
            React.createElement('button', {
              key: 'close',
              type: 'button',
              style: previewCloseStyle,
              'aria-label': t('dialog.close'),
              onClick: closePreview,
            }, '×'),
          ]),
          React.createElement('p', { key: 'subject', style: previewSubjectStyle }, data?.title || preview.sessionId),
          React.createElement('div', { key: 'body', style: previewBodyStyle }, body),
          React.createElement('div', { key: 'footer', style: previewFooterStyle },
            React.createElement('button', { key: 'close', type: 'button', onClick: closePreview, style: buttonStyle }, t('dialog.close'))),
          React.createElement('div', {
            key: 'resize',
            style: resizeGripStyle,
            'aria-label': t('preview.resize'),
            title: t('preview.resize'),
            onPointerDown: startPreviewResize,
            onDoubleClick: (event) => {
              event.stopPropagation()
              setPreviewSize(undefined)
            },
          }, '◢'),
        ]),
      ])
    }

    /** One workspace group card: header row, then its session forest when open. */
    const renderGroup = (group) => {
      const open = filtering || openWorkspaces.has(group.key)
      const groupSessions = collectSessions(group.roots)
      const allSelected = groupSessions.length > 0 && groupSessions.every((session) => selected.has(session.id))
      const someSelected = groupSessions.some((session) => selected.has(session.id))

      const rows = [
        React.createElement('div', {
          key: 'header',
          style: groupHeaderStyle,
          role: 'group',
          'aria-label': group.name,
          onClick: () => { toggleSet(setOpenWorkspaces, group.key) },
        }, [
          React.createElement('button', {
            key: 'expander',
            type: 'button',
            style: expanderStyle,
            'aria-expanded': open,
            'aria-label': t(open ? 'panel.collapse' : 'panel.expand'),
            onClick: (event) => {
              event.stopPropagation()
              toggleSet(setOpenWorkspaces, group.key)
            },
            onDoubleClick: (event) => event.stopPropagation(),
          }, open ? '▼' : '▶'),
          React.createElement('input', {
            key: 'check',
            type: 'checkbox',
            checked: allSelected,
            // A partial selection reads as indeterminate; React has no prop
            // for it, so the ref callback owns that DOM state.
            ref: (element) => { if (element != null) element.indeterminate = someSelected && !allSelected },
            onClick: (event) => event.stopPropagation(),
            onChange: () => toggleGroup(groupSessions),
          }),
          React.createElement('span', {
            key: 'name',
            style: groupNameStyle,
            title: group.path ?? group.key,
          }, group.name),
          React.createElement('span', { key: 'path', style: groupPathStyle }, group.path ?? ''),
          React.createElement('span', { key: 'stats', style: groupStatsStyle },
            t(group.childCount > 0 ? 'panel.groupStatsChildren' : 'panel.groupStats',
              { count: group.count, children: group.childCount, size: formatBytes(group.bytes) })),
        ]),
      ]
      if (open) {
        for (const node of group.roots) rows.push(...renderNode(node, 0))
      }
      return React.createElement('div', { key: group.key, style: listStyle }, rows)
    }

    /** One session row (a checkbox label) plus, when expanded, its subagents. */
    const renderNode = (node, depth) => {
      const { session } = node
      const hasChildren = node.children.length > 0
      const open = filtering || openSessions.has(session.id)
      const label = session.title ?? session.id

      return [
        React.createElement('label', {
          key: session.id,
          style: { ...rowStyle, paddingLeft: `${10 + depth * 20}px` },
          // A double-click toggles the checkbox twice on the way in (net no
          // change) and then opens the preview.
          onDoubleClick: () => { void openPreview(session.id) },
        }, [
          // The caret column leads so the checkboxes of the group header, of
          // parent rows and of leaf rows all share one vertical line.
          hasChildren
            ? React.createElement('button', {
              key: 'expander',
              type: 'button',
              style: expanderStyle,
              'aria-expanded': open,
              'aria-label': t(open ? 'panel.collapse' : 'panel.expand'),
              // Inside the row label: without these the click would reach the
              // label's checkbox instead of the caret.
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                toggleSet(setOpenSessions, session.id)
              },
              onDoubleClick: (event) => event.stopPropagation(),
            }, open ? '▼' : '▶')
            : React.createElement('span', { key: 'spacer', style: expanderSpacerStyle }),
          React.createElement('input', {
            key: 'check',
            type: 'checkbox',
            checked: selected.has(session.id),
            onChange: () => toggle(session.id),
            // Inside the row label: rapid check/uncheck clicks end in a
            // dblclick that would bubble to the label's preview handler —
            // the checkbox's only duty is to check and uncheck.
            onDoubleClick: (event) => event.stopPropagation(),
          }),
          React.createElement('span', {
            key: 'title',
            // An untitled session falls back to its id, dimmed.
            style: session.title === undefined ? { ...titleStyle, opacity: 0.55 } : titleStyle,
            title: label,
          }, label),
          session.parent === undefined ? null : React.createElement('span', { key: 'child', style: childBadgeStyle }, t('panel.child')),
          hasChildren ? React.createElement('span', { key: 'count', style: childBadgeStyle }, t('panel.childCount', { count: node.children.length })) : null,
          session.createdAt === undefined ? null : React.createElement('span', { key: 'day', style: metaStyle }, formatDay(session.createdAt)),
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
        ]),
        ...(hasChildren && open ? node.children.flatMap((child) => renderNode(child, depth + 1)) : []),
      ]
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

      if (visibleGroups.length === 0) {
        body.push(React.createElement('p', { key: 'empty', style: hintStyle }, t('panel.empty')))
      } else {
        body.push(React.createElement('div', { key: 'groups', style: groupsStyle },
          visibleGroups.map((group) => renderGroup(group))))
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
const groupsStyle = Object.freeze({ display: 'flex', flexDirection: 'column', gap: '12px' })
const listStyle = Object.freeze({
  display: 'flex', flexDirection: 'column',
  border: '1px solid var(--dsw-alias-border-l2, light-dark(rgba(0,0,0,.08), rgba(255,255,255,.12)))',
  borderRadius: '10px',
})
const groupHeaderStyle = Object.freeze({
  display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 10px', cursor: 'pointer', userSelect: 'none',
  background: 'var(--dsw-alias-interactive-bg-hover, light-dark(rgba(38,49,72,.05), rgba(255,255,255,.06)))',
  borderBottom: '1px solid var(--dsw-alias-border-l1, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)))',
})
const groupNameStyle = Object.freeze({
  fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap',
  maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis',
})
const groupPathStyle = Object.freeze({
  flex: '1 1 auto', minWidth: 0, fontSize: '11px', opacity: 0.55,
  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
})
const groupStatsStyle = Object.freeze({
  marginLeft: 'auto', fontSize: '11px', opacity: 0.65, whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
})
const rowStyle = Object.freeze({
  display: 'flex', gap: '8px', alignItems: 'center', padding: '6px 10px', cursor: 'pointer',
  userSelect: 'none',
  borderBottom: '1px solid var(--dsw-alias-border-l1, light-dark(rgba(0,0,0,.05), rgba(255,255,255,.08)))',
})
const titleStyle = Object.freeze({ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
const metaStyle = Object.freeze({ fontSize: '11px', opacity: 0.6, whiteSpace: 'nowrap' })
const expanderStyle = Object.freeze({
  flexShrink: 0, width: '20px', height: '20px', padding: 0,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: '10px', lineHeight: 1, opacity: 0.8,
  cursor: 'pointer', border: 'none', background: 'transparent', color: 'inherit',
})
const expanderSpacerStyle = Object.freeze({ flexShrink: 0, width: '20px' })
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
  alignItems: 'center', justifyContent: 'center', padding: '24px',
  // An overlay host usually disables hit-testing on its container so it cannot
  // block the app beneath it; the dialog has to opt back in.
  pointerEvents: 'auto',
})
const previewMaskStyle = Object.freeze({
  position: 'absolute', inset: '0',
  background: 'var(--dsw-alias-bg-mask-1, light-dark(rgba(15,17,21,.32), rgba(0,0,0,.5)))',
  backdropFilter: 'var(--dsw-mask-blur, blur(2px))',
})
// Wide by default (a transcript wants real estate) and resizable through the
// corner grip; the same design aliases the platform Modal card uses keep the
// look identical while the size stays under our control.
const previewPanelStyle = Object.freeze({
  position: 'relative', zIndex: 1,
  display: 'flex', flexDirection: 'column',
  width: 'min(92vw, 920px)',
  height: 'min(84vh, 680px)',
  borderRadius: '24px', overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-2, light-dark(#ffffff, #353638))',
  color: 'var(--dsw-alias-label-primary, light-dark(#0f1115, #f9fafb))',
  boxShadow: 'var(--dsw-elevation-prominent, 0 8px 32px rgba(0,0,0,.24))',
  font: 'inherit', pointerEvents: 'auto',
})
const previewHeaderStyle = Object.freeze({
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
  padding: '22px 14px 12px 24px',
})
const previewCloseStyle = Object.freeze({
  flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '28px', height: '28px', border: 'none', borderRadius: '8px',
  background: 'transparent', cursor: 'pointer', font: 'inherit', fontSize: '14px',
  color: 'var(--dsw-alias-label-secondary, inherit)',
})
const previewHeadingStyle = Object.freeze({ margin: '0', fontSize: '16px', fontWeight: 500, lineHeight: '24px' })
const previewSubjectStyle = Object.freeze({
  margin: '0', padding: '0 24px', fontSize: '14px', lineHeight: '22px',
  opacity: 0.85, wordBreak: 'break-all',
})
const previewBodyStyle = Object.freeze({
  display: 'flex', flexDirection: 'column', minWidth: 0,
  flex: '1 1 auto', minHeight: 0,
  marginTop: '12px', padding: '0 24px 4px', overflow: 'hidden',
})
const previewIdStyle = Object.freeze({
  margin: '0 0 8px', fontSize: '12px', opacity: 0.75, wordBreak: 'break-all',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
})
const previewIdLabelStyle = Object.freeze({ opacity: 0.6, fontFamily: 'inherit' })
const previewChildrenStyle = Object.freeze({ margin: '0 0 8px', display: 'flex', flexDirection: 'column', gap: '4px' })
const previewChildrenHeadStyle = Object.freeze({ margin: '0', fontSize: '11px', opacity: 0.6 })
const previewChildRowStyle = Object.freeze({ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px', opacity: 0.85 })
const previewChildIdStyle = Object.freeze({
  wordBreak: 'break-all',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
})
const previewMetaStyle = Object.freeze({ margin: '0 0 8px', fontSize: '12px', opacity: 0.7, wordBreak: 'break-all' })
const previewFooterStyle = Object.freeze({
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px',
  padding: '12px 24px 20px',
})
const resizeGripStyle = Object.freeze({
  position: 'absolute', right: '0', bottom: '0', width: '22px', height: '22px',
  display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
  padding: '2px 4px', fontSize: '11px', lineHeight: 1, opacity: 0.45,
  cursor: 'nwse-resize', touchAction: 'none', userSelect: 'none', zIndex: 1,
})
const messageListStyle = Object.freeze({
  display: 'flex', flexDirection: 'column', gap: '12px',
  flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '2px',
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

// Attached after the main export so the factory assignment above cannot
// overwrite it; the bundle itself only ever uses the factory.
module.exports.toggleWithDescendants = toggleWithDescendants
module.exports.renderMessages = renderMessages
module.exports.setSelection = setSelection
module.exports.buildWorkspaceGroups = buildWorkspaceGroups
module.exports.collectSessions = collectSessions
module.exports.collectDescendants = collectDescendants
