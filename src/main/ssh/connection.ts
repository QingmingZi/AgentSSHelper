import {
  Client,
  utils as ssh2utils,
  type ClientChannel,
  type ConnectConfig,
  type SFTPWrapper
} from 'ssh2'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { CommandResult, HostProfile } from '@shared/types'

export interface SessionCredentials {
  password?: string
  passphrase?: string
  privateKeyPath?: string
}

export interface ExecOptions {
  /** 使用 sudo -S 执行（口令从 stdin 注入） */
  sudo?: boolean
  /** 超时毫秒，默认 60s */
  timeout?: number
  /** 工作目录 */
  cwd?: string
  /** 提前中断 */
  signal?: AbortSignal
  /** 每收到一段输出时回调（stdout 与 stderr 合流），用于长时命令实时进度 */
  onData?: (chunk: string) => void
}

export interface ShellOptions {
  term?: string
  cols?: number
  rows?: number
  cwd?: string
  /** 自动应答 sudo 口令提示 */
  autoSudoPassword?: boolean
}

export interface ConnectResult {
  fingerprint: string
  keyType: string
  serverVersion: string
}

/** 计算 OpenSSH 风格指纹：SHA256:base64(无填充) */
export function hostKeyFingerprint(rawKey: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')
}

export class SshSession extends EventEmitter {
  readonly id: string
  readonly profile: HostProfile

  private client: Client | null = null
  private shellChannel: ClientChannel | null = null
  private sftpClient: SFTPWrapper | null = null
  private connecting = false
  private closed = false
  private autoSudoPassword = false
  private sudoPassword: string | undefined
  private lastBuffer = ''

  constructor(id: string, profile: HostProfile) {
    super()
    this.id = id
    this.profile = profile
  }

  get isConnected(): boolean {
    return Boolean(this.client) && !this.closed
  }

  /**
   * 建立连接。
   * @param onTrust 首次连接（或用户显式信任）时回调服务器指纹，交由上层持久化
   */
  connect(credentials: SessionCredentials, onTrust: (fingerprint: string, keyType: string) => void): Promise<ConnectResult> {
    if (this.connecting) return Promise.reject(new Error('连接进行中'))
    this.connecting = true

    const profile = this.profile
    let negotiatedFingerprint = ''
    let negotiatedKeyType = ''
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.username,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      // 主机密钥校验：TOFU + 指纹比对
      hostVerifier: (rawKey: Buffer, verify?: (ok: boolean) => void) => {
        const fingerprint = hostKeyFingerprint(rawKey)
        let keyType = 'unknown'
        try {
          const parsed = ssh2utils.parseKey(rawKey)
          if (parsed instanceof Error) throw parsed
          keyType = parsed.type
        } catch {
          /* ignore */
        }
        negotiatedFingerprint = fingerprint
        negotiatedKeyType = keyType
        const known = profile.knownHostFingerprints ?? []
        if (known.length === 0) {
          onTrust(fingerprint, keyType)
          if (verify) return verify(true)
          return true
        }
        const ok = known.includes(fingerprint)
        if (verify) return verify(ok)
        return ok
      }
    }

    if (profile.authType === 'password') {
      if (credentials.password) config.password = credentials.password
      config.tryKeyboard = true
    } else if (profile.authType === 'privateKey') {
      const keyPath = credentials.privateKeyPath || profile.privateKeyPath
      if (!keyPath) throw new Error('未配置私钥文件路径')
      config.privateKey = fs.readFileSync(keyPath)
      if (credentials.passphrase) config.passphrase = credentials.passphrase
      config.tryKeyboard = true
    } else if (profile.authType === 'agent') {
      const sock = process.env.SSH_AUTH_SOCK
      if (!sock) throw new Error('未找到 SSH Agent（SSH_AUTH_SOCK 未设置）')
      config.agent = sock
    }

