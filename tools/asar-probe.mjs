/**
 * Probe an Electron asar archive for literal strings without unpacking it.
 *
 * Usage: node tools/asar-probe.mjs <archive> <needle> [needle...]
 *
 * Prints each hit with surrounding context so a slot name, a package id or a
 * loader call can be read straight out of the packed sources.
 */
import fs from 'node:fs'

const [, , archive, ...needles] = process.argv
if (!archive || needles.length === 0) {
  console.error('usage: node tools/asar-probe.mjs <archive> <needle> [needle...]')
  process.exit(2)
}

const stats = fs.statSync(archive)
console.log(`archive: ${archive}`)
console.log(`bytes:   ${stats.size}`)

const buf = fs.readFileSync(archive)
const printable = (value) => value.replace(/[^\t\n\x20-\x7e\u4e00-\u9fff]/g, '.')

for (const needle of needles) {
  const target = Buffer.from(needle, 'utf8')
  let index = 0
  let hits = 0
  while (hits < 8) {
    index = buf.indexOf(target, index)
    if (index === -1) break
    hits += 1
    const start = Math.max(0, index - 200)
    const end = Math.min(buf.length, index + target.length + 200)
    console.log(`\n=== hit ${hits} @${index} ===`)
    console.log(printable(buf.toString('utf8', start, end)))
    index += target.length
  }
  if (hits === 0) console.log(`\n=== NOT FOUND: ${needle} ===`)
}
