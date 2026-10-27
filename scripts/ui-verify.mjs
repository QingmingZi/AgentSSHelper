/**
 * UI 端到端验证脚本
 *
 * 通过 Chrome DevTools Protocol 驱动真实运行的 Electron 窗口：
 *   1. 预置主机配置
 *   2. 点击连接
 *   3. 逐个面板截图（终端 / 文件传输 / AI 运维）
 *
 * 用法：node scripts/ui-verify.mjs <cdpPort> <outDir> <sshPort> <aiBaseUrl>
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const [cdpPort, outDir, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !outDir || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/ui-verify.mjs <cdpPort> <outDir> <sshPort> <aiBaseUrl>')
  process.exit(2)
}

// 本地临时目录，用于验证上传 / 下载往返
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshelper-ui-verify-'))
fs.writeFileSync(path.join(tmpDir, 'upload-ui.txt'), 'ui-upload-payload')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* CDP 还没起来 */
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
      }, 120000)
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

  async screenshot(name) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(outDir, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    return file
  }
}

const target = await findPageTarget()
console.log(`目标窗口: ${target.title} ${target.url}`)
const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await sleep(800)

// 窗口若被遮挡/最小化，Chromium 会挂起渲染，截图与 evaluate 都可能超时。
// 先把窗口恢复并置前，保证后续断言稳定。
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

/**
 * 等待 AI 面板空闲。
 *
 * AI 正在流式回复、或「结果自动回传」正在自动续聊时，输入框是禁用的，
 * 此时发送按钮点击不会派发任何请求，断言会误判成「功能没生效」。
 * 所以每次发消息前都必须先等面板空闲。
 *
 * 注意：不能用发送按钮的 disabled 判断忙碌 —— 输入框为空时按钮同样是禁用的。
 * 输入框的 disabled 才只由 busy 决定。
 */
async function waitIdle(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      const ta = document.querySelector('.chat-input textarea')
      const btn = document.querySelector('.chat-input .btn.primary')
      return {
        present: Boolean(ta),
        busy: ta ? ta.disabled : true,
        label: btn ? btn.textContent.trim() : ''
      }
    })()`)
    if (state.present && !state.busy) return { ok: true }
    await sleep(250)
  }
  return { ok: false }
}

/** 在 AI 面板发送一条消息（发送前先等面板空闲，返回是否真的派发出去） */
async function sendChat(text) {
  const idle = await waitIdle()
  if (!idle.ok) return { ok: false, reason: 'AI 面板一直处于忙碌状态' }
  return cdp.evaluate(`(async () => {
    const ta = document.querySelector('.chat-input textarea')
    const btn = document.querySelector('.chat-input .btn.primary')
    if (!ta || !btn) return { ok: false, reason: '未找到输入框或发送按钮' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    // 等 React 把输入状态提交到 DOM，发送按钮才会解除禁用
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 100))
      if (!btn.disabled) break
    }
    if (btn.disabled) return { ok: false, reason: '发送按钮仍不可用' }
    btn.click()
    return { ok: true }
  })()`)
}

// 1. 预置主机配置与 AI 配置
const setup = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'UI 测试主机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({
    label: 'UI 测试主机',
    host: '127.0.0.1',
    port: ${Number(sshPort)},
    username: 'tester',
    authType: 'password'
  })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  await api.ai.setConfig({
    enabled: true,
    baseUrl: ${JSON.stringify(aiBaseUrl)},
    model: 'mock-sre',
    temperature: 0.2,
    maxTokens: 1024,
    // 三个开关必须显式复位：ai:setConfig 是合并语义，
    // 上一轮回归留下的持久化状态会污染本轮断言
    autoApproveSafeCommands: false,
    autoApproveModifyCommands: false,
    autoSubmitCommandResults: false,
    contextLines: 60
  })
  await api.ai.setApiKey('sk-ui-test-key')
  const cfg = await api.ai.getConfig()
  return {
    profileId: p.id,
    autoApproveSafeCommands: cfg.autoApproveSafeCommands,
    autoApproveModifyCommands: cfg.autoApproveModifyCommands,
    autoSubmitCommandResults: cfg.autoSubmitCommandResults
  }
})()`)
console.log('预置完成:', setup)
if (
  setup.autoApproveSafeCommands !== false ||
  setup.autoApproveModifyCommands !== false ||
  setup.autoSubmitCommandResults !== false
) {
  console.error('开关复位失败，后续断言不可信')
  process.exit(3)
}

