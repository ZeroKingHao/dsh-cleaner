/**
 * The Remote contract, shared verbatim by both halves.
 *
 * The Host's typert manifest and the Web client's mounted descriptors are both
 * built from this file, so the two halves cannot drift.
 *
 * Written as CommonJS on purpose: the Web client bundles this file into a
 * single self-contained `client.js`, and Node's ESM interop exposes these
 * `exports.*` assignments to the Host half as named imports, so one file
 * serves both without a build-time transform.
 *
 * dsh-typert-loader requires EVERY codec — parameters and results — to be
 * `strict` (a string typeSymbol plus a create() factory), and the gateway's
 * boundary check only calls `codec.create().parse(value)`. A pass-through
 * parser therefore satisfies the wire contract exactly: the payloads are plain
 * JSON projection data, and the gateway's own assertJsonValue still guards the
 * boundary, so hand-rolling one line of validation beats shipping a schema
 * library inside the client bundle.
 */

/** Pass-through boundary schema: whatever crosses is already lossless JSON. */
const passthrough = () => ({ parse: (value) => value })

/** The one schema entry both halves register for their codecs. */
const SESSION_CLEANER_JSON_SCHEMA = Object.freeze({
  name: 'SessionCleanerJson',
  create: passthrough,
})

/** Strict JSON codec, valid on both the Host manifest and the client mount. */
const JSON_CODEC = Object.freeze({
  mode: 'strict',
  typeSymbol: 'dsh-plugin-session-cleaner#SessionCleanerJson',
  create: passthrough,
})

/** One ordered business parameter. */
const param = (name, wire = name) => Object.freeze({
  name,
  wire,
  source: 'json',
  codec: JSON_CODEC,
})

const SESSION_CLEANER_LIST = Object.freeze({
  id: 'dsh-plugin-session-cleaner#sessionCleaner/list',
  service: 'sessionCleaner',
  namespace: 'sessionCleaner',
  method: 'list',
  invocation: { kind: 'direct' },
  parameters: [],
  result: JSON_CODEC,
})

const SESSION_CLEANER_PREVIEW = Object.freeze({
  id: 'dsh-plugin-session-cleaner#sessionCleaner/preview',
  service: 'sessionCleaner',
  namespace: 'sessionCleaner',
  method: 'preview',
  invocation: { kind: 'direct' },
  parameters: [param('sessionIds')],
  result: JSON_CODEC,
})

const SESSION_CLEANER_DELETE = Object.freeze({
  id: 'dsh-plugin-session-cleaner#sessionCleaner/delete',
  service: 'sessionCleaner',
  namespace: 'sessionCleaner',
  method: 'delete',
  invocation: { kind: 'direct' },
  parameters: [param('sessionIds'), param('options')],
  result: JSON_CODEC,
})

const TYPERT_REMOTE = Object.freeze({
  package: 'dsh-plugin-session-cleaner',
  descriptors: [SESSION_CLEANER_LIST, SESSION_CLEANER_PREVIEW, SESSION_CLEANER_DELETE],
})

exports.SESSION_CLEANER_JSON_SCHEMA = SESSION_CLEANER_JSON_SCHEMA
exports.SESSION_CLEANER_LIST = SESSION_CLEANER_LIST
exports.SESSION_CLEANER_PREVIEW = SESSION_CLEANER_PREVIEW
exports.SESSION_CLEANER_DELETE = SESSION_CLEANER_DELETE
exports.TYPERT_REMOTE = TYPERT_REMOTE
exports.default = TYPERT_REMOTE
