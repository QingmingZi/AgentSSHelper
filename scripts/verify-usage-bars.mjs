/**
 * 验证顶部栏「服务器 CPU / 内存动态占用」显示：
 *  1. 预置主机并连接假 SSH 服务器
 *  2. 连接后顶部栏应出现 `.usage-bars`，含 CPU 与内存两个 `.usage-bar`
 *  3. 每项有进度条 `.usage-fill`（宽度对应百分比）与数值文本
 *
 * 用法：node scripts/verify-usage-bars.mjs <cdpPort> <sshPort>
 */
const [cdpPort, sshPort] = process.argv.slice(2)
if (!cdpPort || !sshPort) {
  console.error('usage: node scripts/verify-usage-bars.mjs <cdpPort> <sshPort>')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function openCdp() {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('超时 ' + method)) } }, 60000) })
  await send('Runtime.enable')
  return {
    eval: async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('页面报错: ' + JSON.stringify(r.exceptionDetails)); return r.result?.value },
    send
  }
}

let failures = 0
function check(name, ok, detail) { console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` :: ${detail}` : ''}`); if (!ok) failures++ }

const cdp = await openCdp()
await sleep(600)

const setup = await cdp.eval(`(async () => {
  const api = window.sshHelper
  const existing = (await api.profiles.list()).find(p => p.label === 'CPU 占用测试机')
  if (existing) await api.profiles.remove(existing.id)
  const p = await api.profiles.create({ label: 'CPU 占用测试机', host: '127.0.0.1', port: ${Number(sshPort)}, username: 'tester', authType: 'password' })
  await api.profiles.setSecret(p.id, 'password', 's3cret')
  return { ok: true }
})()`)
check('预置测试主机', setup?.ok === true)

// 重载让主机出现在侧栏
await cdp.eval(`(() => { location.reload(); return true })()`)
await sleep(2600)

const connect = await cdp.eval(`(async () => {
  for (let i = 0; i < 60; i++) {
    const item = Array.from(document.querySelectorAll('.host-item')).find(el => el.textContent.includes('CPU 占用测试机'))
    if (item) { item.querySelector('.icon-btn').click(); break }
    await new Promise(r => setTimeout(r, 250))
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 300))
    if (document.querySelector('.status-pill.connected')) return { ok: true }
  }
  return { ok: false, reason: '未连接' }
})()`)
check('连接假 SSH 主机', connect?.ok === true, connect?.reason)

// 等待顶部栏 usage bars 出现并读取
const usage = await cdp.eval(`(async () => {
  let summary = null
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300))
    const cont = document.querySelector('.usage-bars')
    if (cont) {
      const bars = Array.from(cont.querySelectorAll('.usage-bar'))
      const labels = bars.map(b => (b.querySelector('.usage-label') || {}).textContent || '')
      const values = bars.map(b => (b.querySelector('.usage-value') || {}).textContent || '')
      const widths = bars.map(b => b.querySelector('.usage-fill') ? (b.querySelector('.usage-fill').style.width || '') : '')
      summary = { strings: bars.length + '|' + labels.join(',') + '|' + values.join(',') + '|' + widths.join(',') }
      break
    }
  }
  if (!summary) return { ok: false, reason: '.usage-bars 未出现' }
  const parts = summary.strings.split('|')
  const count = Number(parts[0])
  const labels = (parts[1] || '').split(',').filter(Boolean)
  const hasCpu = labels.includes('CPU')
  const hasMem = labels.includes('内存')
  const widthsAll = (parts[3] || '').split(',').filter(w => w.includes('%'))
  const fillsOk = widthsAll.length === count
  return { ok: true, count, hasCpu, hasMem, fillsOk, labels: (parts[1] || ''), values: (parts[2] || ''), widths: (parts[3] || '') }
})()`)
check('连接后顶部栏出现 CPU/内存占用条', usage?.ok === true, JSON.stringify(usage))
check('包含 CPU 与内存两个占用条', usage?.ok === true && usage?.count === 2 && usage?.hasCpu && usage?.hasMem, JSON.stringify(usage))
check('每个占用条有进度条且带宽度百分比', usage?.ok === true && usage?.fillsOk === true, JSON.stringify(usage))

console.log(failures === 0 ? '\n=== CPU/内存动态显示诊断：通过 ===' : `\n=== CPU/内存动态显示诊断：${failures} 失败 ===`)
process.exit(failures === 0 ? 0 : 1)