/**
 * 验证「多步命令只自动执行第一条」：
 *  mock AI 返回 5 条命令：df -h / df -h | sort / systemctl status nginx / rm -rf / systemctl restart
 *  预期：只有第一条 df -h 自动执行(done、无审批按钮)；
 *        其余 4 条均为待确认(pending)，显示「执行/拒绝」按钮（即不再自动执行）。
 *
 * 前置：已运行 `npm run test:env` 与 `node scripts/launch-ui-app.mjs --remote-debugging-port=9333`
 * 用法：node scripts/verify-single-step.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-single-step.mjs <cdpPort> <sshPort> <aiBaseUrl>')
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

const setup = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 单步主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 单步主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', autoApproveSafeCommands: true, autoApproveModifyCommands: false, autoSubmitCommandResults: false })
  await api.ai.setApiKey('sk-ui-test-key')
  return { ok: true }
})()`)
check('预置测试主机与 AI 配置(自动只读开启)', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

const connect = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 单步主机'))
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

await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  if (tab) tab.click()
  await new Promise(r => setTimeout(r, 300))
  return { ok: true }
})()`)

const sent = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '检查磁盘与内存')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    const cards = Array.from(document.querySelectorAll('.cmd-card'))
    if (cards.length >= 1) {
      await new Promise(r => setTimeout(r, 900))
      const dump = cards.map(c => {
        const risk = (c.querySelector('.risk-tag') || {}).textContent || ''
        const cmd = (c.querySelector('.cmd-text') || {}).textContent || ''
        const cls = c.className
        const hasExec = Array.from(c.querySelectorAll('.cmd-actions button')).some(b => b.textContent.trim() === '执行')
        const hasOutput = !!c.querySelector('.cmd-output')
        return { cmd, risk, cls, hasExec, hasOutput }
      })
      return { ok: true, cards: dump }
    }
  }
  const still = Array.from(document.querySelectorAll('.cmd-card')).length
  return { ok: false, reason: '命令卡片不足, 现有=' + still }
})()`)
check('提交提问且出现命令卡片', sent?.ok === true, sent?.reason)
console.log('  卡片:', JSON.stringify(sent?.cards))

const cards = sent?.cards ?? []
// 只有第一条 df -h 出现：应自动执行(done)→ 无执行按钮、有输出
const first = cards.find(c => c.cmd === 'df -h')
check('第一条 df -h 自动执行(done,无执行按钮)', Boolean(first && !first.hasExec && first.hasOutput), JSON.stringify(first))
// 「每轮最多一条命令」：其余后续命令一律被丢弃、完全不显示卡片
const second = cards.find(c => c.cmd === 'df -h | sort -k5 -h')
check('第二条命令不显示(被丢弃)', second === undefined, JSON.stringify(second ?? '未找到→正确'))
const del = cards.find(c => c.cmd.includes('rm -rf'))
check('删除类后续命令不显示(被丢弃)', del === undefined, JSON.stringify(del ?? '未找到→正确'))
const totalCards = cards.length
check('界面仅保留一条命令卡片', totalCards === 1, `卡片数=${totalCards}`)

console.log(failures === 0 ? '\n=== 单步执行诊断：通过 ===' : `\n=== 单步执行诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)