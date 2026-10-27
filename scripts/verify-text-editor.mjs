/**
 * 端到端验证：远程文本文件「直接打开 → Monaco 编辑 → 保存自动回传」。
 *
 * 前置：已运行 `npm run test:env`（假 SSH + 假 AI），并以隔离数据目录启动应用：
 *   node scripts/launch-ui-app.mjs --remote-debugging-port=9333
 *
 * 用法：node scripts/verify-text-editor.mjs <cdpPort> <sshPort> <aiBaseUrl> <remoteRoot>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [cdpPort, sshPort, aiBaseUrl, remoteRootArg] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-text-editor.mjs <cdpPort> <sshPort> <aiBaseUrl> [remoteRoot]')
  process.exit(2)
}
const remoteRoot = remoteRootArg ?? path.join(os.tmpdir(), 'sshelper-ui-remote')
const confPath = path.join(remoteRoot, 'nginx.conf')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 备份 / 改写远程文本文件，验证「读原值 → 改 → 写回」
const ORIGINAL = fs.readFileSync(confPath, 'utf8')
const MARK = 'edited-by-ui-test'
const NEW_CONTENT = ORIGINAL + `\n# ${MARK} ${Date.now()}\n`
fs.writeFileSync(confPath, NEW_CONTENT, 'utf8')
console.log('[1] 远程 nginx.conf 已预置新内容（含标记）')

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* CDP 未就绪 */
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
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 测试主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({
    label: 'UI 测试主机',
    host: '127.0.0.1',
    port: ${Number(sshPort)},
    username: 'tester',
    authType: 'password'
  })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  return { ok: true, profileId: p.id }
})()`)
check('预置测试主机', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

// B. 连接主机
const connected = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 测试主机'))
    if (item) {
      const btn = item.querySelector('.icon-btn')
      btn.click()
      break
    }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) return { ok: true }
  }
  return { ok: false, reason: '连接后终端未出现' }
})()`)
check('连接假 SSH 主机', connected?.ok === true, connected?.reason)

// C. 切到文件传输，找到并双击 nginx.conf
const opened = await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === '文件传输')
  if (!tab) return { ok: false, reason: '无文件传输标签' }
  tab.click()
  // 等文件列表
  let row = null
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    row = [...document.querySelectorAll('.file-row:not(.head):not(.empty)')]
      .find(el => el.textContent.includes('nginx.conf'))
    if (row) break
  }
  if (!row) return { ok: false, reason: '文件列表未出现 nginx.conf' }
  row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  // 等 Monaco 编辑器出现
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.editor-body .monaco-editor')) return { ok: true }
  }
  return { ok: false, reason: 'Monaco 编辑器未出现' }
})()`)
check('双击打开 Monaco 编辑器', opened?.ok === true, opened?.reason)
await sleep(600)

// D. 断言编辑器加载了远端内容
const loadedContent = await cdp.evaluate(`(() => {
  const ed = window.__sshHelperEditor
  if (!ed) return { ok: false, reason: 'window.__sshHelperEditor 不存在' }
  return { ok: true, content: ed.getValue() }
})()`)
check('编辑器加载远端内容', loadedContent?.ok === true && String(loadedContent.content).includes(MARK), loadedContent?.content?.slice(0, 60))

// E. 修改内容（等价真实编辑），保存按钮应变可用
const mutated = await cdp.evaluate(`(async () => {
  const ed = window.__sshHelperEditor
  ed.setValue(ed.getValue() + '\\n# append-line-after-ui-edit\\n')
  // 等 React 提交 dirty 状态，保存按钮解除禁用
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 100))
    const btn = [...document.querySelectorAll('.editor-toolbar .btn')].find(b => b.textContent.includes('保存'))
    if (btn && !btn.disabled) return { ok: true, disabled: btn.disabled }
  }
  return { ok: false, reason: '保存按钮未变为可用' }
})()`)
check('编辑后保存按钮可用', mutated?.ok === true, mutated?.reason)

// F. 点保存，等状态变为「已保存」
const savedUi = await cdp.evaluate(`(async () => {
  const btn = [...document.querySelectorAll('.editor-toolbar .btn')].find(b => b.textContent.includes('保存'))
  btn.click()
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    const status = document.querySelector('.editor-status')
    if (status && status.textContent.includes('已保存')) return { ok: true, status: status.textContent }
  }
  const status = document.querySelector('.editor-status')
  return { ok: false, status: status ? status.textContent : '(无状态元素)' }
})()`)
check('点击保存后状态为「已保存」', savedUi?.ok === true, savedUi?.status)
await sleep(600)

// G. 断言远端文件真正被更新（保存自动回传）
const onDisk = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : ''
check('远端文件已收到编辑内容', onDisk.includes('append-line-after-ui-edit'), onDisk.slice(-80))

// H. 保存后按钮回到禁用（不再 dirty）
const savedClean = await cdp.evaluate(`(() => {
  const btn = [...document.querySelectorAll('.editor-toolbar .btn')].find(b => b.textContent.includes('保存'))
  return { ok: Boolean(btn && btn.disabled) }
})()`)
check('保存后按钮回到禁用状态', savedClean?.ok === true)

console.log(failures === 0 ? '\n=== 编辑器端到端验证：全部通过 ===' : `\n=== 编辑器端到端验证：${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)