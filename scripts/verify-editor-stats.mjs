/**
 * 端到端验证：文件编辑器工具栏显示「行数 / 总字数」，字数多了用 K、M 缩写。
 *
 * 前置：已运行 `npm run test:env`，并以隔离数据目录启动应用：
 *   node scripts/launch-ui-app.mjs --remote-debugging-port=9333
 *
 * 用法：node scripts/verify-editor-stats.mjs <cdpPort> <sshPort> <remoteRoot>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [cdpPort, sshPort, remoteRootArg] = process.argv.slice(2)
if (!cdpPort || !sshPort) {
  console.error('usage: node scripts/verify-editor-stats.mjs <cdpPort> <sshPort> [remoteRoot]')
  process.exit(2)
}
const remoteRoot = remoteRootArg ?? path.join(os.tmpdir(), 'sshelper-ui-remote')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 预置一个大日志文件（>170KB，多行），用于验证行数/字数统计
const LOG_PATH = path.join(remoteRoot, 'big-access.log')
const lines = []
for (let i = 0; i < 5000; i++) {
  lines.push(`10.0.${i % 250}.${i % 254} - - [27/Oct/2026:${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} +0800] "GET /path/${i} HTTP/1.1" 200 ${100 + (i % 900)} "x".repeat(40)`)
}
const LOG_TEXT = lines.join('\n') + '\n'
fs.writeFileSync(LOG_PATH, LOG_TEXT, 'utf8')
console.log(`[1] 已预置大日志文件 big-access.log：${lines.length} 行`)

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* not ready */
    }
    await sleep(500)
  }
  throw new Error('未找到 CDP 页面目标')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 30000)
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(`页面脚本报错: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result?.value
  }
}

let failures = 0
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`)
  if (!ok) failures++
}

const target = await findPageTarget()
const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await sleep(800)

// A. 预置主机指向假 SSH
const setup = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 统计主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 统计主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  return { ok: true, profileId: p.id }
})()`)
check('预置测试主机', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

// B. 连接主机
const connected = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 统计主机'))
    if (item) { item.querySelector('.icon-btn').click(); break }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) return { ok: true }
  }
  return { ok: false, reason: '连接后终端未出现' }
})()`)
check('连接假 SSH 主机', connected?.ok === true, connected?.reason)

// C. 切到文件传输，双击 big-access.log
const opened = await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === '文件传输')
  if (!tab) return { ok: false, reason: '无文件传输标签' }
  tab.click()
  let row = null
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    row = [...document.querySelectorAll('.file-row:not(.head):not(.empty)')].find(el => el.textContent.includes('big-access.log'))
    if (row) break
  }
  if (!row) return { ok: false, reason: '文件列表未出现 big-access.log' }
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.editor-body .monaco-editor')) return { ok: true }
  }
  return { ok: false, reason: 'Monaco 编辑器未出现' }
})()`)
check('双击打开 big-access.log 编辑器', opened?.ok === true, opened?.reason)
await sleep(800)

// D. 断言编辑器统计元素出现且格式正确
const stats = await cdp.evaluate(`(() => {
  const el = document.querySelector('.editor-stats')
  return { ok: Boolean(el), text: el ? el.textContent.trim() : '(无 .editor-stats)' }
})()`)
check('编辑器工具栏出现统计元素', stats?.ok === true && /行/.test(stats?.text ?? ''), stats?.text)

// 期望：5000 行 → 5000.0 行？ 实际逻辑 lines 显示 formatCount(stats.lines)
// big-access.log 为 5000 行 + 末尾换行 → split 后 5001 行
// 字数 = LOG_TEXT.length（约 5000*~90 ≈ 450K → 显示成 4xx.xK）
const expectedLines = '5.0K 行'
const lineTotal = 5001
const lineShown = (lineTotal / 1000).toFixed(1) + 'K'
const expectedLineText = `${lineShown} 行`
check('统计显示行数(K)', stats?.ok === true && (stats.text ?? '').includes(expectedLineText), `${stats?.text} (期望含 ${expectedLineText})`)

// 字数：LOG_TEXT.length 应为 45x K 量级 → 显示 4xx.xK 字
const expectedCharText = '字'
check('统计显示字数', stats?.ok === true && /[K] 字/.test(stats?.text ?? ''), stats?.text)

// E. 校验数字与远端真实文件一致（行数与字节长度）
const realChars = LOG_TEXT.length
const realLines = LOG_TEXT.split('\n').length
const fmt = (v) => (v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M' : v >= 1_000 ? (v / 1_000).toFixed(1) + 'K' : String(v))
const expectedText = `${fmt(realLines)} 行 · ${fmt(realChars)} 字`
check('统计与真实文件一致', stats?.ok === true && (stats.text ?? '').includes(expectedText), `期望 "${expectedText}"，实际 "${stats?.text}"`)

console.log(failures === 0 ? '\n=== 编辑器统计验证：全部通过 ===' : `\n=== 编辑器统计验证：${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)