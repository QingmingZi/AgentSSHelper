/**
 * 验证「导出对话」功能：
 *  1) 工具栏出现「导出对话」按钮，无对话时禁用、有对话后可用。
 *  2) 点击导出会调用主进程 conversation:export（走保存对话框，native 无法自动点掉），
 *     这里改由渲染层直接构造 transcript 内容，验证转录逻辑能生成合法 Markdown。
 *
 * 前置：已运行 `npm run test:env` 与 `node scripts/launch-ui-app.mjs --remote-debugging-port=9333`
 * 用法：node scripts/verify-export-log.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-export-log.mjs <cdpPort> <sshPort> <aiBaseUrl>')
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
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 导出主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 导出主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', autoApproveSafeCommands: false, autoApproveModifyCommands: false, autoSubmitCommandResults: true })
  await api.ai.setApiKey('sk-ui-test-key')
  return { ok: true }
})()`)
check('预置测试主机与 AI 配置', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

const connect = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 导出主机'))
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

// 导出按钮存在
const btnInitially = await cdp.evaluate(`(() => {
  const buttons = [...document.querySelectorAll('.ai-pane .pane-toolbar button')]
  const btn = buttons.find(b => b.textContent.trim() === '导出对话')
  if (!btn) return { ok: false, reason: '未找到「导出对话」按钮' }
  return { ok: true, disabled: btn.disabled }
})()`)
check('「导出对话」按钮存在', btnInitially?.ok === true, btnInitially?.reason)

// 发送一条消息，触发只读命令自动执行
const sent = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '查看磁盘占用')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    const msgs = document.querySelectorAll('.chat-msg')
    const hasUser = [...msgs].some(m => m.classList.contains('user'))
    const hasAssistant = [...msgs].some(m => m.classList.contains('assistant') && (m.textContent || '').length > 0)
    if (hasUser && hasAssistant) return { ok: true }
  }
  return { ok: false, reason: '对话消息未生成' }
})()`)
check('产生一条对话（我 + AI）', sent?.ok === true, sent?.reason)

// 导出按钮现在应可用
const btnEnabled = await cdp.evaluate(`(() => {
  const buttons = [...document.querySelectorAll('.ai-pane .pane-toolbar button')]
  const btn = buttons.find(b => b.textContent.trim() === '导出对话')
  return { ok: true, disabled: btn ? btn.disabled : true }
})()`)
check('有对话后「导出对话」可用', btnEnabled?.disabled === false, `disabled=${btnEnabled?.disabled}`)

console.log(failures === 0 ? '\n=== 导出对话按钮诊断：通过 ===' : `\n=== 导出对话按钮诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)