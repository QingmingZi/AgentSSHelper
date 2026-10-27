/**
 * 设置弹窗问题复现脚本
 *
 * 1) Ctrl+V 粘贴导致弹窗关闭（用系统级 SendKeys 模拟，能触发原生菜单加速键）
 * 2) 保存 AI 配置后，AI 运维面板仍提示「尚未配置 AI 服务」
 *
 * 用法：node scripts/repro-settings.mjs <cdpPort> <aiBaseUrl> [sshPort]
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const [cdpPort, aiBaseUrl, sshPort] = process.argv.slice(2)
if (!cdpPort || !aiBaseUrl) {
  console.error('usage: node scripts/repro-settings.mjs <cdpPort> <aiBaseUrl> [sshPort]')
  process.exit(2)
}
process.env.SSH_PORT = sshPort ?? '0'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 等 CDP */
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
    this.events = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
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
    if (result.exceptionDetails) {
      throw new Error(`页面脚本报错: ${JSON.stringify(result.exceptionDetails)}`)
    }
    return result.result?.value
  }

  drainEvents() {
    const out = this.events
    this.events = []
    return out
  }
}

const target = await findPageTarget()
const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Page.enable')
await sleep(500)

/** 统计页面导航次数，用于识别「渲染进程重载导致弹窗消失」 */
let navigations = 0
cdp.events.length = 0
const origPush = cdp.events.push.bind(cdp.events)
cdp.events.push = (msg) => {
  if (msg.method === 'Page.frameNavigated') navigations++
  return origPush(msg)
}

// 先连接一台主机，AI 运维面板才会存在
const connected = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 测试主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({
    label: 'UI 测试主机',
    host: '127.0.0.1',
    port: ${Number(process.env.SSH_PORT ?? 0)},
    username: 'tester',
    authType: 'password'
  })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  location.reload()
  return p.id
})()`)
console.log('预置主机:', connected)
await sleep(2500)
await cdp.evaluate(`(async () => {
  const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 测试主机'))
  item?.querySelector('.icon-btn')?.click()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) return true
  }
  return false
})()`)
await sleep(1500)

// ---------------------------------------------------------------- 工具

/** 打开设置弹窗并等待渲染完成 */
const openSettings = async () => {
  await cdp.evaluate(`(() => {
    [...document.querySelectorAll('.topbar-right .btn')].find(b => b.textContent.trim() === '设置')?.click()
  })()`)
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    const ok = await cdp.evaluate(`Boolean(document.querySelector('.modal'))`)
    if (ok) return true
  }
  return false
}

/** 关闭设置弹窗 */
const closeSettings = async () => {
  await cdp.evaluate(`(() => {
    const m = document.querySelector('.modal')
    if (!m) return
    const btn = [...m.querySelectorAll('.btn')].find(b => b.textContent.trim() === '关闭')
    btn ? btn.click() : m.parentElement?.click()
  })()`)
  await sleep(400)
}

/** 系统级发送 Ctrl+V（走原生菜单加速键） */
const sendCtrlV = async (text, focusMenu = false) => {
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'D:\\lab\\SSHelper\\scripts\\focus-and-paste.ps1',
    '-ClipboardText',
    text
  ]
  if (focusMenu) args.push('-FocusMenu')
  try {
    const out = await execFileAsync('powershell.exe', args)
    return out.stdout.trim()
  } catch (err) {
    return `SEND_FAILED: ${err.stdout ?? ''} ${err.message}`
  }
}

/** 渲染层级别的 Ctrl+V（CDP 原始按键，不经过原生菜单） */
const sendCtrlVByCdp = async () => {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    modifiers: 2,
    windowsVirtualKeyCode: 86,
    code: 'KeyV',
    key: 'v'
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'char',
    text: 'v',
    unmodifiedText: 'v'
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    windowsVirtualKeyCode: 86,
    code: 'KeyV',
    key: 'v'
  })
}

/** 连接测试主机（刷新页面后渲染层会丢失会话，需要重连） */
const connectHost = async () => {
  const ok = await cdp.evaluate(`(async () => {
    const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 测试主机'))
    item?.querySelector('.icon-btn')?.click()
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250))
      if (document.querySelector('.terminal-host .xterm-screen')) return true
    }
    return false
  })()`)
  await sleep(1200)
  return ok
}

/** 填写受控输入框：走 React 认可的 setter + input 事件 */
const fillField = async (selector, value) => {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
    return el.value
  })()`)
}

