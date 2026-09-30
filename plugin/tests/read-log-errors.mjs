/**
 * Stream-decompress a (multi-frame) session log and print the last error-like
 * events — the one-shot zstd API only decodes the first frame, so this uses
 * the streaming decompressor chained over the whole file.
 */
import { createReadStream } from 'node:fs'
import { createZstdDecompress } from 'node:zlib'
import { createInterface } from 'node:readline'

const file = process.argv[2]
const limit = Number(process.argv[3] ?? 8)

const stream = createReadStream(file).pipe(createZstdDecompress())
const rl = createInterface({ input: stream })

const hits = []
const counts = {}
for await (const line of rl) {
  if (!line.trim()) continue
  counts.total = (counts.total ?? 0) + 1
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  const t = ev?.type ?? ''
  counts[t] = (counts[t] ?? 0) + 1
  if (/error/i.test(t) || /invalid schema|request_id/i.test(line)) {
    hits.push({ type: t, json: JSON.stringify(ev).slice(0, 700) })
  }
}

console.log('事件总数:', counts.total)
console.log('错误类命中:', hits.length)
for (const hit of hits.slice(-limit)) {
  console.log('=== ' + hit.type + ' ===')
  console.log(hit.json)
}