// 2. 刷新以加载主机列表
await cdp.send('Page.reload')
await sleep(2500)

// 3. 点击连接按钮
const connected = await cdp.evaluate(`(async () => {
  const item = [...document.querySelectorAll('.host-item')].find(el => el.textContent.includes('UI 测试主机'))
  if (!item) return { ok: false, reason: '侧边栏未找到主机' }
  const btn = item.querySelector('.icon-btn')
  btn.click()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (document.querySelector('.terminal-host .xterm-screen')) return { ok: true }
  }
  return { ok: false, reason: '终端未出现' }
})()`)
console.log('连接结果:', connected)
await sleep(1200)
await cdp.screenshot('01-terminal')

// 3a-0. 回归：#1 在「新建主机」表单里填了口令并保存后，
//      该口令必须真正落库（hasSecret=true），首次连接才不会再次询问。
//      此前 App 层 onSubmit 只透传了 values、丢掉了 secrets 参数，导致口令根本没保存。
const hostPasswordSave = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  // 侧边栏顶部「＋」按钮（title=新建主机配置）
  const btn = document.querySelector('.sidebar-head .btn[title="新建主机配置"]')
  if (!btn) return { ok: false, reason: '未找到侧边栏「新建主机」＋按钮' }
  btn.click()
  await new Promise(r => setTimeout(r, 400))
  const modal = document.querySelector('.modal')
  if (!modal) return { ok: false, reason: '新建主机弹窗未打开' }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const fill = (placeholder, val) => {
    const el = modal.querySelector('input[placeholder*="' + placeholder + '"]')
    if (!el) throw new Error('缺少输入框: ' + placeholder)
    setter.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  fill('example.com', '192.168.9.99')
  fill('root', 'pwuser')
  const passEl = modal.querySelector('input[type=password]')
  if (!passEl) return { ok: false, reason: '未找到登录口令输入框' }
  setter.call(passEl, 'pw-secret-99')
  passEl.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const saveBtn = [...modal.querySelectorAll('.modal-actions .btn')].find(b => b.textContent.trim() === '保存')
  if (!saveBtn) return { ok: false, reason: '未找到保存按钮' }
  saveBtn.click()
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (!document.querySelector('.modal')) break
  }
  const list = await api.profiles.list()
  const created = list.find(p => p.host === '192.168.9.99')
  if (!created) return { ok: false, reason: '未找到新创建的主机' }
  const has = await api.profiles.hasSecret(created.id, 'password')
  await api.profiles.remove(created.id)
  return { ok: has, host: created.host, username: created.username, hasSecret: has }
})()`)
console.log('主机口令保存回归:', hostPasswordSave)
console.log('  -> 期望 hasSecret=true：', JSON.stringify(hostPasswordSave))

// 4. 文件传输面板
const transfer = await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === '文件传输')
  tab.click()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    const rows = document.querySelectorAll('.file-row:not(.head):not(.empty)')
    if (rows.length > 0) return { ok: true, rows: [...rows].map(r => r.textContent.trim().split('\\s+')[0]) }
  }
  return { ok: false, reason: '文件列表为空' }
})()`)
console.log('文件传输:', transfer)
await sleep(500)
await cdp.screenshot('02-transfer')

