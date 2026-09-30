/**
 * Probe the real DSH session logs to confirm header reading works against
 * actual on-disk data — both the v4 (`session-`) and v3 (`sess_`) generations.
 * This is a diagnostic script, not part of the shipped plugin.
 */
import path from 'node:path'
import { scanSessions, readSessionHeader, rootsFor, resolveDshHome, planDeletion } from '../src/cleaner.js'

const roots = rootsFor(resolveDshHome())
console.log('DSH roots:', roots)

const { records, workspaceKeys, skipped } = await scanSessions(roots)
console.log(`\nworkspace keys: ${workspaceKeys.length}`)
console.log(`sessions found: ${records.size}`)
console.log(`skipped: ${skipped.length}`)
for (const entry of skipped) console.log('  SKIP', entry.reason, entry.path)

console.log('\nid | log | bytes | parent | cwd')
for (const record of records.values()) {
  console.log([
    record.id,
    record.logName,
    String(record.bytes).padStart(7),
    record.parent ?? '-',
    record.cwd ?? '-',
  ].join(' | '))
}

// Prove the raw header parse in isolation on one real file.
const sample = [...records.values()][0]
if (sample) {
  console.log('\nraw header of', path.basename(sample.dir))
  console.log(JSON.stringify(await readSessionHeader(sample.logFile), null, 2))
}

// A dry plan over every session exercises the full read path without deleting.
const all = [...records.keys()]
const plan = await planDeletion(roots, all, { rootSessionId: '*probe*' })
console.log('\nplan summary:', JSON.stringify(plan.totals))
console.log('registry changes that WOULD happen:', JSON.stringify(plan.registryChanges))
console.log('search indexes found:', plan.searchIndexes.length)
for (const index of plan.searchIndexes) console.log('  ', index)
