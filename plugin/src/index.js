/**
 * session-cleaner Host half.
 *
 * DSH ships no way to delete a session: `sessionPersistence` exposes only
 * create/open/stat/list, `sessionController` has no delete, and the sidebar
 * menu offers pin/rename/fork/archive. This plugin adds the missing operation
 * and performs it completely — session log, projection cache, workspace
 * registry references, and derived search indexes.
 *
 * The service is the single authority for deletion; the Web UI and the model
 * Tool are two callers of it.
 *
 * This module deliberately imports NO DSH package: the profile's
 * `@deepseek-ai/*` entries are partly unresolved links, so a static dependency
 * on any of them would turn a load-time resolution failure into a plugin that
 * never activates. Everything it needs arrives through the Cordis context.
 */

import { executeDeletion, findSearchIndexes, isValidSessionId, planDeletion, resolveDshHome, rootsFor, scanSessions } from './cleaner.js'

export const name = 'sessionCleaner'
export const inject = ['tools', 'agents']

const SERVICE = 'sessionCleaner'
const RESTORE_NOTE = 'Deletion is permanent: DSH has no recycle bin and no soft-delete layer.'
const DEFAULT_STOP_TIMEOUT_MS = 8000

/** One human-readable line describing a byte count. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Resolve the stop timeout, allowing an environment override for testing. */
function stopTimeoutMs() {
  const raw = Number(process.env.DSH_SESSION_CLEANER_STOP_MS)
  if (Number.isFinite(raw) && raw >= 500 && raw <= 60000) return raw
  return DEFAULT_STOP_TIMEOUT_MS
}

/** JSON-serializable projection of a deletion plan. */
function planToWire(plan) {
  return {
    targetCount: plan.targets.length,
    bytes: plan.totals.bytes,
    humanBytes: formatBytes(plan.totals.bytes),
    targets: plan.targets.map((target) => ({
      id: target.id,
      depth: target.depth,
      isRoot: target.isRoot,
      workspaceKey: target.workspaceKey,
      logFile: target.logFile,
      bytes: target.bytes,
      title: target.title,
      cwd: target.cwd,
    })),
    registryChanges: plan.registryChanges,
    searchIndexes: plan.searchIndexes,
    rejected: plan.rejectedIds,
    missing: plan.missing,
    skipped: plan.skipped,
  }
}

/** JSON-serializable projection of a deletion result. */
function resultToWire(result) {
  return {
    aborted: result.aborted === true,
    stopped: result.stopped,
    deleted: result.deleted.map((entry) => ({ id: entry.id, kind: entry.kind, bytes: entry.bytes ?? 0 })),
    registryChanges: result.registryChanges,
    searchIndexesRemoved: result.searchIndexesRemoved.map((entry) => entry.path),
    failed: result.failed,
    summary: result.summary,
    humanBytes: formatBytes(result.summary?.bytesDeleted ?? 0),
  }
}

/**
 * Build the deletion service over the live Cordis context.
 * @param ctx - the plugin context, carrying `agents`.
 */