// 3b. 回归：双击进入子目录必须能列出内容（此前根目录条目路径为相对路径导致 No such file）
const subDir = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const sessions = await api.ssh.sessions()
  const sid = sessions[0].sessionId
  const root = await api.sftp.list(sid, '/')
  const dir = root.find(e => e.type === 'directory')
  if (!dir) return { ok: false, reason: '根目录没有子目录可测' }
  const abs = dir.path.startsWith('/')
  let inner = []
  let err = ''
  try {
    inner = await api.sftp.list(sid, dir.path)
  } catch (e) {
    err = String(e && e.message || e)
  }
  return { ok: abs && inner.length > 0, dir: dir.path, abs, inner: inner.length, err }
})()`)
console.log('子目录导航:', subDir)

// 3c. 真实上传 / 下载往返
const transferRoundTrip = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const sessions = await api.ssh.sessions()
  const sid = sessions[0].sessionId
  const localPath = ${JSON.stringify(path.join(tmpDir, 'upload-ui.txt'))}
  const up = await api.transfer.run({
    sessionId: sid,
    direction: 'upload',
    source: localPath,
    target: '/uploaded-by-ui.txt',
    overwrite: true
  })
  const root = await api.sftp.list(sid, '/')
  const uploaded = root.find(e => e.name === 'uploaded-by-ui.txt')
  const down = await api.transfer.run({
    sessionId: sid,
    direction: 'download',
    source: uploaded ? uploaded.path : '/uploaded-by-ui.txt',
    target: ${JSON.stringify(path.join(tmpDir, 'downloaded-ui.txt'))},
    overwrite: true
  })
  return {
    uploadOk: up.ok, uploadErr: up.error,
    listed: Boolean(uploaded), listedPath: uploaded && uploaded.path,
    downloadOk: down.ok, downloadErr: down.error
  }
})()`)
console.log('上传下载往返:', transferRoundTrip)
const downloadedContent = fs.existsSync(path.join(tmpDir, 'downloaded-ui.txt'))
  ? fs.readFileSync(path.join(tmpDir, 'downloaded-ui.txt'), 'utf8')
  : '(缺失)'
console.log(
  '下载文件内容校验:',
  downloadedContent === 'ui-upload-payload' ? '一致' : `不一致 -> ${downloadedContent}`
)

