/**
 * 端到端验证：文件编辑器搜索（Ctrl+F / 工具栏搜索框）。
 * 输入关键词 → 高亮命中、计数显示、上一处/下一处跳转。
 *
 * 前置：已运行 `npm run test:env`，并以隔离数据目录启动应用：
 *   node scripts/launch-ui-app.mjs --remote-debugging-port=9333
 *
 * 用法：node scripts/verify-editor-search.mjs <cdpPort> <sshPort> <remoteRoot>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [cdpPort, sshPort, remoteRootArg] = process.argv.slice(2)
if (!cdpPort || !sshPort) {
  console.error('usage: node scripts/verify-editor-search.mjs <cdpPort> <sshPort> [remoteRoot]')
  process.exit(2)
}
const remoteRoot = remoteRootArg ?? path.join(os.tmpdir(), 'sshelper-ui-remote')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 预置一个含重复关键词的文件
const LOG_PATH = path.join(remoteRoot, 'searchable.conf')
const lines = []
for (let i = 0; i < 10; i++) lines.push(`worker_processes ${i};`)
for (let i = 0; i < 7; i++) lines.push(`error_log /var/log/nginx/error_${i}.log;`)
lines.push('# no matches here ----')
for (let i = 0; i < 5; i++) lines.push(`include /etc/nginx/conf.d/*.conf;`)
const LOG_TEXT = lines.join('\n') + '\n'
fs.writeFileSync(LOG_PATH, LOG_TEXT, 'utf8')
console.log(`[1] 已预置 searchable.conf：worker 出现 10 次，include 出现 5 次`)

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

// A. 预置主机
const setup = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 搜索主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 搜索主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  return { ok: true }
})()`)
check('预置测试主机', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

// B. 连接主机
const connected = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 搜索主机'))
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

// C. 双击打开 searchable.conf
const opened = await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === '文件传输')
  if (!tab) return { ok: false, reason: '无文件传输标签' }
  tab.click()
  let row = null
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    row = [...document.querySelectorAll('.file-row:not(.head):not(.empty)')].find(el => el.textContent.includes('searchable.conf'))
    if (row) break
  }
  if (!row) return { ok: false, reason: '列表未出现 searchable.conf' }
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.editor-body .monaco-editor')) return { ok: true }
  }
  return { ok: false, reason: 'Monaco 编辑器未出现' }
})()`)
check('双击打开 searchable.conf', opened?.ok === true, opened?.reason)
await sleep(500)

// D. 点「搜索」按钮唤起搜索框，输入 "worker"，计数应显示 10
const searchOpened = await cdp.evaluate(`(async () => {
  const btn = [...document.querySelectorAll('.editor-toolbar .btn')].find(b => b.textContent.trim() === '搜索')
  if (!btn) return { ok: false, reason: '无搜索按钮' }
  btn.click()
  await new Promise(r => setTimeout(r, 200))
  const input = document.querySelector('.editor-search-input')
  if (!input) return { ok: false, reason: '搜索框未出现' }
  return { ok: true }
})()`)
check('点击搜索按钮弹出搜索框', searchOpened?.ok === true, searchOpened?.reason)

const countText = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.editor-search-input')
  // 模拟真实输入（触发 React onChange）
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'worker')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const count = document.querySelector('.editor-search-count')
  return count ? count.textContent.trim() : '(无计数)'
})()`)
check('输入 worker 计数显示 1/10', countText === '1/10', countText)

// E. 编辑器应已有选中/跳转：直接读 Monaco 选中文本作为跳转成功的依据
const sel = await cdp.evaluate(`(() => {
  const ed = window.__sshHelperEditor
  if (!ed) return '(无编辑器)'
  const s = ed.getSelection()
  return s ? ed.getModel().getValueInRange(s) : '(无选区)'
})()`)
check('搜索后当前命中被选中', sel === 'worker', sel)

// F. 点下一处，计数应变 2/10
const next = await cdp.evaluate(`(async () => {
  const btns = [...document.querySelectorAll('.editor-search .btn')]
  const nextBtn = btns.find(b => b.title.includes('下一处'))
  if (!nextBtn) return { ok: false, reason: '无下一处按钮' }
  nextBtn.click()
  await new Promise(r => setTimeout(r, 300))
  const count = document.querySelector('.editor-search-count')
  return count ? count.textContent.trim() : '(无计数)'
})()`)
check('点击下一处计数显示 2/10', next === '2/10', next)

// G. 再点上一处，应回到 1/10（循环）
const prev = await cdp.evaluate(`(async () => {
  const btns = [...document.querySelectorAll('.editor-search .btn')]
  const prevBtn = btns.find(b => b.title.includes('上一处'))
  if (!prevBtn) return { ok: false, reason: '无上一处按钮' }
  prevBtn.click()
  await new Promise(r => setTimeout(r, 300))
  const count = document.querySelector('.editor-search-count')
  return count ? count.textContent.trim() : '(无计数)'
})()`)
check('点击上一处计数回到 1/10', prev === '1/10', prev)

// H. 换个词 "include"（5 次），计数应变 1/5
const inc = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.editor-search-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'include')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 400))
  const count = document.querySelector('.editor-search-count')
  return count ? count.textContent.trim() : '(无计数)'
})()`)
check('换词 include 计数显示 1/5', inc === '1/5', inc)

// I. 输入无匹配词，计数显示 0
const zero = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.editor-search-input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'zzz-not-found')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 300))
  const count = document.querySelector('.editor-search-count')
  return count ? count.textContent.trim() : '(无计数)'
})()`)
check('无匹配词计数显示 0', zero === '0', zero)

// J. 关闭搜索
const closed = await cdp.evaluate(`(async () => {
  const btns = [...document.querySelectorAll('.editor-search .btn')]
  const closeBtn = btns.find(b => b.title.includes('关闭'))
  if (!closeBtn) return { ok: false, reason: '无关闭按钮' }
  closeBtn.click()
  await new Promise(r => setTimeout(r, 200))
  return { ok: !document.querySelector('.editor-search') }
})()`)
check('点击关闭隐藏搜索框', closed?.ok === true, closed?.reason)

console.log(failures === 0 ? '\n=== 编辑器搜索验证：全部通过 ===' : `\n=== 编辑器搜索验证：${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)