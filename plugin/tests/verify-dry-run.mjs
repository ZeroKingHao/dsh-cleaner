/**
 * Dry-run verification against the real DSH data root.
 *
 * Loads the INSTALLED plugin copy (not the dev tree) and exercises the service
 * exactly as the Tool and the Web client call it, with `preview` only — no
 * deletion is performed. This proves the plan projection that the confirmation
 * dialog renders is correct on live data.
 */
import { pathToFileURL } from 'node:url'

const installed = process.argv[2]
if (!installed) throw new Error('usage: node verify-dry-run.mjs <installed-package-dir>')

const plugin = await import(pathToFileURL(`${installed}/src/index.js`).href)

// Minimal context: the real apply(), with no live agents.
const provided = new Map()
const tools = new Map()
ctxShape()
function ctxShape() {
  const ctx = {
    agents: { get: () => undefined },
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    provide: (key, value) => { provided.set(key, value) },
    effect: (callback) => { callback() },
    get: () => undefined,
  }
  plugin.apply(ctx)
}

const service = provided.get('sessionCleaner')
console.log('service provided:', service !== undefined)
console.log('tool registered :', tools.has('session_delete'))

const listed = await service.list()
console.log(`\ndshHome : ${listed.dshHome}`)
console.log(`sessions: ${listed.sessions.length}`)
console.log(`skipped : ${listed.skipped.length}`)
console.log(`indexes : ${listed.searchIndexes.length}`)

console.log('\nid | workspace | size | parent')
for (const session of listed.sessions) {
  console.log(`${session.id} | ${session.workspaceKey} | ${session.humanBytes} | ${session.parent ?? '-'}`)
}

// Preview the session chosen for the live deletion test.
const target = 'sess_9ccf03f2-dfe2-47e4-91ca-221c12900d39'
const preview = await service.preview([target])
console.log(`\n--- preview(${target}) ---`)
console.log('would delete :', preview.targetCount, 'session(s)')
console.log('would free   :', preview.humanBytes)
console.log('targets      :')
for (const entry of preview.targets) {
  console.log(`   depth=${entry.depth} root=${entry.isRoot} id=${entry.id}`)
  console.log(`     dir: ${entry.logFile}`)
}
console.log('registry     :', JSON.stringify(preview.registryChanges))
console.log('rejected     :', JSON.stringify(preview.rejected))
console.log('missing      :', JSON.stringify(preview.missing))
console.log('note         :', preview.note)

// A cascade preview: the current session has a subagent child.
const cascade = await service.preview(['session-145cd2af-8a80-45ce-80b4-b7a04053bb9d'])
console.log('\n--- cascade preview of the live session ---')
console.log('would delete :', cascade.targetCount, 'session(s) (parent + descendants)')
for (const entry of cascade.targets) console.log(`   depth=${entry.depth} root=${entry.isRoot} ${entry.id}`)

console.log('\nDRY RUN ONLY — nothing was deleted.')