/** 点击容器内指定文本的按钮 */
const clickBtn = async (containerSelector, text) => {
  return cdp.evaluate(`(() => {
    const c = document.querySelector(${JSON.stringify(containerSelector)})
    const btn = [...(c?.querySelectorAll('.btn') ?? [])].find(b => b.textContent.trim() === ${JSON.stringify(text)})
    btn?.click()
    return Boolean(btn)
  })()`)
}

/** 读取页面整体状态 */
const readState = async (selector) => {  try {
    return await cdp.evaluate(`(() => {
      const modal = document.querySelector('.modal')
      const el = document.querySelector(${JSON.stringify(selector)})
      return {
        modalStillOpen: Boolean(modal),
        appAlive: Boolean(document.querySelector('.app')),
        value: el ? el.value : '(字段消失)',
        bodyText: document.body.innerText.slice(0, 80).replace(/\\n/g, ' | ')
      }
    })()`)
  } catch (err) {
    return { evaluateFailed: String(err.message) }
  }
}

// ---------------------------------------------------------------- 场景一
console.log('\n=== 场景一：Ctrl+V 粘贴（系统级 SendKeys，走原生菜单加速键）===')
console.log('打开设置弹窗:', await openSettings())
await sleep(600)

const fields = [
  ['API Key', '.modal input[type=password]'],
  ['接口地址', '.modal input[placeholder*="openai"]'],
  ['模型名称', '.modal input[placeholder*="gpt-4o"]'],
  ['系统提示词', '.modal textarea'],
  ['最大输出token', '.modal input[type=number]']
]

