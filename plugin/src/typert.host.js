/**
 * Strict reflection for the session-cleaner service.
 *
 * dsh-typert-loader imports this file for every bundle that declares the
 * `./typert` export, so it MUST exist and MUST load cleanly — a missing or
 * throwing contributor fails the plugin's activation entirely. The invocations
 * are the same descriptors the Web client mounts, imported from the shared
 * contract so the two halves cannot drift.
 */

import { SESSION_CLEANER_DELETE, SESSION_CLEANER_JSON_SCHEMA, SESSION_CLEANER_LIST, SESSION_CLEANER_PREVIEW } from './contract.cjs'

export const TYPERT = {
  package: 'dsh-plugin-session-cleaner',
  face: 'host',
  schemas: [SESSION_CLEANER_JSON_SCHEMA],
  invocations: [SESSION_CLEANER_LIST, SESSION_CLEANER_PREVIEW, SESSION_CLEANER_DELETE],
  model: {
    services: [{
      key: 'sessionCleaner',
      exportName: 'SessionCleanerService',
      description: 'Complete session deletion: session logs, projection caches, workspace-registry references and derived search indexes.',
      summary: 'Session cleanup service',
      tags: [],
      members: [
        { kind: 'method', name: 'list', signature: 'list(): Promise<{ sessions: SessionCleanupRecord[]; skipped: unknown[]; searchIndexes: string[]; dshHome: string }>' },
        { kind: 'method', name: 'preview', signature: 'preview(sessionIds: string[]): Promise<SessionCleanupPlan>' },
        { kind: 'method', name: 'delete', signature: 'delete(sessionIds: string[], options?: { guard?: string }): Promise<SessionCleanupResult>' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
}

export default TYPERT
