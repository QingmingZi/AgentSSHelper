/**
 * 以「隔离用户数据目录」启动正式版 Electron 应用，供 UI 回归使用。
 *
 * 背景：ui-verify 会在启动的应用里预置一份模拟的 SSH / AI 配置。
 * 如果不隔离，这些模拟值会直接写进真实数据目录（%APPDATA%\sshelper\ai.json、
 * profiles.json），把用户真实的 AI 配置和主机配置覆盖掉，表现为
 * 「每次更新版本 / 每次跑 UI 测试，ai 配置就丢了」。
 *
 * 这里在启动前用 --user-data-dir（SSHELPER_USER_DATA）指向一个独立的临时目录，
 * 让 UI 测试的所有写入都落在隔离目录里，绝不触碰真实配置。
 *
 * 用法：node scripts/launch-ui-app.mjs [--remote-debugging-port=<port>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const portArg = process.argv.find((a) => a.startsWith('--remote-debugging-port='))
const port = portArg ? portArg.split('=')[1] : '9333'

// 隔离的用户数据目录：随本次测试创建，用完可删，与 %APPDATA%\sshelper 完全无关
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sshelper-ui-userdata-'))
process.env.SSHELPER_USER_DATA = userData

console.log(`[launch-ui-app] 隔离用户数据目录: ${userData}`)
console.log(`[launch-ui-app] remote-debugging-port=${port}`)

// 直接启动 Electron 可执行文件（不是 node.exe）
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(electronBin, [root, `--remote-debugging-port=${port}`], {
  cwd: root,
  env: process.env,
  stdio: 'inherit'
})

child.on('close', (code) => {
  console.log(`[launch-ui-app] electron 退出 code=${code}`)
  process.exit(code ?? 0)
})