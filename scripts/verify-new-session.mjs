/**
 * 端到端验证：
 *  1) AI 回复下方的运行时指标（模型名 tokens/s 首字延迟）正常渲染；
 *  2) 「新会话」按钮清空界面对话并与服务端上下文。
 *
 * 前置：已运行 `npm run test:env`，并以隔离数据目录启动应用：
 *   node scripts/launch-ui-app.mjs --remote-debugging-port=9333
 *
 * 用法：node scripts/verify-new-session.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
import os from 'node:os'
import path from 'node:path'

const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-new-session.mjs <cdpPort> <sshPort> <aiBaseUrl>')
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

// A. 预置主机 + 配置 AI（指向假 AI 服务）
const setup = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 新会话主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'UI 新会话主机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({ enabled: true, baseUrl: ${JSON.stringify(aiBaseUrl)}, model: 'mock-sre', autoApproveSafeCommands: false, autoApproveModifyCommands: false, autoSubmitCommandResults: false })
  await api.ai.setApiKey('sk-ui-test-key')
  return { ok: true, sessionId: '' }
})()`)
check('预置测试主机与 AI 配置', setup?.ok === true)

await cdp.send('Page.reload')
await sleep(2500)

// B. 连接主机（拿到 sessionId）
const connect = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 新会话主机'))
    if (item) { item.querySelector('.icon-btn').click(); break }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) {
      const ses = (await window.sshHelper.ssh.sessions())[0]
      return { ok: true, sessionId: ses ? ses.sessionId : '' }
    }
  }
  return { ok: false, reason: '连接后终端未出现' }
})()`)
check('连接假 SSH 主机', connect?.ok === true, connect?.reason)
const sessionId = connect?.sessionId

// C. 切到 AI 运维标签
const toAI = await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  if (!tab) return { ok: false, reason: '无 AI 运维标签' }
  tab.click()
  await new Promise(r => setTimeout(r, 300))
  return { ok: true }
})()`)
check('切换到 AI 运维', toAI?.ok === true, toAI?.reason)

// D. 发送第一条消息并等待完成
const first = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  if (!input) return { ok: false, reason: '无输入框' }
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '帮我检查磁盘')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    const metrics = document.querySelector('.chat-metrics')
    const done = document.querySelector('.chat-msg.assistant:not(.streaming)')
    if (metrics && done && !document.querySelector('.chat-msg.assistant.streaming')) {
      return { ok: true, metrics: metrics.textContent.trim(), body: done.textContent.trim() }
    }
  }
  return { ok: false, reason: '超时', metrics: document.querySelector('.chat-metrics') ? document.querySelector('.chat-metrics').textContent.trim() : '(无)' }
})()`)
check('发送提问并完成回复', first?.ok === true, first?.reason)
check('指标含模型名 mock-sre', (first?.metrics ?? '').includes('mock-sre'), first?.metrics)
check('指标含首字延迟', /首字\s/.test(first?.metrics ?? ''), first?.metrics)
check('指标含 tok/s', /tok\/s/.test(first?.metrics ?? ''), first?.metrics)
check('回复含上下文消息数(首轮)', /上下文消息数：\d+/.test(first?.body ?? ''), first?.body?.slice(0, 40))

// E. 再发一条消息，历史应累积（上下文消息数更大）
const second = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '再看下 Nginx')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (!document.querySelector('.chat-msg.assistant.streaming')) {
      const msgs = [...document.querySelectorAll('.chat-msg.assistant:not(.streaming) .chat-body')].map(e => e.textContent)
      const last = msgs[msgs.length - 1] || ''
      const turnNums = [...document.querySelectorAll('.chat-msg.assistant:not(.streaming)')].map(e => {
        const m = e.textContent.match(/【?上下文消息数[：:]?\\s*(\\d+)】?/)
        return m ? Number(m[1]) : -1
      }).filter(n => n >= 0)
      return { ok: true, last: last.slice(0, 50), allNums: turnNums }
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return { ok: false, reason: '第二轮超时' }
})()`)
check('第二轮回复完成', second?.ok === true, second?.reason)
const nums = (second?.allNums ?? [])
const grew = nums.length >= 2 && nums[nums.length - 1] > nums[nums.length - 2]
check('多轮历史已累积(上下文消息数增大)', grew, JSON.stringify(nums))

// F. 点击「新会话」
const clickNew = await cdp.evaluate(`(async () => {
  const btn = [...document.querySelectorAll('.ai-pane .pane-toolbar .btn')].find(b => b.textContent.trim() === '新会话')
  if (!btn) return { ok: false, reason: '无新会话按钮' }
  btn.click()
  await new Promise(r => setTimeout(r, 600))
  return { ok: true }
})()`)
check('点击新会话按钮', clickNew?.ok === true, clickNew?.reason)

// G. 新会话后界面对话应被清空（回到空状态）
const cleared = await cdp.evaluate(`(async () => {
  await new Promise(r => setTimeout(r, 400))
  const chatMsgs = document.querySelectorAll('.chat-msg').length
  const empty = document.querySelector('.empty-state')
  return { ok: chatMsgs === 0 && Boolean(empty), chatMsgs }
})()`)
check('新会话后对话被清空', cleared?.ok === true, `消息数=${cleared?.chatMsgs}`)

// H. 新会话后再发一条，上下文应从第 1 条系统约束重新计数（消息数为 1）
const fresh = await cdp.evaluate(`(async () => {
  const input = document.querySelector('.chat-input textarea') || document.querySelector('.chat-input input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '新会话后的第一条')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const sendBtn = [...document.querySelectorAll('.chat-input button')].find(b => b.textContent.includes('发送'))
  if (sendBtn) sendBtn.click(); else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (!document.querySelector('.chat-msg.assistant.streaming')) {
      const last = [...document.querySelectorAll('.chat-msg.assistant:not(.streaming)')].pop()
      const txt = last ? last.textContent : ''
      const m = txt.match(/上下文消息数[：:](\\d+)/)
      return { ok: true, num: m ? Number(m[1]) : -1, snippet: txt.slice(0, 40) }
    }
  }
  return { ok: false, reason: '新会话首轮超时' }
})()`)
check('新会话后上下文重置(回到初始2条)', fresh?.ok === true && fresh?.num === 2, `num=${fresh?.num} ${fresh?.snippet}`)
// 组合证据：新会话前历史已累积（峰值>2），新会话后回到 2（system+user）
const peak = Math.max(2, ...(nums.length ? nums : [2]))
check('对比：新会话后历史明显小于新会话前', fresh?.num === 2 && peak > 2, `peak=${peak} fresh=${fresh?.num}`)

console.log(failures === 0 ? '\n=== 新会话 + 指标验证：全部通过 ===' : `\n=== 新会话 + 指标验证：${failures} 项失败 ===`)
process.exit(failures === 0 ? 0 : 1)