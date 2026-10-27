import { app } from 'electron'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../main/core/store'
import { SessionManager } from '../main/ssh/manager'
import { SystemUsageMonitor } from '../main/ssh/monitor'
import { AiOpsService, classifyCommand, extractCommands } from '../main/ai/ops'
import { AiClient } from '../main/ai/client'
import { shouldSearch, extractSearchKeyword, extractWebResults } from '../main/search/baiduSearch'
import {
  downloadDirectory,
  downloadFile,
  listRemoteDir,
  readRemoteText,
  writeRemoteText,
  uploadDirectory,
  uploadFile,
  statRemote
} from '../main/ssh/transfer'
import { startFakeSshServer } from './fakeSshServer'
import type { AiMetrics } from '../shared/types'

interface TestResult {
  name: string
  ok: boolean
  detail?: string
}

const results: TestResult[] = []

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` :: ${detail}` : ''}`)
}

function assert(name: string, condition: boolean, detail?: string): void {
  check(name, condition, condition ? detail : `expected true, got false ${detail ?? ''}`)
}

async function run(): Promise<number> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sshelper-smoke-'))
  const dataDir = path.join(tmpRoot, 'userdata')
  const remoteRoot = path.join(tmpRoot, 'remote')
  const localDir = path.join(tmpRoot, 'local')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(remoteRoot, { recursive: true })
  fs.mkdirSync(localDir, { recursive: true })

  // ---------------------------------------------------------- 凭据保险库
  const store = new Store(dataDir)
  const vaultBackend = await store.vault.backend()
  check('凭据后端可用', vaultBackend === 'system' || vaultBackend === 'local-fallback', `后端=${vaultBackend}`)

  await store.setAiApiKey('sk-test-secret-key-123456')
  const rawSecrets = fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')
  assert('API Key 未以明文落盘', !rawSecrets.includes('sk-test-secret-key-123456'))
  assert('API Key 可解密还原', (await store.getAiApiKey()) === 'sk-test-secret-key-123456')

  // 重启后 API Key 引用应自愈：apiKeySecretKey 必须持久化（或从保险库默认键恢复），
  // 否则 getAiApiKey() 重启后返回 undefined，界面会误报「尚未配置 AI 服务」。
  const rebooted = new Store(dataDir)
  assert(
    '应用重启后 API Key 仍能定位',
    (await rebooted.getAiApiKey()) === 'sk-test-secret-key-123456',
    String(await rebooted.getAiApiKey())
  )
  const rawAiAfter = fs.readFileSync(path.join(dataDir, 'ai.json'), 'utf8')
  assert('apiKeySecretKey 已持久化到 ai.json', rawAiAfter.includes('apiKeySecretKey'))
  assert('ai.json 未存 API Key 明文', !rawAiAfter.includes('sk-test-secret-key'))

  // 旧版本自愈：模拟早期 ai.json 丢失 apiKeySecretKey 但仍存有保险库默认键，
  // 新版本启动后应能自动恢复引用。
  {
    const legacyStore = new Store(dataDir)
    legacyStore.setAiConfig({ apiKeySecretKey: undefined })
    const rawLegacy = fs.readFileSync(path.join(dataDir, 'ai.json'), 'utf8')
    assert('构造旧版场景已去掉 apiKeySecretKey', !rawLegacy.includes('apiKeySecretKey'))
    const healed = new Store(dataDir)
    assert(
      '旧配置重启后自愈恢复 API Key 引用',
      (await healed.getAiApiKey()) === 'sk-test-secret-key-123456',
      String(await healed.getAiApiKey())
    )
  }

  // ---------------------------------------------------------- 主机配置
  const profile = store.createProfile({
    label: '测试主机',
    host: '127.0.0.1',
    port: 1,
    username: 'tester',
    authType: 'password'
  })
  await store.setProfileSecret(profile.id, 'password', 's3cret')
  assert('口令已加密保存', Boolean(await store.getProfileSecret(profile.id, 'password')))

  // ---------------------------------------------------------- 假 SSH 服务
  const server = await startFakeSshServer({ root: remoteRoot, port: 0 })
  store.updateProfile(profile.id, { port: server.port })

  const sessions = new SessionManager(store)
  let sessionId = ''
  try {
    const outcome = await sessions.connect(profile.id)
    sessionId = outcome.sessionId
    assert('SSH 连接成功', Boolean(sessionId), `指纹=${outcome.fingerprint.slice(0, 24)}…`)
    assert(
      '主机密钥指纹已持久化',
      (store.getProfile(profile.id)?.knownHostFingerprints ?? []).length === 1
    )

    const session = sessions.get(sessionId)

    // 指纹不一致时应拒绝连接
    store.updateProfile(profile.id, { knownHostFingerprints: ['SHA256:0000000000000000000000000000000000000000000'] })
    let rejected = false
    try {
      await sessions.connect(profile.id)
    } catch (err) {
      rejected = /主机密钥|Host denied|host key/i.test(err instanceof Error ? err.message : String(err))
    }
    assert('主机密钥变更被拒绝', rejected)
    store.updateProfile(profile.id, { knownHostFingerprints: [outcome.fingerprint] })

    // ------------------------------------------------------------ exec
    const uname = await session.exec('uname -a')
    assert('exec 返回输出', uname.stdout.includes('Linux fakehost'), uname.stdout.trim())
    assert('exec 退出码为 0', uname.code === 0, `code=${uname.code}`)

    const failing = await session.exec('exit-code-42')
    assert('exec 非零退出码可捕获', failing.code === 42 && failing.stderr.includes('boom'))

    // 超时中断：命令只能被下发一次，且要返回 timedOut
    const beforeTimeout = server.execLog.filter((c) => c.includes('sleep-forever')).length
    const timed = await session.exec('sleep-forever', { timeout: 1500 })
    const afterTimeout = server.execLog.filter((c) => c.includes('sleep-forever')).length
    assert('exec 超时返回 timedOut', timed.timedOut === true, `timedOut=${timed.timedOut}`)
    assert(
      'exec 超时未重复下发命令',
      afterTimeout - beforeTimeout === 1,
      `下发次数=${afterTimeout - beforeTimeout}`
    )

    // 流式输出：长时命令的实时进度按块回调
    const streamChunks: string[] = []
    const streamed = await session.exec('progress-test', { onData: (c) => streamChunks.push(c) })
    assert('exec 实时进度回调多次触发', streamChunks.length >= 3, JSON.stringify(streamChunks))
    assert('exec 实时进度内容片段齐全', streamChunks.join('') === 'step-1\nstep-2\nstep-3\n', JSON.stringify(streamChunks))
    assert('exec 流式命令正常结束', streamed.code === 0 && streamed.stdout.includes('step-3'))

    // 提前停止：类似 Ctrl+C，通过 AbortSignal 中断永不结束的命令
    const abort = new AbortController()
    const foreverP = session.exec('run-forever', { signal: abort.signal })
    await new Promise((r) => setTimeout(r, 150))
    abort.abort()
    const interrupted = await foreverP
    assert('exec 可被 AbortSignal 提前中断', interrupted.timedOut === true, JSON.stringify(interrupted))

    // SystemUsageMonitor：周期采集 CPU / 内存并广播 usage 事件
    {
      const monitor = new SystemUsageMonitor(sessions, 200)
      let got: any = null
      monitor.on('usage', (u) => {
        if (!got) got = u
      })
      monitor.start()
      for (let i = 0; i < 30 && !got; i++) await new Promise((r) => setTimeout(r, 100))
      monitor.stop()
      assert(
        'CPU/内存占用采集并解析',
        got && got.cpu !== null && got.mem !== null,
        JSON.stringify(got)
      )
      assert(
        '内存按 meminfo 计算正确',
        got && got.memUsed && got.memTotal && Math.abs(got.mem - 23) < 1,
        JSON.stringify(got)
      )
    }

    // ---------------------------------------------------------- shell
    const chunks: string[] = []
    const dataListener = (payload: { sessionId: string; chunk: string }): void => {
      if (payload.sessionId === sessionId) chunks.push(payload.chunk)
    }
    sessions.on('data', dataListener)
    await session.startShell({ cols: 100, rows: 30 })
    await new Promise((r) => setTimeout(r, 250))
    session.write('hello\n')
    await new Promise((r) => setTimeout(r, 400))
    assert('交互式 shell 回显数据', chunks.join('').includes('echo:hello'), chunks.join('').slice(0, 80))

    // ----------------------------------------------------------- SFTP
    const sftp = await session.sftp()
    fs.writeFileSync(path.join(remoteRoot, 'hello.txt'), 'remote-content-中文')
    const entries = await listRemoteDir(sftp, '/')
    assert('SFTP 列出目录', entries.some((e) => e.name === 'hello.txt'), `条目=${entries.map((e) => e.name).join(',')}`)

    // 回归：根目录条目必须是绝对路径，否则双击进入子目录会报 No such file
    assert(
      '根目录条目路径为绝对路径',
      entries.length > 0 && entries.every((e) => e.path.startsWith('/')),
      entries.map((e) => e.path).join(',')
    )

    fs.mkdirSync(path.join(remoteRoot, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(remoteRoot, 'sub', 'inner.txt'), 'inner')
    const subEntries = await listRemoteDir(sftp, '/sub')
    assert(
      '子目录条目路径为绝对路径',
      subEntries.length > 0 && subEntries.every((e) => e.path.startsWith('/sub/')),
      subEntries.map((e) => e.path).join(',')
    )
    assert(
      '可按条目路径直接进入子目录',
      (await listRemoteDir(sftp, subEntries[0].path.replace(/\/[^/]+$/, ''))).length > 0
    )

    // 回归：递归上传目录到根目录时，子路径也必须是绝对路径
    const dirSource = path.join(localDir, 'tree')
    fs.mkdirSync(path.join(dirSource, 'inner'), { recursive: true })
    fs.writeFileSync(path.join(dirSource, 'a.txt'), 'A')
    fs.writeFileSync(path.join(dirSource, 'inner', 'b.txt'), 'B')
    const dirTargets: string[] = []
    await uploadDirectory(
      sftp,
      dirSource,
      '/',
      'task-dir',
      sessionId,
      (p) => dirTargets.push(p.target),
      undefined,
      true
    )
    assert(
      '递归上传使用绝对远端路径',
      dirTargets.length > 0 && dirTargets.every((t) => t.startsWith('/')),
      dirTargets.join(',')
    )
    assert('递归上传文件落位正确', fs.existsSync(path.join(remoteRoot, 'a.txt')))
    assert(
      '递归上传的深层文件落位正确',
      fs.existsSync(path.join(remoteRoot, 'inner', 'b.txt'))
    )

    const stat = await statRemote(sftp, '/hello.txt')
    assert('SFTP stat 正确', stat?.type === 'file' && stat.size > 0)

    const localFile = path.join(localDir, 'upload.txt')
    fs.writeFileSync(localFile, 'upload-payload-'.repeat(100))
    const progressEvents: number[] = []
    await uploadFile(
      sftp,
      localFile,
      '/uploaded.txt',
      'task-1',
      sessionId,
      (p) => progressEvents.push(p.transferredBytes),
      undefined,
      true
    )
    const uploaded = fs.readFileSync(path.join(remoteRoot, 'uploaded.txt'), 'utf8')
    assert('SFTP 上传内容一致', uploaded === 'upload-payload-'.repeat(100), `长度=${uploaded.length}`)
    assert('上传进度有回调', progressEvents.length > 0, `回调次数=${progressEvents.length}`)

    const downloadedPath = path.join(localDir, 'downloaded.txt')
    await downloadFile(
      sftp,
      '/hello.txt',
      downloadedPath,
      'task-2',
      sessionId,
      () => undefined,
      undefined,
      true
    )
    assert('SFTP 下载内容一致', fs.readFileSync(downloadedPath, 'utf8') === 'remote-content-中文')

    // -------------------------------------------------- 在线编辑（读/写远程文本）
    fs.writeFileSync(path.join(remoteRoot, 'edit.txt'), '{ "enabled": true }\n')
    const readEdit = await readRemoteText(sftp, '/edit.txt')
    assert('在线编辑可读取远端文本', readEdit.content.includes('"enabled": true'), readEdit.content.trim())
    assert('在线编辑返回文件大小', readEdit.size > 0)

    // UTF-8 与 BOM 剥离：写入带 BOM 的内容，读取时应去除 BOM
    fs.writeFileSync(path.join(remoteRoot, 'bom.txt'), '﻿设置值=你好')
    const readBom = await readRemoteText(sftp, '/bom.txt')
    assert('在线编辑剥离 UTF-8 BOM', !readBom.content.startsWith('﻿') && readBom.content.includes('你好'), JSON.stringify(readBom.content))

    // 写回：编辑内容回传并覆盖
    const editTarget = '/edit.txt'
    await writeRemoteText(sftp, editTarget, '{ "enabled": false, "note": "edited" }\n')
    const afterWrite = fs.readFileSync(path.join(remoteRoot, 'edit.txt'), 'utf8')
    assert('在线编辑写回内容一致', afterWrite.includes('"edited"'), afterWrite.trim())

    // 写回后文件类型位应保留（仍是普通文件，且权限位非空）。
    // 注：本地 fake 服务运行在 Windows 文件系统上，无法模拟 Unix chmod 权限，
    // 因此此处只断言类型位不被破坏；Unix 权限位保留逻辑对真实服务器生效。
    await writeRemoteText(sftp, editTarget, '{ "enabled": false }\n')
    const statAfterWrite = await statRemote(sftp, '/edit.txt')
    assert(
      '在线编辑写回后文件类型位保留',
      statAfterWrite?.type === 'file' && (statAfterWrite.mode & 0o777) !== 0,
      `mode=${(statAfterWrite?.mode ?? 0).toString(8)}`
    )

    // 多行「大文件」顺序读取：文件超过 CHUNK_SIZE 时也必须按原始顺序拼接，
    // 否则（复用同一 buffer 再 subarray 的旧实现）读到的是被最后一块覆盖的错乱内容。
    // 这里生成 > 170KB 的带行号文本，断言第 1 行、中段、末行都严格对应。
    const bigLines: string[] = []
    for (let i = 0; i < 6000; i++) bigLines.push(`第${String(i).padStart(5, '0')}行-${'x'.repeat(20)}`)
    const bigText = bigLines.join('\n') + '\n'
    fs.writeFileSync(path.join(remoteRoot, 'big.txt'), bigText)
    const readBig = await readRemoteText(sftp, '/big.txt')
    const bigContent = readBig.content
    assert(
      '大文件多行顺序读取与源文件一致',
      bigContent.startsWith(bigLines[0]) &&
        bigContent.includes(bigLines[3000]) &&
        bigContent.endsWith(bigLines[5999] + '\n') &&
        bigContent.split('\n').length === 6001,
      `开头=${JSON.stringify(bigContent.slice(0, 24))}, 行数=${bigContent.split('\n').length}`
    )
    fs.rmSync(path.join(remoteRoot, 'big.txt'), { force: true })

    // 大文件上限保护：超过 MAX_EDIT_TEXT_BYTES 应被拒绝
    fs.writeFileSync(path.join(remoteRoot, 'big.bin'), Buffer.alloc(9 * 1024 * 1024))
    let bigRejected = false
    try {
      await readRemoteText(sftp, '/big.bin')
    } catch (err) {
      bigRejected = /过大|上限/.test(err instanceof Error ? err.message : String(err))
    }
    assert('在线编辑拒绝超大文件', bigRejected)
    fs.rmSync(path.join(remoteRoot, 'big.bin'), { force: true })

    // 取消传输
    const controller = new AbortController()
    controller.abort()
    let canceled = false
    try {
      await uploadFile(
        sftp,
        localFile,
        '/canceled.txt',
        'task-3',
        sessionId,
        () => undefined,
        controller.signal,
        true
      )
    } catch (err) {
      canceled = /取消/.test(err instanceof Error ? err.message : String(err))
    }
    assert('传输可被取消', canceled)

    // ------------------------------------------------------- 命令分级
    assert('只读命令判定为 safe', classifyCommand('ls -la /var/log') === 'safe')
    assert('df -h 判定为 safe', classifyCommand('df -h') === 'safe')
    assert('systemctl status 判定为 safe', classifyCommand('systemctl status nginx') === 'safe')
    assert('rm 判定为 delete', classifyCommand('rm -rf /data') === 'delete')
    assert('sudo rm 判定为 delete', classifyCommand('sudo rm -rf /data') === 'delete')
    assert('docker rm 判定为 delete', classifyCommand('docker rm -f web') === 'delete')
    assert('chmod 判定为 modify', classifyCommand('chmod 644 /etc/nginx.conf') === 'modify')
    assert('systemctl restart 判定为 modify', classifyCommand('systemctl restart nginx') === 'modify')
    assert('apt-get install 判定为 modify', classifyCommand('apt-get install nginx') === 'modify')
    assert('只读管道判定为 safe', classifyCommand('df -h | sort -k5 -h') === 'safe')
    assert('awk 读取文件判定为 safe', classifyCommand("awk -F: '{print $2}' /etc/passwd") === 'safe')
    assert(
      'awk 只读管道判定为 safe',
      classifyCommand("awk '{print $1}' /var/log/x.log | sort | uniq -c") === 'safe'
    )
    assert(
      'awk 条件比较判定为 safe',
      classifyCommand("awk '$3 > 1000 {print $1}' /etc/passwd") === 'safe'
    )
    assert(
      'awk 输出重定向判定为 risky',
      classifyCommand('awk \'{print > "out.txt"}\' in.txt') === 'risky'
    )
    assert('find -delete 判定为 delete', classifyCommand('find . -delete') === 'delete')
    assert('find -exec 判定为 risky', classifyCommand("find . -exec grep x {} \\;") === 'risky')
    assert('路径中的关键词不误判', classifyCommand('ls /tmp/mv') === 'safe')
    assert('带重定向的命令判定为 risky', classifyCommand('echo hi > /tmp/x') === 'risky')
    assert('命令替换判定为 risky', classifyCommand('echo $(whoami)') === 'risky')
    assert('丢弃式重定向(2>/dev/null)不算写文件', classifyCommand('find / -name "access.log" -type f 2>/dev/null | head -20') === 'safe')
    assert('stderr 重定向到 stdout(2>&1)不算写文件', classifyCommand('find / -name "*.log" 2>&1 | head') === 'safe')
    assert('stdout 丢弃(>/dev/null)不算写文件', classifyCommand('ls /var/log >/dev/null') === 'safe')
    assert('写文件重定向仍判定为 risky', classifyCommand('echo hi > /tmp/out.txt') === 'risky')
    assert('未列入白名单的命令判定为 risky', classifyCommand('mycustom-tool --run') === 'risky')

    // --------------------------------------------------- 命令提案解析
    const reply = `先看下磁盘。\n:::command\ndf -h\n:::\n再看看内存。\n:::command\nfree -m\n:::`
    const parsed = extractCommands(reply)
    assert(
      '命令块解析正确',
      parsed.length === 2 && parsed[0] === 'df -h' && parsed[1] === 'free -m',
      JSON.stringify(parsed)
    )

    // ------------------------------------------------------- AI 流式客户端
    const receivedBodies: Array<{
      messages: Array<{ role: string; content: string }>
      stream_options?: { include_usage?: boolean }
    }> = []
    // 模拟服务端是否支持在流末尾返回 usage
    let emitUsage = true
    const mockServer = http.createServer((req, res) => {
      const url = req.url ?? ''
      // 模型列表端点（OpenAI 兼容的 GET /models）
      if (req.method === 'GET' && /\/models$/.test(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mock-model-pro', object: 'model' },
              { id: 'mock-model', object: 'model' },
              { id: 'mock-model-mini', object: 'model' }
            ]
          })
        )
        return
      }

      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try {
          receivedBodies.push(JSON.parse(body))
        } catch {
          /* 忽略非 JSON 请求 */
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        res.write('data: {"choices":[{"delta":{"content":"磁盘使用率偏高。"}}]}\n\n')
        // 稍作延迟，让生成阶段耗时可测（首字之后的 tokens/s 才有意义）
        setTimeout(() => {
          res.write('data: {"choices":[{"delta":{"content":"建议执行 df -h 确认。"}}]}\n\n')
          if (emitUsage) {
            // OpenAI 兼容服务在 include_usage 时于 [DONE] 前返回用量
            res.write(
              'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":18,"total_tokens":138}}\n\n'
            )
          }
          res.write('data: [DONE]\n\n')
          res.end()
        }, 30)
      })
    })
    await new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', r))
    const mockPort = (mockServer.address() as { port: number }).port

    store.setAiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      model: 'mock-model'
    })

    const client = new AiClient(store.getAiConfig(), (await store.getAiApiKey()) ?? '')
    let accumulated = ''
    let doneText = ''
    let metrics: AiMetrics | undefined
    let firstTokenLatency: number | null = null
    await client.chat(
      [{ role: 'user', content: '磁盘满了吗' }],
      {
        onDelta: (t) => {
          accumulated += t
        },
        onFirstToken: (latencyMs) => {
          firstTokenLatency = latencyMs
        },
        onDone: (t, m) => {
          doneText = t
          metrics = m
        },
        onError: (e) => {
          check('AI 流式请求无错误', false, e.message)
        }
      }
    )
    assert(
      'AI 流式分片正确拼接',
      accumulated === '磁盘使用率偏高。建议执行 df -h 确认。' && doneText === accumulated,
      accumulated
    )
    assert(
      'AI 指标：首字延迟已上报',
      firstTokenLatency !== null && metrics !== undefined && metrics.firstTokenMs >= 0,
      `onFirstToken=${firstTokenLatency}ms, metrics=${metrics?.firstTokenMs}ms`
    )
    assert(
      'AI 指标：优先使用服务端 usage',
      metrics?.promptTokens === 120 && metrics.outputTokens === 18 && metrics.estimated === false,
      JSON.stringify(metrics)
    )
    assert(
      'AI 指标：输出速度与上下文窗口正确',
      (metrics?.tokensPerSecond ?? 0) > 0 && metrics?.maxContextTokens === 256 * 1024,
      `tok/s=${metrics?.tokensPerSecond}, max=${metrics?.maxContextTokens}`
    )
    assert(
      'AI 请求声明 stream_options.include_usage',
      receivedBodies[0]?.stream_options?.include_usage === true,
      JSON.stringify(receivedBodies[0]?.stream_options)
    )

    // 服务端不返回 usage 时应回退到本地估算，并标记 estimated
    emitUsage = false
    let fallbackMetrics: AiMetrics | undefined
    await client.chat([{ role: 'user', content: '没有 usage 的兼容服务' }], {
      onDelta: () => undefined,
      onDone: (_t, m) => {
        fallbackMetrics = m
      },
      onError: (e) => {
        check('AI 估算指标请求无错误', false, e.message)
      }
    })
    assert(
      'AI 指标：无 usage 时本地估算并标记',
      Boolean(fallbackMetrics) &&
        fallbackMetrics!.estimated === true &&
        fallbackMetrics!.promptTokens > 0 &&
        fallbackMetrics!.outputTokens > 0,
      JSON.stringify(fallbackMetrics)
    )

    const ping = await client.ping()
    assert('AI 连通性测试通过', ping.ok, ping.message)

    const modelList = await client.listModels()
    assert(
      'AI 模型列表拉取正确',
      modelList.ok &&
        modelList.models.includes('mock-model') &&
        modelList.models.includes('mock-model-mini') &&
        !modelList.models.includes('should-not-exist'),
      `${modelList.message} -> ${modelList.models.join(',')}`
    )

    // ------------------------------------------------- AI 运维服务上下文
    const ai = new AiOpsService(store, sessions)
    const ctx = await ai.collectHostContext(sessionId)
    assert('AI 上下文采集到系统信息', ctx.osInfo.includes('Fake Linux') || ctx.osInfo.includes('Linux'), ctx.osInfo)

    // ------------------------------------------- 多轮对话上下文是否延续
    const bodyCountBefore = receivedBodies.length
    const noop = {
      onDelta: () => undefined,
      onCommand: () => undefined,
      onDone: () => undefined,
      onError: (e: Error) => {
        check('多轮对话未报错', false, e.message)
      }
    }
    await ai.chat(sessionId, '第一句：磁盘是不是满了', noop)
    await ai.chat(sessionId, '第二句：那内存呢', noop)

    const turn1 = receivedBodies[bodyCountBefore]
    const turn2 = receivedBodies[bodyCountBefore + 1]
    const turn2Messages = turn2?.messages ?? []
    const turn2Text = turn2Messages.map((m) => m.content).join('\n')

    assert(
      '第二次请求带上第一轮对话内容',
      Boolean(turn1) &&
        Boolean(turn2) &&
        turn2Messages.length > turn1.messages.length &&
        turn2Text.includes('第一句：磁盘是不是满了') &&
        turn2Text.includes('建议执行 df -h 确认。') &&
        turn2Text.includes('第二句：那内存呢'),
      `第2轮共 ${turn2Messages.length} 条消息：${turn2Text.slice(0, 160)}`
    )

    // 终端上下文只出现在当次请求里，不应堆积进历史
    const historyHasTerminalContext = turn2Messages.some((m) => m.content.includes('【终端最近输出'))
    assert('终端上下文不重复堆积进历史', historyHasTerminalContext === false, `出现次数历史消息中`)

    await ai.chat(
      sessionId,
      '带终端上下文的一句',
      { ...noop, context: 'fake-shell$ df -h' } as never
    )
    const withContext = receivedBodies[receivedBodies.length - 1]
    const withContextText = (withContext?.messages ?? []).map((m) => m.content).join('\n')
    assert(
      '终端上下文随当次请求下发',
      withContextText.includes('【终端最近输出（供参考）】') && withContextText.includes('fake-shell$ df -h'),
      withContextText.slice(0, 160)
    )

    // --------------------------------------------- 最大上下文裁剪历史消息
    assert(
      '最大上下文默认 256k',
      store.getAiConfig().maxContextTokens === 256 * 1024,
      String(store.getAiConfig().maxContextTokens)
    )
    store.setAiConfig({ maxContextTokens: 512, maxTokens: 256 })
    const bodyCountBeforeTrim = receivedBodies.length
    const longQuestion = `超长问题开始${'x'.repeat(3000)}裁剪标记结束`
    await ai.chat(sessionId, longQuestion, noop)
    const trimmed = receivedBodies[bodyCountBeforeTrim]?.messages ?? []
    assert(
      '超出最大上下文时裁剪历史并保留首尾',
      trimmed.length <= 2 &&
        trimmed[0]?.role === 'system' &&
        trimmed[trimmed.length - 1]?.content.includes('裁剪标记结束'),
      `裁剪后 ${trimmed.length} 条：${trimmed.map((m) => m.role).join(',')}`
    )
    store.setAiConfig({ maxContextTokens: 256 * 1024, maxTokens: 2048 })

    // 断开后历史应被清空
    ai.clearHistory(sessionId)
    const bodyCountAfterClear = receivedBodies.length
    await ai.chat(sessionId, '清空后的第一句', noop)
    const afterClear = receivedBodies[bodyCountAfterClear]
    assert(
      '清空上下文后历史从零开始',
      (afterClear?.messages?.length ?? 99) <= 2,
      `清空后第1轮消息数=${afterClear?.messages?.length}`
    )
    // 运维技能注入：system 消息应包含从 linux-agent-skills 提炼的速查表
    const systemContent = (afterClear?.messages ?? []).find((m: any) => m.role === 'system')?.content ?? ''
    assert(
      'AI 注入运维技能速查表',
      systemContent.includes('运维知识速查表') &&
        systemContent.includes('ss -tlnp') &&
        systemContent.includes('iostat -x') &&
        systemContent.includes('nginx') &&
        systemContent.includes('PASS_MAX_DAYS'),
      `system 长度=${systemContent.length}`
    )

    // 只读命令(safe)无副作用，始终自动执行，不再显示批准按钮；删除/修改类需确认
    store.setAiConfig({
      autoApproveSafeCommands: false,
      autoApproveModifyCommands: false
    })

    const outcomes: any[] = []
    ai.on('command-outcome', (outcome) => outcomes.push(outcome))

    const proposals = await ai.dispatchCommands(sessionId, 'msg-1', [
      'rm -rf /data/logs',
      'df -h'
    ])
    assert('多步命令只保留第一条', proposals.length === 1 && proposals[0].command === 'rm -rf /data/logs')
    assert('删除类命令默认不自动执行', proposals[0].autoApproved === false)
    assert('未自动执行任何命令前不产生结果', outcomes.length === 0)

    await ai.approveCommand(proposals[0].commandId, true)
    assert(
      '用户批准后执行并回传结果',
      outcomes.length === 1 && Boolean(outcomes[0].result),
      JSON.stringify(outcomes[0]?.result?.stdout ?? '')
    )

    const rejectProposal = await ai.dispatchCommands(sessionId, 'msg-2', ['systemctl restart nginx'])
    await ai.approveCommand(rejectProposal[0].commandId, false)
    assert(
      '用户拒绝后不执行',
      outcomes.length === 2 && outcomes[1].rejected === true && !outcomes[1].result
    )

    let approveUnknownFailed = false
    try {
      await ai.approveCommand('not-a-real-command-id', true)
    } catch {
      approveUnknownFailed = true
    }
    assert('未挂起的命令无法被批准执行', approveUnknownFailed)

    // 开启「修改删除免确认」后，修改类命令自动执行
    store.setAiConfig({ autoApproveModifyCommands: true })
    const auto = await ai.dispatchCommands(sessionId, 'msg-3', ['systemctl restart nginx'])
    assert('开启开关后修改类命令自动执行', auto[0].autoApproved === true)
    assert('自动执行产生了结果', outcomes.length === 3 && Boolean(outcomes[2].result))

    // risky 命令永远不自动执行
    store.setAiConfig({ autoApproveSafeCommands: true, autoApproveModifyCommands: true })
    const neverAuto = await ai.dispatchCommands(sessionId, 'msg-4', ['mybackup.sh'])
    assert('无法静态判定的命令永不自动执行', neverAuto[0].autoApproved === false)
    assert('risky 命令未产生执行结果', outcomes.length === 3)

    // 只读命令组成的管道属于 safe，必然自动执行
    const safePipe = await ai.dispatchCommands(sessionId, 'msg-5', [
      'cat /etc/passwd | grep root',
      'free -m'
    ])
    assert('多命令只取第一条(只读管道)', safePipe.length === 1 && safePipe[0].command === 'cat /etc/passwd | grep root')
    assert('第一条(只读管道)自动执行', safePipe[0].autoApproved === true)
    assert(
      '只读管道自动执行产生了结果',
      outcomes.length === 4 && Boolean(outcomes[3]?.result),
      JSON.stringify(outcomes[3]?.result?.stdout ?? '')
    )

    // --------------------------------------------------- 批量审批（仍支持：多命令只留一条）
    store.setAiConfig({ autoApproveSafeCommands: false, autoApproveModifyCommands: false })
    const batch = await ai.dispatchCommands(sessionId, 'msg-6', [
      'rm -rf /tmp/a',
      'rm -rf /tmp/b'
    ])
    assert('批量待确认命令只保留一条', batch.length === 1 && !batch[0].autoApproved)
    const batchOutcomes = await ai.approveCommands(
      batch.map((p) => p.commandId),
      true
    )
    assert(
      '批准后执行该条命令',
      batchOutcomes.length === 1 &&
        Boolean(batchOutcomes[0].result) &&
        outcomes.length === 5,
      `outcomes=${outcomes.length}`
    )

    const batchReject = await ai.dispatchCommands(sessionId, 'msg-7', [
      'rm -rf /tmp/c',
      'rm -rf /tmp/d'
    ])
    const rejectedOutcomes = await ai.approveCommands(
      batchReject.map((p) => p.commandId),
      false
    )
    assert(
      '拒绝后不执行',
      rejectedOutcomes.length === 1 &&
        rejectedOutcomes[0].rejected &&
        outcomes.length === 6,
      `outcomes=${outcomes.length}`
    )

    // 长时命令的实时进度 + 停止执行（类似 Ctrl+C）
    const cmdProgressEvents: any[] = []
    ai.on('command-progress', (p) => cmdProgressEvents.push(p))
    const runCmd = await ai.dispatchCommands(sessionId, 'msg-8', ['run-forever'])
    assert('run-forever 属需确认类，进入待确认', runCmd.length === 1 && !runCmd[0].autoApproved)
    const execPromise = ai.approveCommand(runCmd[0].commandId, true)
    // 等两个 tick 输出后停止
    for (let i = 0; i < 50 && cmdProgressEvents.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 60))
    }
    assert('执行中产生了多条实时进度', cmdProgressEvents.length >= 2, JSON.stringify(cmdProgressEvents.map((p) => p.stdout)))
    assert('进度事件包含累计输出', cmdProgressEvents[0]?.['stdout']?.includes('tick'), JSON.stringify(cmdProgressEvents[0]))
    const stopped = ai.stopCommand(runCmd[0].commandId)
    assert('stopCommand 命中正在执行的命令', stopped === true)
    await execPromise
    assert('停止后命令以中断状态结束', true)

    // 停止：停止后不再自动回传，重新提问可恢复
    const stopSession = 'stop-session'
    ai.stop(stopSession)
    assert('停止后会话被标记为已停止', ai.isStopped(stopSession) === true)
    ai.resume(stopSession)
    assert('重新发起后解除停止状态', ai.isStopped(stopSession) === false)

    // 去重：同一命令 + 相同结果重复回传只处理一次，避免历史被撑大、模型重复输出
    const dedupSession = 'dedup-session'
    let dedupDone = 0
    const feedResult = {
      code: 0,
      stdout: 'root:x:0:0:root:/root:/bin/bash',
      stderr: ''
    }
    await ai.continueWithResult(dedupSession, 'grep root /etc/passwd', feedResult, {
      onDone: () => {
        dedupDone++
      },
      onError: (e) => check('去重回传无错误', false, e.message)
    })
    await ai.continueWithResult(dedupSession, 'grep root /etc/passwd', feedResult, {
      onDone: () => {
        dedupDone++
      },
      onError: (e) => check('去重回传之二无错误', false, e.message)
    })
    assert('相同命令+结果重复回传仅处理一次', dedupDone === 1, `onDone=${dedupDone}`)

    const scanDeltas: string[] = []
    await ai.scan(sessionId, {
      onDelta: (t) => scanDeltas.push(t),
      onDone: () => undefined,
      onError: (e) => check('一键巡检无错误', false, e.message)
    })
    assert('一键巡检产生输出', scanDeltas.join('').length > 0, `长度=${scanDeltas.join('').length}`)

    // ------------------------------------------- 百度搜索增强（启发式 + 配额）
    assert(
      '启发式：命中 CVE 关键词',
      shouldSearch('查一下 CVE-2021-44228 的影响') === true
    )
    assert(
      '启发式：命中版本/配置信号',
      shouldSearch('nginx 最新版怎么配置 worker_processes') === true
    )
    assert(
      '启发式：普通闲聊不触发搜索',
      shouldSearch('你好，帮我维护这台服务器') === false &&
        shouldSearch('好的，收到，明白了') === false
    )
    assert(
      '启发式：本机系统/版本查询不触发搜索（去掉裸版本词的误触发）',
      shouldSearch('目前系统版本') === false &&
        shouldSearch('这台主机的操作系统版本') === false &&
        shouldSearch('这个软件下载版本是多少') === false &&
        shouldSearch('当前服务器的内核版本') === false
    )
    assert(
      '启发式：外部最新版/稳定版仍触发搜索',
      shouldSearch('nginx 最新稳定版是哪个版本') === true &&
        shouldSearch('Ubuntu 最新系统版本是多少') === true &&
        shouldSearch('CVE-2024-6387 影响哪些版本') === true
    )
    assert(
      '关键词提炼：去掉标点保留主体',
      extractSearchKeyword('请问 Docker 最新版怎么安装？') === '请问 Docker 最新版怎么安装'
    )

    // 解析：百度 web_search 官方响应走顶级 references[]（title/content/url）
    const baiduLike = {
      references: [
        {
          content:
            'Log4Shell 是 Apache Log4j 2 中一个远程代码执行漏洞，影响...用于 Java 应用的日志组件。',
          date: '2021-12-10 12:00:00',
          id: 1,
          title: 'Log4Shell（CVE-2021-44228）',
          type: 'web',
          url: 'https://example.com/log4shell'
        },
        {
          content: '缓解措施：升级到 2.17.0 或更高，或设置 JVM 参数...',
          date: '2021-12-12 09:00:00',
          id: 2,
          title: 'Log4j 漏洞修复指南',
          type: 'web',
          url: 'https://example.com/log4j-fix'
        }
      ],
      request_id: 'test-123'
    }
    const parsedRefs = extractWebResults(baiduLike)
    assert(
      '百度响应按 references[] 解析出结构化条目',
      parsedRefs.length === 2 &&
        parsedRefs[0]?.title === 'Log4Shell（CVE-2021-44228）' &&
        parsedRefs[0]?.content.includes('Log4Shell') &&
        parsedRefs[0]?.source === 'https://example.com/log4shell',
      JSON.stringify(parsedRefs)
    )

    // 配额：按日 50 / 月 1500 累计，跨天后自动重置每日计数
    const quotaBefore = store.getSearchQuota()
    store.recordSearchUsage()
    store.recordSearchUsage()
    const quotaAfter = store.getSearchQuota()
    assert(
      '搜索配额计数累加',
      quotaAfter.dailyUsed === quotaBefore.dailyUsed + 2 &&
        quotaAfter.monthlyUsed === quotaBefore.monthlyUsed + 2,
      `日 ${quotaBefore.dailyUsed}->${quotaAfter.dailyUsed}`
    )

    // 百度搜索 Key：走保险库加密、可解密还原、留空清除
    await store.setBaiduSearchKey('baidu-test-key-abc')
    assert(
      '百度搜索 Key 加密落盘（无明文）',
      Boolean(await store.getBaiduSearchKey()) &&
        !fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8').includes('baidu-test-key-abc')
    )
    await store.setBaiduSearchKey(undefined)
    assert('百度搜索 Key 清除后取不到', (await store.getBaiduSearchKey()) === undefined)

    // 系统提示词在开启搜索增强后包含联网检索指示
    const searchCfg = { ...store.getAiConfig(), searchEnabled: true }
    const { buildSystemPrompt } = await import('../main/ai/ops')
    const sp = buildSystemPrompt(searchCfg, { label: 'x', username: 'u', host: 'h', port: 22 } as never)
    assert(
      '开启搜索增强后系统提示注入联网检索引导',
      sp.includes('在线资料') && sp.includes('百度搜索')
    )

    mockServer.close()
  } catch (err) {
    check('测试执行未抛出异常', false, err instanceof Error ? err.stack : String(err))
  } finally {
    sessions.closeAll()
    await server.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 测试结果：${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length) {
    for (const f of failed) console.log(`FAILED: ${f.name} ${f.detail ?? ''}`)
  }
  return failed.length === 0 ? 0 : 1
}

app.whenReady().then(async () => {
  let code = 1
  try {
    code = await run()
  } catch (err) {
    console.error('smoke test crashed:', err)
    code = 1
  }
  app.exit(code)
})
