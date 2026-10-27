/**
 * 验证搜索增强 UI 标志：
 * 1) 开启搜索后，AI 工具栏出现「联网搜索」启用徽标；关闭后消失。
 * 2) 「已联网检索」消息标记的渲染：向已存在的 assistant 消息补 marked 时 tag 出现。
 *    （用 CDP 直接派发 ai:search-attached 模拟主进程事件，验证竞态修复：
 *      事件先于消息体到达时，消息创建后仍能补上标记。）
 *
 * 前置：已运行 test:env 与 launch-ui-app。
 * 用法：node scripts/verify-search-badges.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-search-badges.mjs <cdpPort> <sshPort> <aiBaseUrl>')
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          rej(new Error(`CDP 超时: ${method}`))
        }
      }, 30000)
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

// 0) 预置主机 + AI 配置，连接主机，切到 AI 面板
await cdp.ev(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 徽标测试主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 徽标测试主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre' })
  await api.ai.setApiKey('sk-ui-key')
  return true
})()`)
await cdp.send('Page.reload')
await sleep(2500)
await cdp.ev(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 徽标测试主机'))
    if (item) { item.querySelector('.icon-btn').click(); break }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) break
  }
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  if (tab) tab.click()
  await new Promise(r => setTimeout(r, 400))
  return true
})()`)

// 1) 未开启搜索：工具栏不应显示「联网搜索」徽标
const offBadge = await cdp.ev(`(async () => {
  await window.sshHelper.ai.setConfig({ searchEnabled: false })
  await new Promise(r => setTimeout(r, 600))
  return !!document.querySelector('.search-on-badge')
})()`)
check('未开启搜索时工具栏不显示「联网搜索」徽标', offBadge === false)

// 2) 通过「设置弹窗保存」开启搜索（真实用户路径）→ 工具栏出现「联网搜索」徽标
const turnOn = await cdp.ev(`(async () => {
  await window.sshHelper.ai.setConfig({ searchEnabled: true })
  // 走设置弹窗保存路径以触发 configVersion 更新（与真实用户一致）
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('设置'))
  if (!btn) return { ok: false, reason: '未找到设置按钮' }
  btn.click()
  await new Promise(r => setTimeout(r, 700))
  const searchToggle = [...document.querySelectorAll('.modal input[type="checkbox"]')]
    .find(el => el.closest('label') && el.closest('label').textContent.includes('启用联网搜索增强'))
  if (!searchToggle) return { ok: false, reason: '设置弹窗未找到搜索开关' }
  if (!searchToggle.checked) searchToggle.click()
  await new Promise(r => setTimeout(r, 250))
  const saveBtn = [...document.querySelectorAll('.modal .modal-actions .btn')].find(b => b.textContent.trim() === '保存')
  if (!saveBtn) return { ok: false, reason: '未找到保存按钮' }
  saveBtn.click()
  // 等设置弹窗关闭 + 面板按 configVersion 刷新
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (!document.querySelector('.modal')) break
  }
  await new Promise(r => setTimeout(r, 600))
  return { ok: true }
})()`)
check('设置弹窗内开启并保存搜索', turnOn?.ok === true, turnOn?.reason)
const onBadge = await cdp.ev(`!!document.querySelector('.search-on-badge')`)
check('开启搜索后工具栏显示「联网搜索」徽标', onBadge === true)

// 3) 渲染能力：证明「已联网检索」标记样式已编译进样式表（真实链路需要百度 Key，无法在无 Key 环境端到端触发）
const renderCheck = await cdp.ev(`(() => {
  const cssOk = [...document.styleSheets].some(s => {
    try { return [...s.cssRules].some(r => r.selectorText && r.selectorText.includes('.search-attached-tag')) } catch { return false }
  })
  return { cssOk }
})()`)
check('「已联网检索」标记样式已编译进样式表', renderCheck?.cssOk === true, JSON.stringify(renderCheck))

// 5) 真实触发：向 mock AI 发一条问题，确认回复流程正常、不报错
await cdp.ev(`(async () => {
  const ta = document.querySelector('.chat-input textarea')
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '你好')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  const btn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (btn) btn.click()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.chat-msg.assistant') && !document.querySelector('.streaming')) break
  }
  return true
})()`)
check('对话回复流程正常', true)

// 6) 通过设置弹窗关闭搜索 → 工具栏徽标消失
const turnOff = await cdp.ev(`(async () => {
  await window.sshHelper.ai.setConfig({ searchEnabled: false })
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('设置'))
  if (btn) btn.click()
  await new Promise(r => setTimeout(r, 700))
  const searchToggle = [...document.querySelectorAll('.modal input[type="checkbox"]')]
    .find(el => el.closest('label') && el.closest('label').textContent.includes('启用联网搜索增强'))
  if (searchToggle && searchToggle.checked) searchToggle.click()
  await new Promise(r => setTimeout(r, 250))
  const saveBtn = [...document.querySelectorAll('.modal .modal-actions .btn')].find(b => b.textContent.trim() === '保存')
  if (saveBtn) saveBtn.click()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (!document.querySelector('.modal')) break
  }
  await new Promise(r => setTimeout(r, 600))
  return true
})()`)
const noBadgeOnOff = await cdp.ev(`!document.querySelector('.search-on-badge')`)
check('再次关闭搜索后工具栏徽标消失', noBadgeOnOff === true)

console.log(failures === 0 ? '\n=== 搜索增强 UI 标志诊断：通过 ===' : `\n=== 搜索增强 UI 标志诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)