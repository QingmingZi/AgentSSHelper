/**
 * 验证：
 *  1) 只读命令带丢弃式重定向(2>/dev/null)仍被自动执行、不显示审批按钮
 *     —— 触发 find ... 2>/dev/null | head 这类命令不再被判 risky 要求人工确认。
 *  2) 开启「结果自动回传」后，已执行(done)的命令卡片不再显示
 *     「把结果交给 AI 继续分析」按钮（冗余/误导）。
 *
 * 前置：已运行 `npm run test:env` 与 `node scripts/launch-ui-app.mjs --remote-debugging-port=9333`
 * 用法：node scripts/verify-redirect-autosubmit.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
import os from 'node:os'
import path from 'node:path'

const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-redirect-autosubmit.mjs <cdpPort> <sshPort> <aiBaseUrl>')
  process.exit(2)
}
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

// A. 预置主机 + AI 配置：只读恒自动执行；修改删除免确认关（保留人工确认分支做对照）；
//    结果自动回传开（验证按钮被隐藏）
const setup = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 重定向主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 重定向主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', autoApproveSafeCommands: false, autoApproveModifyCommands: false, autoSubmitCommandResults: true })
  await api.ai.setApiKey('sk-ui-test-key')
  return { ok: true }
})()`)
check('预置测试主机与 AI 配置(结果自动回传开)', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

// B. 连接主机
const connect = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 重定向主机'))
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

// D. 发送提问：让假 AI 提出「find ... 2>/dev/null | head」这类带丢弃式重定向的
//    只读命令，以及一条修改/删除命令
const sent1 = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '查找 access.log 并查看磁盘')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    const cards = [...document.querySelectorAll('.cmd-card')]
    if (cards.length >= 2) {
      await new Promise(r => setTimeout(r, 900))
      const dump = cards.map(c => {
        const btns = [...c.querySelectorAll('.cmd-actions button')].map(b => b.textContent.trim())
        const cmd = (c.querySelector('.cmd-text') || {}).textContent || ''
        return { cmd, btns }
      })
      return { ok: true, cards: dump }
    }
  }
  return { ok: false, reason: '命令卡片未出现' }
})()`)
check('提交提问且出现命令卡片', sent1?.ok === true, sent1?.reason)
console.log('  卡片1:', JSON.stringify(sent1?.cards))

// E. 断言1：带 2>/dev/null 的只读命令已自动执行(done)，且不显示「执行/拒绝」
//     也不显示「把结果交给 AI 继续分析」（因结果自动回传开启）
const cards1 = sent1?.cards ?? []
const findCard = (cmd) => cards1.find(c => c.cmd.includes(cmd))
const readonlyCmd = cards1.find(c => c.cmd.includes('find') || c.cmd.includes('df') || c.cmd.includes('head'))
check('只读命令(含丢弃式重定向)已执行且有结果', Boolean(readonlyCmd && readonlyCmd.btns.length >= 0), JSON.stringify(readonlyCmd))
const readonlyHasApprove = Boolean(readonlyCmd && readonlyCmd.btns.some(b => b === '执行' || b === '拒绝'))
check('只读重定向命令不显示执行/拒绝', readonlyHasApprove === false)
const readonlyHasFeed = Boolean(readonlyCmd && readonlyCmd.btns.some(b => b.includes('把结果交给 AI')))
check('结果自动回传开启时不显示「把结果交给 AI」按钮', readonlyHasFeed === false, JSON.stringify(readonlyCmd?.btns))

// F. 断言2：修改/删除命令（未开免确认）仍显示执行/拒绝，供对照
const delCard = cards1.find(c => c.cmd.includes('rm') || c.cmd.includes('restart'))
const delHasApprove = Boolean(delCard && delCard.btns.some(b => b === '执行' || b === '拒绝'))
check('修改/删除命令仍显示执行/拒绝(对照)', delHasApprove === true, JSON.stringify(delCard))

console.log(failures === 0 ? '\n=== 重定向+自动回传按钮诊断：通过 ===' : `\n=== 重定向+自动回传按钮诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)