// 4b. 切回终端，验证终端实例未被销毁重建（内容仍在、不会开出第二个 shell）
const backToTerminal = await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === '终端')
  tab.click()
  await new Promise(r => setTimeout(r, 900))
  const text = document.querySelector('.terminal-host')?.innerText ?? ''
  return { ok: text.includes('fake-shell'), snippet: text.slice(0, 60).replace(/\\n/g, '\\\\n') }
})()`)
console.log('切回终端:', backToTerminal)
await sleep(300)
await cdp.screenshot('02b-terminal-persist')

// 5. AI 运维面板
await cdp.evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'AI 运维')
  tab.click()
  await new Promise(r => setTimeout(r, 400))
})()`)
const sentFirst = await sendChat('帮我看看磁盘和服务状态')
console.log('首次发送:', sentFirst)
const aiResult = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    const cards = document.querySelectorAll('.cmd-card')
    if (cards.length >= 4) return { ok: true, cards: cards.length }
  }
  return { ok: false, reason: '未出现命令卡片' }
})()`)
console.log('AI 面板:', aiResult)

// 5a. Markdown 渲染：回复应包在 .markdown 里，命令协议块转成代码块而不是原样显示
const markdown = await cdp.evaluate(`(() => {
  const body = document.querySelector('.chat-msg.assistant .markdown')
  const raw = document.querySelector('.chat-list')?.innerText ?? ''
  return {
    ok: Boolean(body) && body.querySelectorAll('pre code').length >= 2 && !raw.includes(':::command'),
    codeBlocks: body ? body.querySelectorAll('pre code').length : 0,
    rawProtocolVisible: raw.includes(':::command')
  }
})()`)
console.log('Markdown 渲染:', markdown)

// 5a-2. 指标展示：回复下方应有首字延迟、tokens/s、上下文占用
const aiMetrics = await cdp.evaluate(`(async () => {
  for (let i = 0; i < 60; i++) {
    const el = [...document.querySelectorAll('.chat-msg.assistant .chat-metrics')]
      .find(n => n.textContent.includes('tok/s') && n.textContent.includes('上下文'))
    if (el) {
      const text = el.textContent.replace(/\\s+/g, ' ').trim()
      return {
        ok: text.includes('首字') && text.includes('tok/s') && text.includes('上下文') && text.includes('/'),
        text,
        estimated: text.includes('估算')
      }
    }
    await new Promise(r => setTimeout(r, 250))
  }
  return { ok: false, reason: '未出现指标行' }
})()`)
console.log('AI 指标展示:', aiMetrics)

// 5b. 风险分级与审批校验：修改/删除类必须挂起等待确认
const policy = await cdp.evaluate(`(async () => {
  const cards = [...document.querySelectorAll('.cmd-card')]
  const info = cards.map(c => ({
    tag: c.querySelector('.risk-tag')?.textContent?.trim(),
    cmd: c.querySelector('.cmd-text')?.textContent?.trim(),
    hasOutput: Boolean(c.querySelector('.cmd-output')),
    buttons: [...c.querySelectorAll('.cmd-actions .btn')].map(b => b.textContent.trim())
  }))
  const deleteCard = cards.find(c => c.querySelector('.risk-tag')?.textContent?.trim() === '删除')
  const modifyCard = cards.find(c => c.querySelector('.risk-tag')?.textContent?.trim() === '修改')
  return {
    tags: info.map(i => i.tag),
    deletePending: deleteCard ? !deleteCard.querySelector('.cmd-output') : false,
    deleteHasApprove: deleteCard ? [...deleteCard.querySelectorAll('.cmd-actions .btn')].some(b => b.textContent.trim() === '执行') : false,
    modifyPending: modifyCard ? !modifyCard.querySelector('.cmd-output') : false,
    safeFirstAutoRan: info.filter(i => i.tag === '只读')[0]?.hasOutput === true
  }
})()`)
console.log('风险分级/审批:', policy)
await sleep(400)
await cdp.screenshot('03-ai-ops')

// 5c. 批量审批：勾选删除/修改卡片后一次批准，而不是逐条点击
const approved = await cdp.evaluate(`(async () => {
  const cards = [...document.querySelectorAll('.cmd-card')]
    .filter(c => c.querySelector('.risk-tag')?.textContent?.trim() !== '只读')
  if (cards.length < 2) return { ok: false, reason: '未找到删除/修改卡片' }
  const target = cards.slice(0, 2)
  for (const card of target) {
    const box = card.querySelector('.cmd-select')
    if (!box) return { ok: false, reason: '待确认卡片缺少勾选框' }
    box.click()
  }
  await new Promise(r => setTimeout(r, 250))
  const bar = document.querySelector('.cmd-batch')
  if (!bar) return { ok: false, reason: '未出现批量审批栏' }
  const barText = bar.textContent.replace(/\\s+/g, ' ').trim()
  const btn = [...bar.querySelectorAll('.btn')].find(b => b.textContent.trim() === '批准选中')
  if (!btn || btn.disabled) return { ok: false, reason: '批准选中按钮不可用', barText }
  btn.click()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (target.every(c => c.querySelector('.cmd-output'))) {
      return {
        ok: true,
        approved: target.map(c => c.querySelector('.cmd-text')?.textContent?.trim()),
        selectedAfter: document.querySelectorAll('.cmd-card.selected').length,
        barText
      }
    }
  }
  return { ok: false, reason: '批量批准后未全部产生输出' }
})()`)
console.log('批量审批:', approved)
await sleep(300)
await cdp.screenshot('04-ai-command-executed')

// 5d. 多轮上下文：第二轮请求必须带上第一轮的对话内容
const sentSecond = await sendChat('那内存占用呢')
console.log('第二轮发送:', sentSecond)
const multiTurn = await cdp.evaluate(`(async () => {
  const read = () => {
    const replies = [...document.querySelectorAll('.chat-msg.assistant')].map(p => p.textContent)
    const withCount = replies.filter(t => t.includes('上下文消息数'))
    return {
      counts: withCount.map(t => (t.match(/上下文消息数：(\\d+)/) || [])[1]),
      userMessages: document.querySelectorAll('.chat-msg.user').length
    }
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    const state = read()
    // 必须同时看到「两条用户消息」和「两条带上下文计数的回复」，
    // 否则可能是自动回传产生的额外回复，不能算真正的多轮上下文
    if (state.counts.length >= 2 && state.userMessages >= 2) {
      return { ok: true, ...state }
    }
  }
  return { ok: false, reason: '未收到第二轮回复', ...read() }
})()`)
console.log('多轮上下文:', multiTurn)

// 5d-2. 命令卡片应串在对应 AI 回复下方，而不是全部堆在对话底部
const cardLayout = await cdp.evaluate(`(() => {
  const list = document.querySelector('.chat-list')
  if (!list) return { ok: false, reason: '未找到对话列表' }
  const turns = [...list.querySelectorAll('.chat-turn')]
  const turnInfo = turns.map(t => ({
    hasMsg: Boolean(t.querySelector('.chat-msg')),
    cards: t.querySelectorAll('.cmd-card').length
  }))
  return {
    ok: true,
    turnCount: turns.length,
    turnsWithCards: turnInfo.filter(t => t.cards > 0).length,
    cardsInsideTurns: turnInfo.reduce((n, t) => n + t.cards, 0),
    looseCards: list.querySelectorAll(':scope > .cmd-card').length,
    totalCards: list.querySelectorAll('.cmd-card').length
  }
})()`)
console.log('命令卡片布局:', cardLayout)

// 5e. 只读命令（含只读管道）应自动执行、不再询问、不显示审批按钮
//      （safe 命令始终自动执行，无需勾选任何开关）
const cardsBeforeThird = await cdp.evaluate(`document.querySelectorAll('.cmd-card').length`)
const sentThird = await sendChat('再看一下磁盘占用排序')
console.log('第三轮发送:', sentThird)
const autoSafe = await cdp.evaluate(`(async () => {
  const total = () => document.querySelectorAll('.cmd-card').length
  const before = ${cardsBeforeThird}
  let last = -1
  let stable = 0
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 250))
    const now = total()
    if (now <= before) continue
    const fresh = [...document.querySelectorAll('.cmd-card')].slice(before).map(c => ({
      tag: c.querySelector('.risk-tag')?.textContent?.trim(),
      cmd: c.querySelector('.cmd-text')?.textContent?.trim(),
      hasOutput: Boolean(c.querySelector('.cmd-output')),
      hasApprove: [...c.querySelectorAll('.cmd-actions .btn')].some(b => b.textContent.trim() === '执行')
    }))
    const safeCards = fresh.filter(x => x.tag === '只读')
    const others = fresh.filter(x => x.tag !== '只读')
    // 单步执行：多步命令里只有第一条自动执行（产出输出、无审批按钮），
    // 其余只读卡片转为待确认（有审批按钮），等待结果回传后由 AI 续算下一步。
    const firstAuto = safeCards[0]
    const firstDone = firstAuto && firstAuto.hasOutput && !firstAuto.hasApprove
    const restPending = safeCards.slice(1).every(x => x.hasApprove && !x.hasOutput)
    if (!firstDone) continue
    // 卡片数量连续两轮不再变化，认为已经稳定
    if (now === last) stable++
    else stable = 0
    last = now
    if (stable < 2) continue
    const modifiedOthers =
      others.length === 0 || others.every(x => x.hasApprove && !x.hasOutput)
    return {
      ok: firstDone && (restPending || safeCards.length === 1) && modifiedOthers,
      safeCards: safeCards.map(x => ({ cmd: x.cmd, hasOutput: x.hasOutput, hasApprove: x.hasApprove })),
      others: others.map(x => ({ tag: x.tag, cmd: x.cmd, hasOutput: x.hasOutput, hasApprove: x.hasApprove }))
    }
  }
  return { ok: false, reason: '未产生新的命令卡片或第一条只读命令未自动执行' }
})()`)
console.log('只读自动执行:', autoSafe)
await sleep(300)
await cdp.screenshot('07-auto-safe')

// 5f. 勾选「结果自动回传」后，命令执行完应自动把结果交给 AI，
//      界面无需用户点击就会多出一条 AI 回复
const autoSubmitSwitch = await cdp.evaluate(`(async () => {
  const label = [...document.querySelectorAll('.ai-pane .checkbox')].find(l => l.textContent.includes('结果自动回传'))
  const box = label?.querySelector('input[type=checkbox]')
  if (!box) return { ok: false, reason: '未找到「结果自动回传」开关' }
  if (!box.checked) box.click()
  await new Promise(r => setTimeout(r, 600))
  return { ok: true, checked: box.checked }
})()`)
console.log('结果自动回传开关:', autoSubmitSwitch)
const repliesBeforeSubmit = await cdp.evaluate(`document.querySelectorAll('.chat-msg.assistant').length`)
const sentFourth = await sendChat('触发一次自动回传')
console.log('第四轮发送:', sentFourth)
const autoSubmit = await cdp.evaluate(`(async () => {
  const before = ${repliesBeforeSubmit}
  const count = () => document.querySelectorAll('.chat-msg.assistant').length
  // 先等本轮的直接回复
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (count() > before) break
  }
  if (count() <= before) return { ok: false, reason: '本轮 AI 回复未出现' }
  // 再等「自动回传」带来的额外回复：期间用户没有任何操作
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 250))
    if (count() <= before + 1) continue
    const replies = [...document.querySelectorAll('.chat-msg.assistant')]
    const fresh = replies.slice(before).map(r => r.textContent)
    const withCount = fresh.filter(t => t.includes('上下文消息数'))
    return {
      ok: withCount.length > 0,
      repliesBefore: before,
      repliesAfter: replies.length,
      counts: withCount.map(t => (t.match(/上下文消息数：(\\d+)/) || [])[1]),
      turns: document.querySelectorAll('.chat-turn').length
    }
  }
  return {
    ok: false,
    reason: '命令结果未自动回传给 AI',
    repliesBefore: before,
    repliesAfter: count()
  }
})()`)
console.log('结果自动回传:', autoSubmit)
await sleep(300)
await cdp.screenshot('08-auto-submit')

// 6. 设置弹窗
const settings = await cdp.evaluate(`(async () => {
  [...document.querySelectorAll('.topbar-right .btn')].find(b => b.textContent.trim() === '设置').click()
  await new Promise(r => setTimeout(r, 500))
  const modal = document.querySelector('.modal')
  const toggles = [...document.querySelectorAll('.modal .checkbox')].map(c => c.textContent.trim().slice(0, 40))
  return { ok: Boolean(modal), toggles }
})()`)
console.log('设置弹窗:', settings)
await sleep(400)
await cdp.screenshot('05-settings')

// 6b. 自动获取模型列表并从中选取
const modelPicker = await cdp.evaluate(`(async () => {
  const modal = document.querySelector('.modal')
  if (!modal) return { ok: false, reason: '设置弹窗未打开' }

  // 填入接口地址（用当前测试用的假 AI 服务）
  const urlInput = document.querySelector('.modal input[placeholder*="openai"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(urlInput, ${JSON.stringify(aiBaseUrl)})
  urlInput.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))

  // 点击「获取模型列表」
  const btn = [...modal.querySelectorAll('.btn')].find(b => b.textContent.trim() === '获取模型列表')
  if (!btn) return { ok: false, reason: '未找到「获取模型列表」按钮' }
  btn.click()

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250))
    const select = document.querySelector('.modal select.model-select')
    if (select) break
  }
  const select = document.querySelector('.modal select.model-select')
  if (!select) return { ok: false, reason: '未出现模型下拉框' }
  const options = [...select.options].map(o => o.value).filter(Boolean)

  // 选中一个模型，应回填到「模型名称」输入框
  const target = options.includes('mock-sre') ? 'mock-sre' : options[0]
  select.value = target
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(r => setTimeout(r, 300))
  const modelInput = document.querySelector('.modal input[placeholder*="gpt-4o"]')

  return {
    ok: true,
    optionCount: options.length,
    options: options.slice(0, 5),
    picked: target,
    modelInputValue: modelInput ? modelInput.value : '(未找到模型输入框)'
  }
})()`)
console.log('模型列表选取:', modelPicker)
await sleep(300)
await cdp.screenshot('06-model-picker')

// 7. 汇总判定
const modelOk = modelPicker.ok && modelPicker.modelInputValue === modelPicker.picked
// 第二轮的消息数必须多于第一轮，说明历史确实被带上了
const counts = multiTurn.counts ?? []
const contextOk =
  multiTurn.ok && counts.length >= 2 && Number(counts[1]) > Number(counts[0]) && multiTurn.userMessages >= 2
// 只读命令（含只读管道）在开关开启后应自动执行，修改/删除仍需确认
const autoSafeOk = autoSafe.ok === true
// 命令卡片应串在对应回复下方，不应游离在对话列表外
const layoutOk =
  cardLayout.ok === true &&
  cardLayout.turnsWithCards > 0 &&
  cardLayout.looseCards === 0 &&
  cardLayout.cardsInsideTurns === cardLayout.totalCards
// 开启「结果自动回传」后，命令结果应自动交给 AI 并出现新的回复
const autoSubmitOk = autoSubmit.ok === true

console.log('\nUI 验证完成')
console.log('模型选取:', modelOk ? '通过' : '失败')
console.log('多轮上下文:', contextOk ? '通过' : '失败', counts)
console.log('只读自动执行:', autoSafeOk ? '通过' : '失败')
console.log('卡片串进对话:', layoutOk ? '通过' : '失败', cardLayout)
console.log('结果自动回传:', autoSubmitOk ? '通过' : '失败')
process.exit(modelOk && contextOk && autoSafeOk && layoutOk && autoSubmitOk ? 0 : 1)
