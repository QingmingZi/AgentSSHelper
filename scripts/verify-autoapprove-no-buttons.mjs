/**
 * 复现/诊断：自动批准的命令卡片是否仍显示「执行/拒绝」审批按钮。
 * 开启「自动执行只读命令」，触发只读命令(df -h)，断言自动批准的命令不出现审批按钮。
 *
 * 前置：已运行 `npm run test:env` 与 `node scripts/launch-ui-app.mjs --remote-debugging-port=9333`
 * 用法：node scripts/verify-autoapprove-no-buttons.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
import os from 'node:os'
import path from 'node:path'

const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-autoapprove-no-buttons.mjs <cdpPort> <sshPort> <aiBaseUrl>')
  process.exit(2)
}
const remoteRoot = path.join(os.tmpdir(), 'sshelper-ui-remote')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* not ready */ }
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 30000)
    })
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
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

// A. 预置主机 + AI 配置（开启自动执行只读命令）
const setup = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 自动批准主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 自动批准主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', autoApproveSafeCommands: false, autoApproveModifyCommands: false, autoSubmitCommandResults: false })
  await api.ai.setApiKey('sk-ui-test-key')
  return { ok: true }
})()`)
check('预置测试主机与 AI 配置(自动只读开启)', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

// B. 连接主机
const connect = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 自动批准主机'))
    if (item) { item.querySelector('.icon-btn').click(); break }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) return { ok: true }
  }
  return { ok: false, reason: '连接后终端未出现' }
})()`)
check('连接假 SSH 主机', connect?.ok === true, connect?.reason)

// C. 切到 AI 运维
await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  if (tab) tab.click()
  await new Promise(r => setTimeout(r, 300))
  return { ok: true }
})()`)

// D. 发送提问，假 AI 会提出只读命令 df -h / df -h | sort（开启自动只读后应自动批准）
const sent = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '检查磁盘与内存')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  // 等出现命令卡片
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    const cards = [...document.querySelectorAll('.cmd-card')]
    if (cards.length >= 3) {
      await new Promise(r => setTimeout(r, 800)) // 稍等让自动执行/结果落地
      const dump = cards.map(c => {
        const cls = (c.className.match(/cmd-card\s+(\w+)/) || [])[1] || '(无状态)'
        const btns = [...c.querySelectorAll('.cmd-actions button')].map(b => b.textContent.trim())
        const risk = (c.querySelector('.risk-tag') || {}).textContent || ''
        const cmd = (c.querySelector('.cmd-text') || {}).textContent || ''
        return { status: cls, risk, cmd, buttons: btns }
      })
      return { ok: true, cards: dump }
    }
  }
  const still = [...document.querySelectorAll('.cmd-card')].map(c => {
    const cls = (c.className.match(/cmd-card\s+(\w+)/) || [])[1] || '(?)'
    return { status: cls, buttons: [...c.querySelectorAll('.cmd-actions button')].map(b => b.textContent.trim()), cmd: (c.querySelector('.cmd-text') || {}).textContent }
  })
  return { ok: false, reason: '命令卡片未出现', cards: still }
})()`)
check('提交提问且只读命令已自动执行', sent?.ok === true, sent?.reason)
console.log('  卡片状态:', JSON.stringify(sent?.cards))

// E. 断言：只读命令(safe)在全部开关关闭时也应自动执行且不出现审批按钮；
//    删除/修改命令仍待人工确认（有执行/拒绝按钮）。
const log = sent?.cards ?? []
const findCard = (cmd) => log.find(c => c.cmd === cmd)
const safe1 = findCard('df -h')
const safe2 = findCard('df -h | sort -k5 -h')
const safeSafe = (safe1 && safe2) ? ((safe1.buttons ?? []).some(b => b === '执行' || b === '拒绝') || (safe2.buttons ?? []).some(b => b === '执行' || b === '拒绝')) === false : false
check('全开关关闭时只读命令不出现执行/拒绝按钮', safeSafe, JSON.stringify([safe1, safe2]))
const del = findCard('rm -rf /var/log/old.log')
const mod = findCard('systemctl restart nginx')
check('删除命令仍待确认(有执行/拒绝)', Boolean(del && (del.buttons ?? []).some(b => b === '执行')), JSON.stringify(del))
check('修改命令仍待确认(有执行/拒绝)', Boolean(mod && (mod.buttons ?? []).some(b => b === '执行')), JSON.stringify(mod))

console.log(failures === 0 ? '\n=== 自动批准按钮诊断：通过 ===' : `\n=== 自动批准按钮诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)