function createService(ctx) {
  const roots = rootsFor(resolveDshHome())
  const timeoutMs = stopTimeoutMs()

  /** Resolve a live agent for a session, if one is registered. */
  const liveAgent = (sessionId) => {
    try {
      return ctx.agents?.get(sessionId)
    } catch {
      return undefined
    }
  }

  /** Wait until an agent reports `idle`, or the timeout expires. */
  const awaitIdle = async (agent, limitMs) => {
    const deadline = Date.now() + limitMs
    while (Date.now() < deadline) {
      if (agent.status !== 'running') return true
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return agent.status !== 'running'
  }

  /**
   * Stop one session before its files are removed: a running agent would keep
   * appending to a log we just deleted, leaving a half session behind.
   *
   * `ctx.agents.get()` returns a bare Agent — the AgentHandle disposer is a
   * capability held only by whoever created it — so cancellation is the
   * correct lever here, not disposal.
   */
  const stopSession = async (sessionId) => {
    const agent = liveAgent(sessionId)
    if (agent === undefined) return { wasRunning: false, stillRunning: false }
    if (agent.status !== 'running') return { wasRunning: false, stillRunning: false }

    try {
      if (typeof agent.cancel === 'function') {
        agent.cancel({ kind: 'user' }, { keepInbox: false })
      } else if (typeof agent.abort === 'function') {
        agent.abort()
      } else if (typeof agent.interrupt === 'function') {
        agent.interrupt()
      } else {
        return { wasRunning: true, stillRunning: true, reason: 'the live agent exposes no cancellation method' }
      }
    } catch (error) {
      return { wasRunning: true, stillRunning: true, reason: String(error?.message ?? error) }
    }

    const idle = await awaitIdle(agent, timeoutMs)
    return {
      wasRunning: true,
      stillRunning: !idle,
      ...(idle ? {} : { reason: `still running after ${timeoutMs} ms` }),
    }
  }

  return {
    dshHome: roots.dshHome,

    /** Every session on disk with lightweight metadata, largest first. */
    async list() {
      const { records, skipped } = await scanSessions(roots)
      const searchIndexes = await findSearchIndexes(roots)
      const sessions = [...records.values()].map((record) => ({
        id: record.id,
        workspaceKey: record.workspaceKey,
        bytes: record.bytes,
        humanBytes: formatBytes(record.bytes),
        parent: record.parent,
        cwd: record.cwd,
        title: record.title,
      }))
      sessions.sort((left, right) => right.bytes - left.bytes)
      return { sessions, skipped, searchIndexes, dshHome: roots.dshHome }
    },

    /** Preview exactly what deleting these sessions would remove. */
    async preview(sessionIds) {
      const planned = await planDeletion(roots, Array.isArray(sessionIds) ? sessionIds : [])
      return { ...planToWire(planned), note: RESTORE_NOTE }
    },

    /**
     * Permanently delete sessions and their descendants.
     * @param sessionIds - root session ids to remove.
     * @param options.guard - a session id that must NOT be deleted (the open one).
     * @param options.cascade - reserved; descendants are always included.
     */
    async delete(sessionIds, options = {}) {
      const requested = Array.isArray(sessionIds) ? sessionIds.filter(isValidSessionId) : []
      if (requested.length === 0) {
        return { ok: false, error: 'no valid session ids were supplied' }
      }
      if (typeof options?.guard === 'string' && requested.includes(options.guard)) {
        return {
          ok: false,
          error: 'refused: the requested set contains the session that is currently open',
          guard: options.guard,
        }
      }

      const planned = await planDeletion(roots, requested)
      if (typeof options?.guard === 'string' && planned.targets.some((target) => target.id === options.guard)) {
        return {
          ok: false,
          error: 'refused: a descendant of the requested set is the session that is currently open',
          guard: options.guard,
        }
      }

      const result = await executeDeletion(roots, planned, { stop: stopSession })
      return { ok: result.failed.length === 0 && result.aborted !== true, ...resultToWire(result) }
    },
  }
}

/**
 * The model-facing definition. `parameters` is a JSON Schema root; the registry
 * validates it and requires `output.schema` plus `output.render`.
 * @param service - the deletion service.
 * @param currentSessionId - the session running the call, refused as a target.
 */
function deletionTool(service, currentSessionId) {
  return {
    name: 'session_delete',
    description: [
      'Permanently delete DeepSeek Harness sessions: their logs, projection caches,',
      'workspace-registry references and derived search indexes. Descendant subagent',
      'sessions are removed together with their parent, and a running session is stopped first.',
      'There is NO undo and no recycle bin. Always preview first with dryRun: true (the default),',
      'show the user the sessions and total size, and only then re-run with dryRun: false.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids to delete. Descendant subagent sessions are included automatically.',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true (the default) only report what would be deleted. Set false to actually delete.',
        },
      },
      // Canonical JSON Schema: `required` is a TOP-LEVEL array of property
      // names. A per-property `required: true` is a DSL-only spelling; the
      // registry does not validate `parameters` at registration, and the model
      // provider then rejects it — failing EVERY conversation carrying this
      // tool (`Invalid schema for function 'session_delete': true is not of
      // type "array"`).
      required: ['sessionIds'],
    },
    output: {
      // A permissive OBJECT root: the registry validates this as strict JSON
      // Schema, so `type: 'json'` (a DSL-only spelling) is rejected. Every
      // branch this tool returns is an object, so an open object is exact.
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const ids = Array.isArray(args?.sessionIds) ? args.sessionIds : []
      if (typeof currentSessionId === 'string' && ids.includes(currentSessionId)) {
        return {
          ok: false,
          error: 'refused: that is the session running this tool call; deleting it would destroy the active conversation',
        }
      }

      if (args?.dryRun !== false) {
        const preview = await service.preview(ids)
        return {
          ok: true,
          dryRun: true,
          ...preview,
          message: `Would delete ${preview.targetCount} session(s) and free ${preview.humanBytes}. Re-run with dryRun: false to confirm.`,
        }
      }

      const result = await service.delete(ids, { guard: currentSessionId })
      return {
        ...result,
        ...(result.ok === true
          ? { message: `Deleted ${result.summary?.sessionsDeleted ?? 0} session(s), freed ${result.humanBytes}.` }
          : {}),
      }
    },
  }
}

export function apply(ctx) {
  const service = createService(ctx)

  // Public Cordis service plus its Remote binding, so the Web UI reaches the
  // same deletion authority the Tool uses. The typert contribution itself is
  // loaded by dsh-typert-loader from this package's `./typert` export; the
  // consumer-side descriptors are mounted by the Web client — the Host half
  // never mounts them itself.
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name })
  ctx.provide(name, service)

  ctx.effect(() => {
    const holder = ctx.agents?.currentInitiator?.()
    const currentSessionId = typeof holder?.id === 'string' ? holder.id : undefined
    const dispose = ctx.tools.register(deletionTool(service, currentSessionId))
    return () => dispose()
  }, 'session-cleaner.tool')
}

// Re-exported so a host (and the tests) can compose the core directly.
export { planDeletion, executeDeletion, rootsFor, resolveDshHome }
