/**
 * 验证「AI 处理中 + 等待时间」指示：
 *  - mock AI 收到含「慢速」的消息时，先静默 4 秒再开始流式返回。
 *  - 这段等待期应显示 `.ai-processing`（动画 spinner + 标签 + 等待秒数）。
 *  - 等待秒数应随 tick 递增，随后进入流式文本（`.chat-msg.streaming`）。
 *
 * 用法：node scripts/verify-ai-processing.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-ai-processing.mjs <cdpPort> <sshPort> <aiBaseUrl>')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('未找到 CDP 页面')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('CDP 超时 ' + method)) } }, 60000)
  })
  await send('Runtime.enable')
  await send('Page.enable')
  return {
    eval: async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error('页面报错: ' + JSON.stringify(r.exceptionDetails))
      return r.result?.value
    }
  }
}

let failures = 0
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`)
  if (!ok) failures++
}

const cdp = await connect()
await sleep(800)

const setup = await cdp.eval(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'AI 处理测试机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'AI 处理测试机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', autoApproveSafeCommands: true, autoApproveModifyCommands: false, autoSubmitCommandResults: false })
  await api.ai.setApiKey('sk-ui-test-key')
  return { ok: true }
})()`)
check('预置测试主机与 AI', setup?.ok === true)

// 配置与主机都是外部改的，重载页面让应用重新挂载、拉取最新配置与主机列表
await cdp.eval(`(async () => { location.reload(); return true })()`)
await sleep(2500)

const connectHost = await cdp.eval(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = Array.from(document.querySelectorAll('.host-item')).find(el => el.textContent.includes('AI 处理测试机'))
    if (item) { item.querySelector('.icon-btn').click(); break }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) return { ok: true }
    if (document.querySelector('.host-item.connected')) return { ok: true }
  }
  return { ok: false, reason: '未连接' }
})()`)

await cdp.eval(`(async () => {
  const tab = Array.from(document.querySelectorAll('.tab')).find(t => t.textContent.trim() === 'AI 运维')
  if (tab) tab.click()
  // 等待 AI 面板渲染出输入框
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (document.querySelector('.chat-input')) return true
  }
  return true
})()`)

// 发送「慢速」提问
await cdp.eval(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '慢速回复一下')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = Array.from(document.querySelectorAll('.chat-input button')).find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click()
  return true
})()`)

// 等待处理中指示出现，记录等待秒数是否递增
const processing = await cdp.eval(`(async () => {
  let firstWait = null
  let secondWait = null
  // 最多等 6 秒，观察指示器出现且等待时间递增
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 300))
    const el = document.querySelector('.ai-processing')
    if (el) {
      const waitEl = el.querySelector('.ai-wait-time')
      const t = (waitEl ? waitEl.textContent || '' : '').trim()
      if (!el.querySelector('.ai-spinner')) return { ok: false, reason: '未找到动画 spinner', t }
      firstWait = t
      if (secondWait === null) secondWait = t
      break
    }
  }
  if (!firstWait) return { ok: false, reason: '.ai-processing 未出现' }
  // 再等 1.5 秒，看秒数是否变化（递增）
  await new Promise(r => setTimeout(r, 1500))
  const el2 = document.querySelector('.ai-processing')
  const waitEl2 = el2 ? el2.querySelector('.ai-wait-time') : null
  const t2 = waitEl2 ? (waitEl2.textContent || '').trim() : ''
  const label = el2 ? el2.querySelector('.ai-processing-label').textContent : ''
  return { ok: true, t1: firstWait, t2, label, changed: t2 !== firstWait }
})()`)
check('提交后出现「AI 处理中」指示(含动画)', processing?.ok === true && processing?.changed === false ? processing.ok === true : processing.ok === true, JSON.stringify(processing))
check('等待时间随 tick 递增', processing?.ok === true && processing?.changed === true, JSON.stringify(processing))

// 等 mock 4 秒静默结束、进入流式，确认指示器被流式文本替换
const streamed = await cdp.eval(`(async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300))
    const stream = document.querySelector('.chat-msg.streaming')
    if (stream && !stream.querySelector('.ai-processing')) {
      const txt = (stream.textContent || '').trim()
      return { ok: true, hasText: txt.length > 0 }
    }
  }
  return { ok: false, reason: '未见流式文本或处理指示未消失' }
})()`)
check('首字到达后台指示消失、显示流式回复', streamed?.ok === true, JSON.stringify(streamed))

// ---------- 取消场景：发送慢速提问，点「取消」应立刻中止，指示消失 ----------
const cancelled = await cdp.eval(`(async () => {
  let armed = false
  // 带重试地提交第二条消息，直到「AI 处理中」指示出现
  for (let attempt = 0; attempt < 3 && !armed; attempt++) {
    const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '慢速再来一次')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const sendBtn = Array.from(document.querySelectorAll('.chat-input button')).find(b => b.textContent.includes('发送'))
    if (sendBtn && !sendBtn.disabled) sendBtn.click()
    for (let i = 0; i < 15 && !document.querySelector('.ai-processing'); i++) {
      await new Promise(r => setTimeout(r, 200))
    }
    armed = !!document.querySelector('.ai-processing')
  }
  if (!armed) return { ok: false, reason: '第二条消息未能触发处理指示' }
  // 找到并点击「取消」
  const btn = document.querySelector('.ai-processing .btn')
  if (!btn || (btn.textContent || '').trim() !== '取消') return { ok: false, reason: '未找到取消按钮' }
  btn.click()
  // 点取消后：请求被中止，处理中指示应消失
  let gone = false
  let check = 0
  while (check < 25 && !gone) {
    await new Promise(r => setTimeout(r, 200))
    check++
    gone = !document.querySelector('.ai-processing')
  }
  return { ok: gone, indicatorGone: gone }
})()`)
check('点「取消」中止提问(处理中指示消失)', cancelled?.ok === true, JSON.stringify(cancelled))

console.log(failures === 0 ? '\n=== AI 处理中诊断：通过 ===' : `\n=== AI 处理中诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)