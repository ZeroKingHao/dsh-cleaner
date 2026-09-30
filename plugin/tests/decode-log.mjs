/**
 * Decode a DSH v4 session log: split at zstd magic bytes, decode each frame
 * with the one-shot API, and print the newest error-like events.
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const wantTail = Number(process.argv[3] ?? 60)

const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// Find candidate frame starts.
const offsets = []
for (let pos = 0; (pos = buf.indexOf(MAGIC, pos)) !== -1; pos += 1) offsets.push(pos)
console.error(`文件 ${buf.length}B, 魔数候选 ${offsets.length} 个`)

const lines = []
let decodedFrames = 0
let failedFrames = 0
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
  // Cap slice size to keep decode attempts bounded.
  if (end - start > 8 * 1024 * 1024) continue
  try {
    const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    decodedFrames += 1
    for (const line of text.split('\n')) if (line.trim()) lines.push(line)
  } catch {
    failedFrames += 1
  }
}
console.error(`解码成功 ${decodedFrames} 帧, 失败 ${failedFrames} 帧, 事件行 ${lines.length}`)

const hits = []
for (const line of lines) {
  if (!/error|invalid|fail|429|401|exceed/i.test(line)) continue
  try {
    const ev = JSON.parse(line)
    hits.push({ type: ev?.type ?? '?', json: JSON.stringify(ev).slice(0, 600) })
  } catch {
    hits.push({ type: 'raw', json: line.slice(0, 400) })
  }
}
console.error(`错误类事件 ${hits.length} 个`)
for (const hit of hits.slice(-wantTail)) {
  console.log('=== ' + hit.type + ' ===')
  console.log(hit.json)
}
