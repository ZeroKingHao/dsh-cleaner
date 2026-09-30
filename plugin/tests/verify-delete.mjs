/**
 * Live deletion of one throwaway session, to verify the whole removal path
 * against real DSH data rather than a synthetic fixture.
 *
 * Loads the INSTALLED plugin copy and calls the same service method the Tool
 * and the Web client call. Reports every step so the three data locations can
 * be re-checked from the shell afterwards.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const installed = process.argv[2]
const target = process.argv[3]
if (!installed || !target) throw new Error('usage: node verify-delete.mjs <installed-package-dir> <session-id>')

const plugin = await import(pathToFileURL(`${installed}/src/index.js`).href)

const provided = new Map()
plugin.apply({
  agents: { get: () => undefined },
  tools: { register: () => () => {} },
  provide: (key, value) => { provided.set(key, value) },
  effect: (callback) => { callback() },
  get: () => undefined,
})
const service = provided.get('sessionCleaner')

const before = await service.preview([target])
const sessionDir = before.targets[0]?.logFile
if (sessionDir === undefined) throw new Error(`the target session is not on disk: ${target}`)

const dir = path.dirname(sessionDir)
console.log('BEFORE')
console.log('  session dir exists :', existsSync(dir))
console.log('  targets            :', before.targetCount, `(${before.humanBytes})`)

const result = await service.delete([target], {})
console.log('\nRESULT')
console.log('  ok        :', result.ok)
console.log('  aborted   :', result.aborted)
console.log('  stopped   :', JSON.stringify(result.stopped))
console.log('  deleted   :', JSON.stringify(result.deleted))
console.log('  registry  :', JSON.stringify(result.registryChanges))
console.log('  indexes   :', JSON.stringify(result.searchIndexesRemoved))
console.log('  failed    :', JSON.stringify(result.failed))
console.log('  summary   :', JSON.stringify(result.summary))

console.log('\nAFTER')
console.log('  session dir exists :', existsSync(dir))