    // 私钥模式下也允许同时提供口令（服务器仍要求口令时兜底）
    if (profile.authType === 'privateKey' && credentials.password && !config.password) {
      config.password = credentials.password
    }

    return new Promise<ConnectResult>((resolve, reject) => {
      const client = new Client()
      this.client = client
      let settled = false

      client.on('ready', () => {
        this.connecting = false
        const result: ConnectResult = {
          fingerprint: negotiatedFingerprint,
          keyType: negotiatedKeyType,
          serverVersion: (client as unknown as { _serverVersion?: string })._serverVersion?.replace(
            /^SSH-2\.0-/,
            ''
          ) ?? ''
        }
        if (!settled) {
          settled = true
          resolve(result)
        }
        this.emit('connected', result)
      })

      client.on('error', (err: Error & { level?: string }) => {
        this.connecting = false
        if (!settled) {
          settled = true
          reject(this.describeError(err))
        }
        this.emit('error', err)
      })

      // keyboard-interactive 认证（服务器只提供交互式口令时）
      client.on(
        'keyboard-interactive',
        (_name: string, _instructions: string, _lang: string, prompts: Array<{ prompt: string }>, finish: (answers: string[]) => void) => {
          const answers = prompts.map(() =>
            profile.authType === 'privateKey'
              ? (credentials.passphrase ?? credentials.password ?? '')
              : (credentials.password ?? '')
          )
          finish(answers)
        }
      )

      client.on('close', () => {
        this.closed = true
        this.connecting = false
        this.emit('close', { code: null })
      })

      client.on('end', () => {
        this.closed = true
        this.emit('close', { code: null })
      })

      try {
        client.connect(config)
      } catch (err) {
        this.connecting = false
        if (!settled) {
          settled = true
          reject(err as Error)
        }
      }
    })
  }

  private describeError(err: Error & { level?: string }): Error {
    const raw = err?.message || String(err)
    if (/All configured authentication methods failed/i.test(raw)) {
      return new Error('认证失败：用户名、密码或私钥不被服务器接受')
    }
    if (/Timed out while waiting for handshake/i.test(raw)) {
      return new Error(`连接超时（${this.profile.host}:${this.profile.port}），请检查网络或端口`)
    }
    if (/ECONNREFUSED/i.test(raw)) {
      return new Error(`连接被拒绝（${this.profile.host}:${this.profile.port}），服务可能未启动`)
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
      return new Error(`域名解析失败：${this.profile.host}`)
    }
    if (/Host denied|host key/i.test(raw)) {
      return new Error('主机密钥校验失败：服务器主机密钥与已记录指纹不一致')
    }
    return new Error(raw)
  }

  // -------------------------------------------------------------- shell

  startShell(options: ShellOptions = {}): Promise<void> {
    if (!this.client) return Promise.reject(new Error('尚未连接'))
    // 已经存在可用的 shell 通道时复用，避免同一连接上开出多个 shell
    if (this.shellChannel) {
      this.autoSudoPassword = options.autoSudoPassword ?? this.autoSudoPassword
      return Promise.resolve()
    }
    this.autoSudoPassword = options.autoSudoPassword ?? false
    return new Promise((resolve, reject) => {
      const opts = {
        term: options.term ?? 'xterm-256color',
        cols: options.cols ?? 120,
        rows: options.rows ?? 30
      }
      this.client!.shell(opts, (err, channel) => {
        if (err) return reject(new Error(err.message))
        this.shellChannel = channel

        channel.on('data', (data: Buffer) => {
          const text = data.toString('utf8')
          this.emit('data', text)
          if (this.autoSudoPassword) this.maybeAnswerSudo(text)
        })
        channel.stderr.on('data', (data: Buffer) => {
          this.emit('data', data.toString('utf8'))
        })
        channel.on('close', (code: number | null, signal?: string) => {
          this.shellChannel = null
          this.emit('shell-close', { code, signal })
        })
        channel.on('exit', (code: number | null, signal?: string) => {
          this.emit('shell-exit', { code, signal })
        })

        if (options.cwd) {
          channel.write(`cd ${shellQuote(options.cwd)}\n`)
        }
        resolve()
      })
    })
  }

  /** 检测 sudo 口令提示并自动应答（仅当启用了自动应答且已保存口令） */
  private maybeAnswerSudo(text: string): void {
    if (!this.sudoPassword) return
    this.lastBuffer = (this.lastBuffer + text).slice(-256)
    if (/\[sudo\] password for/i.test(this.lastBuffer)) {
      this.lastBuffer = ''
      this.shellChannel?.write(`${this.sudoPassword}\n`)
    }
  }

  write(data: string): void {
    this.shellChannel?.write(data)
  }

  resize(cols: number, rows: number): void {
    this.shellChannel?.setWindow(rows, cols, 0, 0)
  }

  // --------------------------------------------------------------- exec

  async exec(command: string, options: ExecOptions = {}): Promise<CommandResult> {
    if (!this.client) throw new Error('尚未连接')
    const timeout = options.timeout ?? 60_000
    let cmd = command
    let sudoPassword: string | undefined

    if (options.sudo) {
      cmd = `sudo -S -p '' ${command}`
      sudoPassword = this.sudoPassword
    }
    if (options.cwd) cmd = `cd ${shellQuote(options.cwd)} && ${cmd}`

    return new Promise<CommandResult>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let timedOut = false
      let settled = false
      let streamRef: { close: () => void } | null = null

      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
      }

      /** 中断当前执行的命令流（不重新执行） */
      const interrupt = (): void => {
        timedOut = true
        try {
          streamRef?.close()
        } catch {
          /* ignore */
        }
        // 立即结算：本地通道已强制关闭，避免依赖远程进程 close 事件
        // （run-forever 这类进程远端不退出时，close 可能永远不触发，
        //  导致命令卡片一直停在「执行中…」）。
        cleanup()
        if (!settled) {
          settled = true
          resolve({ code, stdout, stderr, timedOut })
        }
      }

      const timer = setTimeout(interrupt, timeout)
      const onAbort = (): void => interrupt()
      options.signal?.addEventListener('abort', onAbort, { once: true })

      this.client!.exec(cmd, (err, stream) => {
        if (err) {
          cleanup()
          if (!settled) {
            settled = true
            reject(new Error(err.message))
          }
          return
        }
        streamRef = stream
        stream.on('data', (d: Buffer) => {
          stdout += d.toString('utf8')
          options.onData?.(d.toString('utf8'))
        })
        stream.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8')
        })
        stream.on('exit', (c: number | null) => {
          code = c
        })
        stream.on('close', (c: number | null) => {
          cleanup()
          if (settled) return
          settled = true
          resolve({ code: code ?? c ?? null, stdout, stderr, timedOut })
        })
        if (sudoPassword) {
          stream.write(`${sudoPassword}\n`)
        }
      })
    })
  }

  // --------------------------------------------------------------- sftp

  sftp(): Promise<SFTPWrapper> {
    if (this.sftpClient) return Promise.resolve(this.sftpClient)
    if (!this.client) return Promise.reject(new Error('尚未连接'))
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) return reject(new Error(err.message))
        this.sftpClient = sftp
        sftp.on('close', () => {
          this.sftpClient = null
        })
        resolve(sftp)
      })
    })
  }

  setSudoPassword(password: string | undefined): void {
    this.sudoPassword = password
  }

  end(): void {
    this.closed = true
    try {
      this.shellChannel?.end()
    } catch {
      /* ignore */
    }
    try {
      this.client?.end()
    } catch {
      /* ignore */
    }
    this.client = null
    this.shellChannel = null
    this.sftpClient = null
    this.emit('close', { code: 0 })
  }
}

/** POSIX shell 单引号转义 */
export function shellQuote(input: string): string {
  return `'${String(input).replace(/'/g, `'\\''`)}'`
}