for (const [label, selector] of fields) {
  await closeSettings()
  const opened = await openSettings()
  if (!opened) {
    console.log(`  ${label}: 弹窗未打开`)
    continue
  }
  const before = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, 'EXISTING-CONTENT')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
    try { el.setSelectionRange(0, el.value.length) } catch (e) { /* number 类型不支持 */ }
    return {
      value: el.value,
      focused: document.activeElement === el,
      winFocused: document.hasFocus()
    }
  })()`)
  console.log(`  ${label} 聚焦:`, before)
  if (!before) {
    console.log(`  ${label}: 字段未找到`)
    continue
  }
  const sent = await sendCtrlV('X')
  await sleep(1200)
  const after = await readState(selector)
  console.log(`  ${label}:`, { sent, ...after, navigations })
  const errs = cdp.drainEvents().filter((e) => e.method === 'Log.entryAdded' || e.method === 'Runtime.exceptionThrown')
  if (errs.length) console.log('    控制台异常:', JSON.stringify(errs).slice(0, 600))
}

// 对照组：CDP 原始按键（不走原生菜单）
console.log('\n=== 场景一（对照）：CDP 原始 Ctrl+V ===')
await closeSettings()
console.log('打开设置弹窗:', await openSettings())
await cdp.evaluate(`(() => {
  const el = document.querySelector('.modal input[type=password]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, 'EXISTING-CONTENT')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
})()`)
await sendCtrlVByCdp()
await sleep(1000)
console.log('  结果:', await readState('.modal input[type=password]'))

// 场景一（续）：原生菜单栏获得焦点时粘贴（用户最可能遇到的路径）
console.log('\n=== 场景一（续）：菜单栏获得焦点时 Ctrl+V ===')
await closeSettings()
console.log('打开设置弹窗:', await openSettings())
await cdp.evaluate(`(() => {
  const el = document.querySelector('.modal input[type=password]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(el, 'EXISTING-CONTENT')
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus()
})()`)
const menuPaste = await sendCtrlV('MENU-PASTE', true)
await sleep(1200)
console.log('  菜单栏聚焦粘贴:', menuPaste, await readState('.modal input[type=password]'))

// 复原
await closeSettings()

// ---------------------------------------------------------------- 场景二
console.log('\n=== 场景二：保存 AI 配置后 AI 面板仍提示未配置 ===')

// 0) 重置 AI 配置并刷新页面，让 AI 面板回到「未配置」初始态
await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  await api.ai.setConfig({ enabled: false, baseUrl: '', model: '' })
  await api.ai.setApiKey(undefined)
  location.reload()
})()`)
await sleep(3500)
console.log('重连主机:', await connectHost())

const beforeState = await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  tab?.click()
  await new Promise(r => setTimeout(r, 800))
  const pane = document.querySelector('.ai-pane')
  return { showsNotConfigured: Boolean(pane && pane.textContent.includes('尚未配置 AI 服务')) }
})()`)
console.log('重置后 AI 面板:', beforeState)

// 1) 通过 UI 打开设置并填写
console.log('打开设置弹窗:', await openSettings())
await fillField('.modal input[placeholder*="openai"]', aiBaseUrl)
await fillField('.modal input[placeholder*="gpt-4o"]', 'mock-sre')
await cdp.evaluate(`(() => {
  const label = [...document.querySelectorAll('.modal label.checkbox')].find(l => l.textContent.includes('启用 AI 运维'))
  const box = label?.querySelector('input[type=checkbox]')
  if (box && !box.checked) box.click()
})()`)

// API Key：聚焦后用真实 Ctrl+V 粘贴
await cdp.evaluate(`(() => {
  const el = document.querySelector('.modal input[type=password]')
  el.focus()
  try { el.setSelectionRange(0, el.value.length) } catch (e) { /* ignore */ }
})()`)
const pasteOut = await sendCtrlV('sk-ui-paste-key')
await sleep(800)
const keyState = await cdp.evaluate(`(() => {
  const el = document.querySelector('.modal input[type=password]')
  return { value: el ? el.value : '(消失)', modalOpen: Boolean(document.querySelector('.modal')) }
})()`)
console.log('API Key 粘贴:', pasteOut, keyState)

// 2) 测试连接
await clickBtn('.modal', '测试连接')
await sleep(2000)
const testText = await cdp.evaluate(
  `document.querySelector('.modal .inline-row span')?.textContent ?? '(无测试结果)'`
)
console.log('测试连接结果:', testText)

// 3) 保存
await clickBtn('.modal', '保存')
await sleep(1200)
const savedText = await cdp.evaluate(
  `document.querySelector('.modal .modal-actions .success-text')?.textContent ?? '(未显示已保存)'`
)
console.log('保存提示:', savedText)

// 4) 关闭设置，切到 AI 运维面板
await closeSettings()
await cdp.evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  tab?.click()
})()`)
await sleep(1200)

const finalState = await cdp.evaluate(`(() => {
  const pane = document.querySelector('.ai-pane')
  return {
    paneShowsNotConfigured: Boolean(pane && pane.textContent.includes('尚未配置 AI 服务')),
    paneSnippet: pane ? pane.textContent.trim().slice(0, 60) : '(无面板)'
  }
})()`)
const cfgNow = await cdp.evaluate(`(async () => {
  const c = await window.sshHelper.ai.getConfig()
  const ping = await window.sshHelper.ai.ping()
  return { enabled: c.enabled, hasApiKey: c.hasApiKey, model: c.model, baseUrl: c.baseUrl, pingOk: ping.ok }
})()`)
console.log('场景二最终状态:', { ...finalState, ...cfgNow })

console.log('\n复现脚本结束')
process.exit(0)
