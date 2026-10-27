/**
 * 截图设置面板里的「百度搜索增强」区块，供人工目检视觉呈现。
 * 前置：已运行 test:env 与 launch-ui-app。
 * 用法：node scripts/shot-search-ui.mjs <cdpPort> <outPng>
 */
import fs from 'node:fs'
const [cdpPort, outPng] = process.argv.slice(2)
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
  throw new Error('no page')
}
const target = await findPage()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
})
function send(method, params = {}) {
  const i = ++id
  return new Promise((res, rej) => {
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r.result?.value
}
await send('Page.enable')
await send('Runtime.enable')
await ev(`(async () => {
  const api = window.sshHelper
  await api.ai.setConfig({ searchEnabled: true })
  await api.ai.setBaiduSearchKey('demo-baidu-key-1234567890')
  return true
})()`)
await sleep(300)
await ev(`(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('设置'))
  if (btn) btn.click()
  await new Promise(r => setTimeout(r, 900))
  const later = [...document.querySelectorAll('input[type="checkbox"]')].find(el => el.closest('label') && el.closest('label').textContent.includes('启用 AI 运维'))
  if (later && !later.checked) { later.click(); await new Promise(r => setTimeout(r, 300)) }
  const searchToggle = [...document.querySelectorAll('input[type="checkbox"]')].find(el => el.closest('label') && el.closest('label').textContent.includes('启用联网搜索增强'))
  if (searchToggle && !searchToggle.checked) { searchToggle.click(); await new Promise(r => setTimeout(r, 300)) }
  return true
})()`)
await sleep(600)
const shot = await send('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'))
console.log('saved', outPng)
process.exit(0)