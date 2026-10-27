/**
 * 端到端验证「已联网检索」消息标记 + 「联网搜索」工具栏徽标 + 配额递增。
 *
 * 依赖：本地 mock 搜索端点（scripts/mock-search-server.mjs）已跑在 17300，
 * 且应用以 SSHELPER_SEARCH_ENDPOINT 指向它启动 → 搜索会真实成功返回 references[]，
 * 从而验证整条「搜索成功 → ai:search-attached → 消息创建后补标」链路（含竞态修复）。
 *
 * 前置：已运行 test:env、mock-search-server、launch-ui-app(挂 SSHELPER_SEARCH_ENDPOINT)。
 * 用法：node scripts/verify-search-attached.mjs <cdpPort> <sshPort> <aiBaseUrl> <mockPort>
 */
const [cdpPort, sshPort, aiBaseUrl, mockPort] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl || !mockPort) {
  console.error('usage: node scripts/verify-search-attached.mjs <cdpPort> <sshPort> <aiBaseUrl> <mockPort>')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      const p = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(500)
  }
  throw new Error('未找到页面')
}
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      }
    })
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((r) => ws.addEventListener('open', r, { once: true }))
    return new Cdp(ws)
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时: ${method}`)) } }, 40000)
    })
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(`页面脚本报错: ${JSON.stringify(r.exceptionDetails)}`)
    return r.result?.value
  }
}
let failures = 0
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`)
  if (!ok) failures++
}

const target = await findPage()
const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await sleep(800)

// 0) 预置主机 + AI 配置 + 开启搜索 + 写入百度 Key（mock 环境）
await cdp.ev(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 徽标主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 徽标主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', searchEnabled: true })
  await api.ai.setApiKey('sk-ui-key')
  await api.ai.setBaiduSearchKey('mock-baidu-key')
  return true
})()`)
await cdp.send('Page.reload')
await sleep(2500)

// 连接主机 + 切到 AI 面板
await cdp.ev(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 徽标主机'))
    if (item) { item.querySelector('.icon-btn').click(); break }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) break
  }
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  if (tab) tab.click()
  await new Promise(r => setTimeout(r, 500))
  return true
})()`)

// 走设置弹窗保存搜索开关，触发 configVersion → 工具栏「联网搜索」徽标
await cdp.ev(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('设置'))
  if (btn) btn.click()
  await new Promise(r => setTimeout(r, 700))
  const searchToggle = [...document.querySelectorAll('.modal input[type="checkbox"]')]
    .find(el => el.closest('label') && el.closest('label').textContent.includes('启用联网搜索增强'))
  if (searchToggle && !searchToggle.checked) searchToggle.click()
  await new Promise(r => setTimeout(r, 250))
  const saveBtn = [...document.querySelectorAll('.modal .modal-actions .btn')].find(b => b.textContent.trim() === '保存')
  if (saveBtn) saveBtn.click()
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 200)); if (!document.querySelector('.modal')) break }
  await new Promise(r => setTimeout(r, 600))
  return true
})()`)
const badgeShown = await cdp.ev(`!!document.querySelector('.search-on-badge')`)
check('工具栏显示「联网搜索」徽标', badgeShown === true)

// 发送命中启发式的问题 → mock 搜索成功 → 注入 + 消息带「已联网检索」
const quotaBefore = await cdp.ev(`(async () => (await window.sshHelper.ai.getConfig()).searchQuota.dailyUsed)()`)

const sent = await cdp.ev(`(async () => {
  const ta = document.querySelector('.chat-input textarea')
  if (!ta) return { ok: false, reason: '输入框未找到' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '查询一下 CVE-2021-44228 的影响范围')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 250))
  const btn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (btn) btn.click()
  // 等待「已联网检索」tag 出现（异步：搜索→注入→流式→done）
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.search-attached-tag')) return { ok: true }
  }
  return { ok: false, reason: '未出现「已联网检索」标记' }
})()`)
check('命中检索的回复显示「已联网检索」标记', sent?.ok === true, sent?.reason)

// 配额应 +1
const quotaAfter = await cdp.ev(`(async () => (await window.sshHelper.ai.getConfig()).searchQuota.dailyUsed)()`)
check('搜索成功后配额今日 +1', quotaAfter === quotaBefore + 1, `today ${quotaBefore}->${quotaAfter}`)

// 发送闲聊 → 不命中 → 无标记、配额不涨
const quotaBeforeChit = await cdp.ev(`(async () => (await window.sshHelper.ai.getConfig()).searchQuota.dailyUsed)()`)
const chit = await cdp.ev(`(async () => {
  const ta = document.querySelector('.chat-input textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '你好，帮我看看这台服务器')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 250))
  const btn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (btn) btn.click()
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    // 等这条回复完成（新消息出现且不在流式）
    const turnTags = document.querySelectorAll('.chat-msg.assistant .search-attached-tag').length
    if (!document.querySelector('.streaming') && document.querySelectorAll('.chat-msg.assistant').length >= 2 && turnTags <= 1) break
  }
  await new Promise(r => setTimeout(r, 400))
  const lastHasTag = [...document.querySelectorAll('.chat-msg.assistant')].some(m => {
    const body = m.querySelector('.chat-body')?.textContent || ''
    const node = m.querySelector('.search-attached-tag')
    return node === null
  })
  return { hasFirstTagStill: document.querySelectorAll('.search-attached-tag').length }
})()`)
const quotaAfterChit = await cdp.ev(`(async () => (await window.sshHelper.ai.getConfig()).searchQuota.dailyUsed)()`)
check('闲聊不触发搜索(配额不涨)', quotaAfterChit === quotaBeforeChit, `today ${quotaBeforeChit}->${quotaAfterChit}`)
check('闲聊回复无「已联网检索」标记', (chit?.hasFirstTagStill ?? 0) === 1, JSON.stringify(chit))

// 清理：删除测试百度 Key + 关闭搜索
await cdp.ev(`(async () => {
  await window.sshHelper.ai.setBaiduSearchKey(undefined)
  await window.sshHelper.ai.setConfig({ searchEnabled: false })
  return true
})()`)

console.log(failures === 0 ? '\n=== 已联网检索/联网搜索徽标端到端：通过 ===' : `\n=== 已联网检索/联网搜索徽标端到端：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)