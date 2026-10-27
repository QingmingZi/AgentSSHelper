/**
 * 清理 release 目录，只保留当前版本的免安装版 exe。
 *
 * 打包 portable 目标时 electron-builder 还会留下 win-unpacked、blockmap、
 * latest.yml 等中间产物；旧版本的安装包也会一直堆积。
 * 这个脚本在每次 dist:win 之后执行，保证 release 里只剩当前版本的免安装包。
 *
 * 用法：node scripts/clean-release.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const releaseDir = path.join(root, 'release')
const keep = `AgentSSHelper ${pkg.version}.exe`

if (!fs.existsSync(releaseDir)) {
  console.log('[clean-release] release 目录不存在，跳过')
  process.exit(0)
}

// 当前版本的产物还没生成时不要清理，避免把已有文件全删掉
if (!fs.existsSync(path.join(releaseDir, keep))) {
  console.error(`[clean-release] 未找到 ${keep}，跳过清理`)
  process.exit(0)
}

let removed = 0
for (const entry of fs.readdirSync(releaseDir)) {
  if (entry === keep) continue
  fs.rmSync(path.join(releaseDir, entry), { recursive: true, force: true })
  console.log(`[clean-release] 已删除 ${entry}`)
  removed++
}

console.log(`[clean-release] 保留 ${keep}，共删除 ${removed} 项`)
