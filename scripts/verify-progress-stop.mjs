/**
 * 验证「长时命令实时进度 + 停止执行按钮」：
 *  - mock AI 在收到「长任务」后返回 run-forever（永不结束、持续输出）。
 *  - run-forever 是 risky，进入待确认卡片；点「执行」后进入 running，
 *    卡片应出现实时输出(.cmd-live)与「⏹ 停止」按钮。
 *  - 点「停止」后命令被中断。
 *
 * 前置：已运行 `npm run test:env` 与 `node scripts/launch-ui-app.mjs --remote-debugging-port=9333`
 * 用法：node scripts/verify-progress-stop.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-progress-stop.mjs <cdpPort> <sshPort> <aiBaseUrl>')
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) } }, 60000)
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
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 进度主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 进度主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', autoApproveSafeCommands: true, autoApproveModifyCommands: false, autoSubmitCommandResults: false })
  await api.ai.setApiKey('sk-ui-test-key')
  return { ok: true }
})()`)
check('预置测试主机与 AI 配置', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

const connect = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 进度主机'))
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

// 发送「长任务」触发 run-forever
const cardInfo = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '长任务')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  // 等 run-forever 卡片出现
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    const cards = [...document.querySelectorAll('.cmd-card')]
    const target = cards.find(c => (c.querySelector('.cmd-text') || {}).textContent === 'run-forever')
    if (target) return { ok: true, cls: target.className, execBtn: Boolean([...target.querySelectorAll('.cmd-actions button')].find(b => b.textContent.trim() === '执行')) }
  }
  return { ok: false, reason: 'run-forever 卡片未出现' }
})()`)
check('出现 run-forever 待确认卡片(含执行按钮)', cardInfo?.ok === true && cardInfo?.execBtn, JSON.stringify(cardInfo))

// 点「执行」→ 进入 running，应出现实时输出与「停止」按钮
const running = await cdp.evaluate(`(async () => {
  const cards = Array.from(document.querySelectorAll('.cmd-card'))
  const target = cards.find(c => (c.querySelector('.cmd-text') || {}).textContent === 'run-forever')
  if (!target) return { ok: false, reason: '未找到 run-forever 卡片' }
  Array.from(target.querySelectorAll('.cmd-actions button')).find(b => b.textContent.trim() === '执行').click()
  let hasLive = false
  let hasStop = false
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 300))
    const again = Array.from(document.querySelectorAll('.cmd-card')).find(c => (c.querySelector('.cmd-text') || {}).textContent === 'run-forever')
    if (!again) continue
    hasStop = Array.from(again.querySelectorAll('.cmd-actions button')).some(b => b.textContent.trim().includes('停止'))
    const live = again.querySelector('.cmd-live')
    if (live) hasLive = (live.textContent || '').length > 0
    if (hasStop && hasLive) {
      const liveText = (again.querySelector('.cmd-live') || {}).textContent || ''
      return { ok: true, liveLen: liveText.length, liveStart: liveText.slice(0, 30), running: again.className.includes('running') }
    }
  }
  return { ok: false, reason: '执行后未见实时输出或停止按钮', hasLive, hasStop }
})()`)
check('执行后卡片显示实时进度输出(.cmd-live)', running?.ok === true && running?.liveLen > 0, JSON.stringify(running))
check('执行中卡片出现「停止」按钮', running?.ok === true, '')

// 自动滚动：随时间累积输出，实时框应自动滚动到最底部（scrollTop≈scrollHeight-可视高，即跟随最新内容）
const autoscroll = await cdp.evaluate(`(async () => {
  let best = null
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300))
    const live = Array.from(document.querySelectorAll('.cmd-live'))[0]
    if (!live) continue
    const st = live.scrollTop
    const sh = live.scrollHeight
    const ch = live.clientHeight
    // 到底判定：可视高阈值 1~2px 内视为已滚到底
    const atBottom = sh - ch - st <= 2
    if (sh > ch) { // 至少出现可滚动内容才判定
      best = { st, sh, ch, atBottom, textLen: (live.textContent || '').length }
      if (atBottom) return { ok: true, st, sh, ch, textLen: best.textLen }
    }
  }
  return { ok: best ? best.atBottom : false, ...(best || {}) }
})()`)
check('实时输出自动滚动到底部(无需手动拖)', autoscroll?.ok === true, JSON.stringify(autoscroll))

// 点「停止」→ 命令被中断，卡片必须脱离 running：停止按钮消失、「执行中…」消失、状态转 done
const stopped = await cdp.evaluate(`(async () => {
  const cards = Array.from(document.querySelectorAll('.cmd-card'))
  const target = cards.find(c => (c.querySelector('.cmd-text') || {}).textContent === 'run-forever')
  const btn = Array.from(target.querySelectorAll('.cmd-actions button')).find(b => b.textContent.trim().includes('停止'))
  if (!btn) return { ok: false, reason: '未找到停止按钮' }
  btn.click()
  let cls = ''
  let hasStop = true
  let runningText = false
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    const again = Array.from(document.querySelectorAll('.cmd-card')).find(c => (c.querySelector('.cmd-text') || {}).textContent === 'run-forever')
    if (!again) { cls = '(卡片消失)'; break }
    cls = again.className
    hasStop = Array.from(again.querySelectorAll('.cmd-actions button')).some(b => b.textContent.trim().includes('停止'))
    runningText = (again.textContent || '').includes('执行中')
    if (cls.includes('done') && !hasStop && !runningText) {
      return { ok: true, cls, hasStop, runningText }
    }
  }
  return { ok: false, reason: '停止后卡片未脱离「执行中」状态', cls, hasStop, runningText }
})()`)
check('点击「停止」后命令被停止(停止按钮消失、不再显示执行中)', stopped?.ok === true, JSON.stringify(stopped))

console.log(failures === 0 ? '\n=== 进度+停止诊断：通过 ===' : `\n=== 进度+停止诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)