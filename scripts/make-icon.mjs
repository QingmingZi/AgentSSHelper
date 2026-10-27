/**
 * 生成应用图标（build/icon.ico + build/icon.png）
 *
 * 纯 Node 实现：矢量图形光栅化 -> PNG -> 多尺寸 ICO
 * 图形：圆角渐变底 + 终端提示符 ">"
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const OUT_DIR = path.resolve('build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SS = 4 // 超采样倍数

// ---------------------------------------------------------------- 光栅化

function roundedRectContains(x, y, size, radius) {
  const r = radius
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

/** 点到线段的距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

const TOP = [79, 156, 249] // #4f9cf9
const BOTTOM = [192, 132, 252] // #c084fc

/** 返回 size x size 的 RGBA 像素缓冲 */
function renderIcon(size) {
  const dim = size * SS
  const radius = dim * 0.22
  const stroke = dim * 0.075

  // 提示符 ">" 的三个顶点（相对尺寸）
  const chevron = [
    [dim * 0.3, dim * 0.31],
    [dim * 0.5, dim * 0.5],
    [dim * 0.3, dim * 0.69]
  ]
  const bar = [
    [dim * 0.58, dim * 0.655],
    [dim * 0.76, dim * 0.655]
  ]

  const out = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rSum = 0
      let gSum = 0
      let bSum = 0
      let aSum = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px * SS + sx + 0.5
          const y = py * SS + sy + 0.5

          if (!roundedRectContains(x, y, dim, radius)) continue

          const t = (x / dim + y / dim) / 2
          const [r, g, b] = mix(TOP, BOTTOM, t)

          const dChevron = Math.min(
            distToSegment(x, y, chevron[0][0], chevron[0][1], chevron[1][0], chevron[1][1]),
            distToSegment(x, y, chevron[1][0], chevron[1][1], chevron[2][0], chevron[2][1])
          )
          const dBar = distToSegment(x, y, bar[0][0], bar[0][1], bar[1][0], bar[1][1])
          const glyph = Math.min(dChevron, dBar) <= stroke / 2

          if (glyph) {
            rSum += 255
            gSum += 255
            bSum += 255
          } else {
            rSum += r
            gSum += g
            bSum += b
          }
          aSum += 255
        }
      }

      const samples = SS * SS
      const idx = (py * size + px) * 4
      out[idx] = Math.round(rSum / samples)
      out[idx + 1] = Math.round(gSum / samples)
      out[idx + 2] = Math.round(bSum / samples)
      out[idx + 3] = Math.round(aSum / samples)
    }
  }
  return out
}

// ------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ------------------------------------------------------------------- ICO

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length

  entries.forEach((entry, index) => {
    const base = index * 16
    dir[base] = entry.size >= 256 ? 0 : entry.size
    dir[base + 1] = entry.size >= 256 ? 0 : entry.size
    dir[base + 2] = 0
    dir[base + 3] = 0
    dir.writeUInt16LE(1, base + 4)
    dir.writeUInt16LE(32, base + 6)
    dir.writeUInt32LE(entry.png.length, base + 8)
    dir.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

// ----------------------------------------------------------------- main

fs.mkdirSync(OUT_DIR, { recursive: true })
const entries = []
let largest = null

for (const size of SIZES) {
  const png = encodePng(renderIcon(size), size)
  entries.push({ size, png })
  if (size === 256) largest = png
}

fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(entries))
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), largest)
console.log(`icon written: ${path.join(OUT_DIR, 'icon.ico')} (${SIZES.join(', ')})`)
