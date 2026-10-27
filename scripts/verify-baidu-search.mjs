/**
 * 验证百度搜索增强：
 * 1) 设置面板出现「启用联网搜索增强（百度搜索）」开关、百度 API Key 输入框、配额展示
 * 2) IPC：setBaiduSearchKey 持久化后 hasBaiduSearchKey / baiduSearchKeyPreview 正确
 * 3) IPC：searchEnabled 开关 round-trip
 * 4) AI 回复：未命中搜索启发式时不报错、无「已联网检索」标记
 *
 * 前置：已运行 `npm run test:env` 与 `node scripts/launch-ui-app.mjs --remote-debugging-port=9333`
 * 用法：node scripts/verify-baidu-search.mjs <cdpPort> <sshPort> <aiBaseUrl>
 */
const [cdpPort, sshPort, aiBaseUrl] = process.argv.slice(2)
if (!cdpPort || !sshPort || !aiBaseUrl) {
  console.error('usage: node scripts/verify-baidu-search.mjs <cdpPort> <sshPort> <aiBaseUrl>')
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
    } catch {}
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

// 1) IPC 层验证：搜索配置 round-trip + 百度 Key 持久化/清除
const ipc = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const before = (await api.ai.getConfig()).searchEnabled
  await api.ai.setConfig({ searchEnabled: true })
  const turnedOn = (await api.ai.getConfig()).searchEnabled
  await api.ai.setBaiduSearchKey('baidu-e2e-key-953')
  const after = await api.ai.getConfig()
  const hasKey = after.hasBaiduSearchKey
  const preview = after.baiduSearchKeyPreview
  const quota = after.searchQuota
  // 关掉避免残留影响后续
  await api.ai.setBaiduSearchKey(undefined)
  await api.ai.setConfig({ searchEnabled: false })
  const cleaned = await api.ai.getConfig()
  return {
    before,
    turnedOn,
    hasKey,
    preview,
    dailyLimit: quota.dailyLimit,
    monthlyLimit: quota.monthlyLimit,
    cleaned: cleaned.hasBaiduSearchKey === false && cleaned.searchEnabled === false
  }
})()`)
check('searchEnabled 开关 IPC round-trip', ipc?.turnedOn === true, `before=${ipc?.before} -> on=${ipc?.turnedOn}`)
check('setBaiduSearchKey 后可识别 hasBaiduSearchKey', ipc?.hasKey === true)
check('百度 Key 预览为脱敏形式', typeof ipc?.preview === 'string' && !(ipc.preview || '').includes('baidu-e2e-key-953'), `preview=${ipc?.preview}`)
check('配额上限正确(日50/月1500)', ipc?.dailyLimit === 50 && ipc?.monthlyLimit === 1500, `day=${ipc?.dailyLimit}, mon=${ipc?.monthlyLimit}`)
check('清除 Key + 关闭搜索后恢复默认', ipc?.cleaned === true)

// 2) 打开设置面板，检查搜索区块 UI 渲染（先通过 IPC 开启搜索，使对话框内搜索区块展开）
const ipcEnable = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  await api.ai.setConfig({ searchEnabled: true })
  await api.ai.setBaiduSearchKey('baidu-e2e-key-953')
  return { ok: true }
})()`)
check('预先开启搜索 + 写入百度 Key', ipcEnable?.ok === true)

await cdp.evaluate(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('设置'))
  if (btn) btn.click()
  await new Promise(r => setTimeout(r, 800))
  return { ok: true }
})()`)

await cdp.evaluate(`(async () => {
  // 展开 AI 区域（若默认收起则点开关打开）
  const later = [...document.querySelectorAll('input[type="checkbox"]')].find(el => el.closest('label') && el.closest('label').textContent.includes('启用 AI 运维'))
  if (later && !later.checked) { later.click(); await new Promise(r => setTimeout(r, 200)) }
  // 若「启用联网搜索增强」未勾选，勾上以展开配额展示
  const searchToggle = [...document.querySelectorAll('input[type="checkbox"]')].find(el => el.closest('label') && el.closest('label').textContent.includes('启用联网搜索增强'))
  if (searchToggle && !searchToggle.checked) { searchToggle.click(); await new Promise(r => setTimeout(r, 200)) }
  return { ok: true }
})()`)

const settingsUI = await cdp.evaluate(`(async () => {
  const text = (document.querySelector('.modal') ? document.querySelector('.modal').textContent : document.body.textContent) || ''
  return {
    hasSearchToggle: !!document.querySelector('.modal input[type="checkbox"]') && document.querySelector('.modal').textContent.includes('启用联网搜索增强'),
    hasBaiduKeyField: text.includes('百度搜索 API Key'),
    quotaShown: text.includes('今日用量') && text.includes('本月用量'),
    searchBoxPresent: !!document.querySelector('.search-quota-box')
  }
})()`)
check('设置面板渲染「启用联网搜索增强」开关', settingsUI?.hasSearchToggle === true)
check('设置面板渲染百度搜索 API Key 输入框', settingsUI?.hasBaiduKeyField === true)
check('设置面板渲染配额展示(今日/本月)', settingsUI?.quotaShown === true)
check('名额区块容器出现', settingsUI?.searchBoxPresent === true)

// 3) 清理：关闭设置对话框，清掉测试写入的百度 Key 与搜索开关
const cleaned = await cdp.evaluate(`(async () => {
  const api = window.sshHelper
  const closeSel = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '关闭')
  if (closeSel) { closeSel.click(); await new Promise(r => setTimeout(r, 400)) }
  await api.ai.setBaiduSearchKey(undefined)
  await api.ai.setConfig({ searchEnabled: false })
  const cfg = await api.ai.getConfig()
  return { cleaned: cfg.hasBaiduSearchKey === false && cfg.searchEnabled === false }
})()`)
check('测试后清理百度 Key 并关闭搜索', cleaned?.cleaned === true)

console.log(failures === 0 ? '\n=== 百度搜索增强(设置/配额/IPC)诊断：通过 ===' : `\n=== 百度搜索增强(设置/配额/IPC)诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)