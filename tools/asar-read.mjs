/**
 * Minimal asar reader: list paths or print one file, no dependencies.
 *
 * Usage:
 *   node tools/asar-read.mjs <archive> list <substring>
 *   node tools/asar-read.mjs <archive> cat <path-in-archive>
 *
 * The header is a Pickle holding the JSON directory tree; file payloads live
 * after it, and each entry's `offset` is relative to that data area.
 */
import fs from 'node:fs'

const [, , archive, mode, argument] = process.argv
if (!archive || !mode || !argument) {
  console.error('usage: node tools/asar-read.mjs <archive> list|cat <substring|path>')
  process.exit(2)
}

const fd = fs.openSync(archive, 'r')
const sizeBuf = Buffer.alloc(8)
fs.readSync(fd, sizeBuf, 0, 8, 0)
const headerSize = sizeBuf.readUInt32LE(4)
const headerBuf = Buffer.alloc(headerSize)
fs.readSync(fd, headerBuf, 0, headerSize, 8)

const text = headerBuf.toString('utf8')
const start = text.indexOf('{')
const end = text.lastIndexOf('}')
const header = JSON.parse(text.slice(start, end + 1))
const dataStart = 8 + headerSize

/** Walk the directory tree, yielding [path, entry] for every file. */
function* walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (child.files) yield* walk(child, path)
    else yield [path, child]
  }
}

if (mode === 'list') {
  let count = 0
  for (const [path, entry] of walk(header, '')) {
    if (!path.includes(argument)) continue
    count += 1
    console.log(`${String(entry.size).padStart(9)}  ${path}`)
  }
  console.log(`--- ${count} match(es)`)
} else if (mode === 'cat') {
  let found
  for (const [path, entry] of walk(header, '')) {
    if (path === argument) { found = [path, entry]; break }
  }
  if (!found) {
    console.error(`not found in archive: ${argument}`)
    process.exit(1)
  }
  const [, entry] = found
  const payload = Buffer.alloc(Number(entry.size))
  fs.readSync(fd, payload, 0, payload.length, dataStart + Number(entry.offset))
  process.stdout.write(payload.toString('utf8'))
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}

fs.closeSync(fd)
