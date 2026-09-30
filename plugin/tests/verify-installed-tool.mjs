/**
 * Verify the INSTALLED copy's Tool definition by reading the file as text and
 * evaluating it in a fresh VM context.
 *
 * A normal `import()` would return the module instance Node already cached for
 * that URL, so an edit to the installed file would not be observed until the
 * process restarts. Reading the source and evaluating it fresh removes that
 * confusion, which matters because the loader's own reload path is cached too.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'

const installed = process.argv[2]
if (!installed) throw new Error('usage: node verify-installed-tool.mjs <installed-package-dir>')

const source = readFileSync(path.join(installed, 'src', 'index.js'), 'utf8')

// Strip the ESM import/export syntax so the body can run as a script; every
// other statement stays exactly as shipped.
const body = source
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"]\s*$/gm, '')
  .replace(/^export\s+(?=(?:const|let|var|function|class)\s)/gm, '')
  .replace(/^export\s*\{[^}]*\}\s*$/gm, '')

const ALLOWED = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** Mirror of dsh-tools' assertSupportedJsonSchema rejection rule. */
function assertSupported(node, where, problems) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertSupported(item, `${where}[${index}]`, problems))
    return
  }
  if (typeof node.type === 'string' && !ALLOWED.has(node.type)) {
    problems.push(`${where}.type = ${JSON.stringify(node.type)} is not one of object/array/string/number/integer/boolean/null`)
  }
  if (node.properties !== null && typeof node.properties === 'object') {
    for (const [name, sub] of Object.entries(node.properties)) assertSupported(sub, `${where}.properties.${name}`, problems)
  }
  if (node.items !== undefined) assertSupported(node.items, `${where}.items`, problems)
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach((sub, index) => assertSupported(sub, `${where}.${key}[${index}]`, problems))
  }
}

const provided = new Map()
const tools = new Map()
const effects = []

const context = {
  console,
  process,
  setTimeout,
  clearTimeout,
  Buffer,
  URL,
  __result: undefined,
}

// Provide the module-level names the stripped imports would have bound.
vm.createContext(context)
vm.runInContext(
  `const executeDeletion = () => {}; const findSearchIndexes = () => []; const isValidSessionId = (v) => typeof v === 'string';`
  + `const planDeletion = async () => ({ targets: [], totals: { bytes: 0 }, registryChanges: [], searchIndexes: [], rejectedIds: [], missing: [], skipped: [] });`
  + `const resolveDshHome = () => process.env.USERPROFILE + '\\\\.dsh'; const rootsFor = (h) => ({ dshHome: h });`
  + `const scanSessions = async () => ({ records: new Map(), skipped: [] });`
  + `const TYPERT_REMOTE = { package: 'x', descriptors: [] };`,
  context,
)

vm.runInContext(
  `${body}
__result = { name, inject, apply };`,
  context,
)

const { name, inject, apply } = context.__result
console.log('plugin name :', name)
console.log('inject      :', JSON.stringify(inject))

apply({
  agents: { get: () => undefined },
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  provide: (key, value) => { provided.set(key, value) },
  effect: (callback) => { effects.push(callback()) },
  get: () => undefined,
})

const tool = tools.get('session_delete')
if (tool === undefined) {
  console.log('\nFAIL: session_delete was not registered')
  process.exitCode = 1
} else {
  const problems = []
  assertSupported(tool.output.schema, 'output.schema', problems)
  assertSupported(tool.parameters, 'parameters', problems)
  console.log('\ntool        :', tool.name)
  console.log('output.schema:', JSON.stringify(tool.output.schema))
  console.log('parameters.type:', tool.parameters.type)
  console.log('has render  :', typeof tool.output.render === 'function')
  console.log('service     :', provided.has('sessionCleaner'))
  if (problems.length > 0) {
    console.log('\nFAIL: unsupported schema nodes')
    for (const problem of problems) console.log('   ', problem)
    process.exitCode = 1
  } else {
    console.log('\nOK: every schema node type is accepted by assertSupportedJsonSchema')
  }
}
