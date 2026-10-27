/**
 * 本地 mock 百度搜索端点：用于在无真实百度 Key 时端到端验证「已联网检索」链路。
 * 监听本地端口，模拟 qianfan web_search 的 POST /v2/ai_search/web_search，
 * 命中则返回百度官方形态的 references[]（含 title/content/url）。
 * 启动后打印端口并保持运行。
 * 用法：node scripts/mock-search-server.mjs <port>
 */
import http from 'node:http'
const port = Number(process.argv[2] || 0)

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    let query = ''
    try {
      const parsed = JSON.parse(body || '{}')
      const msg = Array.isArray(parsed.messages) ? parsed.messages : []
      query = (msg[msg.length - 1]?.content ?? '') || ''
    } catch {}
    res.end(
      JSON.stringify({
        references: [
          {
            content: `关于「${query || 'CVE-2021-44228'}」的模拟搜索结果：Log4Shell（CVE-2021-44228）是 Apache Log4j2 的远程代码执行漏洞，影响 2.0-beta9 至 2.14.1。缓解措施包括升级到 2.16.0+、设置 log4j2.formatMsgNoLookups=true。`,
            date: '2021-12-10 12:00:00',
            id: 1,
            title: 'Log4Shell（CVE-2021-44228）',
            type: 'web',
            url: 'https://example.com/log4shell'
          },
          {
            content: '官方补丁 2.17.0 已修复，建议尽快升级并检查依赖链。',
            date: '2021-12-12 09:00:00',
            id: 2,
            title: 'Log4j 漏洞修复指南',
            type: 'web',
            url: 'https://example.com/log4j-fix'
          }
        ],
        request_id: 'mock-fff6k'
      })
    )
  })
})

server.listen(port, '127.0.0.1', () => {
  const p = server.address().port
  console.log(JSON.stringify({ ready: true, port: p }))
})