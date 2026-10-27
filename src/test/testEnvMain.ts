import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFakeSshServer } from './fakeSshServer'

/**
 * UI 验证用的本地测试环境：
 *  - 一个假的 SSH 服务端（支持 exec / shell / SFTP）
 *  - 一个假的 OpenAI 兼容流式接口
 * 启动后输出端口信息并保持运行。
 */

async function main(): Promise<void> {
  const remoteRoot = path.join(os.tmpdir(), 'sshelper-ui-remote')
  const localRoot = path.join(os.tmpdir(), 'sshelper-ui-local')
  fs.mkdirSync(remoteRoot, { recursive: true })
  fs.mkdirSync(localRoot, { recursive: true })

  fs.writeFileSync(
    path.join(remoteRoot, 'nginx.conf'),
    'worker_processes auto;\nhttp { server { listen 80; } }\n'
  )
  fs.writeFileSync(path.join(remoteRoot, 'app.log'), 'INFO  started\nWARN  slow query detected\nERROR db timeout\n')
  fs.mkdirSync(path.join(remoteRoot, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(remoteRoot, 'logs', 'error.log'), 'boom\n')

  const ssh = await startFakeSshServer({ root: remoteRoot, port: 0 })

  const ai = http.createServer((req, res) => {
    const url = req.url ?? ''
    // 模型列表端点（OpenAI 兼容的 GET /models）
    if (req.method === 'GET' && /\/models$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'mock-sre-pro', object: 'model', owned_by: 'sshelper-test' },
            { id: 'mock-sre', object: 'model', owned_by: 'sshelper-test' },
            { id: 'mock-sre-mini', object: 'model', owned_by: 'sshelper-test' }
          ]
        })
      )
      return
    }

    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // 回显本次请求携带的消息条数，便于在 UI 回归里验证多轮上下文是否延续
      let received = 0
      // 「命令结果自动回传」的请求：回复里不再提命令，避免假服务端与自动回传形成死循环
      let isFollowUp = false
      try {
        const parsed = JSON.parse(body || '{}') as {
          messages?: Array<{ role?: string; content?: string }>
        }
        const messages = Array.isArray(parsed.messages) ? parsed.messages : []
        received = messages.length
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        isFollowUp = Boolean(lastUser?.content?.includes('的执行结果：'))
      } catch {
        received = 0
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // 长任务验证：用户输入含「长任务」时，返回永不结束的进度命令（测试实时进度 + 停止）
      const lastUserTextRaw = (() => {
        try {
          const parsed = JSON.parse(body || '{}') as { messages?: Array<{ content?: string }> }
          const messages = Array.isArray(parsed.messages) ? parsed.messages : []
          return [...messages].reverse().find((m) => m.content && !m.content.includes('执行结果'))?.content ?? ''
        } catch {
          return ''
        }
      })()
      const wantsLongTask = lastUserTextRaw.includes('长任务')
      if (wantsLongTask) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '好的，我启动一个长时间运行的进度任务，你可以看到实时输出并随时停止。\n:::command\nrun-forever\n:::\n' } }]
          })}\n\n`
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      // 「慢速」：延迟 4s 再流式返回，用于验证「AI 处理中 + 等待时间」指示
      const wantsSlow = lastUserTextRaw.includes('慢速')
      const chunks = isFollowUp
        ? [
            `【上下文消息数：${received}】\n`,
            '已收到命令执行结果，磁盘与服务状态正常，无需继续操作。\n'
          ]
        : [
            `【上下文消息数：${received}】\n`,
            '我先检查一下磁盘使用情况。\n',
            ':::command\ndf -h\n:::\n',
            '再按占用排序看看哪些目录大：\n',
            ':::command\ndf -h | sort -k5 -h\n:::\n',
            '同时确认服务状态：\n',
            ':::command\nsystemctl status nginx\n:::\n',
            '磁盘紧张的话需要清理一下旧日志，并重启服务释放内存。\n',
            ':::command\nrm -rf /var/log/old.log\n:::\n',
            ':::command\nsystemctl restart nginx\n:::\n'
          ]
      let i = 0
      const startStreaming = (): void => {
        const timer = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(timer)
            res.write('data: [DONE]\n\n')
            res.end()
            return
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
        }, 120)
      }
      // 慢速场景：先静默 4 秒（不返回任何 token），再开始流式
      if (wantsSlow) setTimeout(startStreaming, 4000)
      else startStreaming()
    })
  })
  await new Promise<void>((r) => ai.listen(0, '127.0.0.1', r))
  const aiPort = (ai.address() as { port: number }).port

  console.log(
    JSON.stringify({
      ready: true,
      sshPort: ssh.port,
      aiPort,
      aiBaseUrl: `http://127.0.0.1:${aiPort}/v1`,
      remoteRoot,
      localRoot
    })
  )
}

void main()
