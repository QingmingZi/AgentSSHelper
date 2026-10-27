/**
 * 终端快捷键检查：确认 Ctrl+C / Ctrl+V 等按键能到达 xterm（不被原生菜单吞掉）。
 *
 * 用法：node scripts/check-terminal-keys.mjs <cdpPort>
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const [cdpPort] = process.argv.slice(2)
if (!cdpPort) {
  console.error('usage: node scripts/check-terminal-keys.mjs <cdpPort>')
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
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
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
      }, 20000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }
}

const cdp = await Cdp.connect((await findPageTarget()).webSocketDebuggerUrl)
await cdp.send('Runtime.enable')

// xterm 通过 requestAnimationFrame 绘制，窗口隐藏/最小化时 rAF 不触发，
// 终端内容不会更新到 DOM。先把窗口恢复并置前，否则断言会假失败。
try {
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'D:\\lab\\SSHelper\\scripts\\focus-and-paste.ps1',
    '-ClipboardText',
    'restore-only',
    '-RestoreOnly'
  ])
  await sleep(600)
} catch (err) {
  console.log('恢复窗口失败（继续尝试）:', err.message)
}

// 切到终端标签，等待面板显示后再聚焦 xterm 的输入框
await cdp.evaluate(`(() => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === '终端')
  tab?.click()
  return Boolean(tab)
})()`)
await sleep(1200)
const focusInfo = await cdp.evaluate(`(() => {
  const ta = document.querySelector('.xterm-helper-textarea')
  ta?.focus()
  return {
    textarea: Boolean(ta),
    active: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''),
    hasFocus: document.hasFocus()
  }
})()`)
console.log('终端聚焦:', focusInfo)
await sleep(400)

const readTerm = () =>
  cdp.evaluate(`(() => {
    const rows = document.querySelector('.xterm-rows')
    return rows ? rows.innerText.replace(/\\s+/g, ' ').trim() : ''
  })()`)

// 先清屏，避免历史回显被误判成新回显
await cdp.evaluate(`(() => {
  const btn = [...document.querySelectorAll('.terminal-pane .btn')].find(b => b.textContent.trim() === '清屏')
  btn?.click()
  return Boolean(btn)
})()`)
await sleep(600)

const type = async (text) => {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
  }
}

const before = await readTerm()

// Ctrl+C：应作为中断字符送到远端 shell
await cdp.send('Input.dispatchKeyEvent', {
  type: 'rawKeyDown',
  modifiers: 2,
  windowsVirtualKeyCode: 67,
  code: 'KeyC',
  key: 'c'
})
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 67, key: 'c' })
await sleep(1200)
const afterCtrlC = await readTerm()

// 普通输入：应能收到远端回显
await type('ping')
await sleep(1200)
const afterType = await readTerm()

console.log('终端初始:', before.slice(-80))
console.log('Ctrl+C 后:', afterCtrlC.slice(-80))
console.log('输入后  :', afterType.slice(-80))

const ctrlCReachedServer = /echo:/.test(afterCtrlC)
// 假 shell 逐字符回显，四个字符应各出现一次 echo:
const typingReachedServer = ['echo:p', 'echo:i', 'echo:n', 'echo:g'].every((token) =>
  afterType.includes(token)
)
console.log('\nCtrl+C 到达远端 shell:', ctrlCReachedServer)
console.log('普通输入到达远端 shell:', typingReachedServer)
process.exit(ctrlCReachedServer && typingReachedServer ? 0 : 1)
