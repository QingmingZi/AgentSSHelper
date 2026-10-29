import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import type { IPty } from 'node-pty'
import * as pty from 'node-pty'
import type {
  CommandResult,
  HostProfile
} from '@shared/types'
import type {
  ConnectResult,
  ExecOptions,
  ISshSession,
  SessionCredentials,
  ShellOptions
} from '../ssh/connection'
import { shellQuote } from '../ssh/connection'
import { WslSftp } from './sftpBackend'

/** WSL 会话标记：伪造一个不与任何持久化主机冲突的 profileId */
export function wslProfileId(distro: string): string {
  return `wsl:${distro}`
}

/** 为 WSL 发行版构造一个展示 / AI 上下文可用的 HostProfile */
function buildProfile(distro: string): HostProfile {
  const now = Date.now()
  return {
    id: wslProfileId(distro),
    label: `WSL · ${distro}`,
    host: distro,
    port: 0,
    username: 'wsl', // AI 上下文里展示为 WSL 本地用户
    authType: 'password',
    knownHostFingerprints: [],
    defaultDirectory: '/',
    createdAt: now,
    updatedAt: now
  }
}

/** 从 exec/spawn 输出里去掉 wsl 自身的启动噪音行 */
function scrubWslNoise(stderr: string): string {
  return stderr.replace(/^\s*Welcome to .*?\r?\n/im, '').trim()
}

/**
 * 本地 WSL 会话：让 WSL 像 SSH 远程主机一样运维。
 *  - 交互 shell：node-pty 启动 wsl.exe 获得可用的伪终端
 *  - exec：wsl.exe -d <distro> -- sh -lc '<cmd>'
 *  - sftp：通过 \\wsl$\<distro> 本地文件系统，暴露兼容 SFTPWrapper 的对象
 */
export class WslSession extends EventEmitter implements ISshSession {
  readonly id: string
  readonly profile: HostProfile
  readonly distro: string
  /** WSL 是本机会话：命令作用于本地 Windows/WSL，需更谨慎对待 */
  readonly isLocal = true

  private ptyProcess: IPty | null = null
  private sftpBackend: WslSftp
  private closed = false

  constructor(id: string, distro: string) {
    super()
    this.id = id
    this.distro = distro
    this.profile = buildProfile(distro)
    this.sftpBackend = new WslSftp(distro)
  }

  get isConnected(): boolean {
    return !this.closed
  }

  // WSL 无需指纹握手；这里直接返回一个空的 ConnectResult 以兼容 manager 流程
  async connect(
    _credentials: SessionCredentials,
    _onTrust: (fingerprint: string, keyType: string) => void
  ): Promise<ConnectResult> {
    this.closed = false
    return { fingerprint: '', keyType: '', serverVersion: 'WSL' }
  }

  // -------------------------------------------------------------- shell

  startShell(options: ShellOptions = {}): Promise<void> {
    if (this.closed) return Promise.reject(new Error('会话已关闭'))
    if (this.ptyProcess) return Promise.resolve()

    this.ptyProcess = pty.spawn(
      'wsl.exe',
      ['-d', this.distro, options.cwd ? ['--cd', options.cwd] : []].flat(),
      {
        name: options.term ?? 'xterm-256color',
        cols: options.cols ?? 120,
        rows: options.rows ?? 30,
        cwd: process.cwd(),
        env: { ...process.env as Record<string, string> },
        useConpty: true
      }
    )

    this.ptyProcess.onData((d: string) => this.emit('data', d))
    this.ptyProcess.onExit(({ exitCode }) => {
      this.ptyProcess = null
      this.emit('shell-close', { code: exitCode })
    })

    return Promise.resolve()
  }

  write(data: string): void {
    this.ptyProcess?.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.ptyProcess?.resize(cols, rows)
    } catch {
      /* ignore */
    }
  }

  // --------------------------------------------------------------- exec

  async exec(command: string, options: ExecOptions = {}): Promise<CommandResult> {
    if (this.closed) throw new Error('会话已关闭')
    const timeout = options.timeout ?? 60_000

    let cmd = command
    if (options.sudo) cmd = `sudo -S -p '' ${cmd}`
    if (options.cwd) cmd = `cd ${shellQuote(options.cwd)} && ${cmd}`

    const args = ['-d', this.distro, '--', 'sh', '-lc', cmd]

    return new Promise<CommandResult>((resolve) => {
      const child = spawn('wsl.exe', args, {
        windowsHide: true,
        env: process.env
      })
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      let timedOut = false
      let settled = false

      const finish = (): void => {
        if (settled) return
        settled = true
        resolve({ code, stdout, stderr: scrubWslNoise(stderr), timedOut })
      }

      const interrupt = (): void => {
        timedOut = true
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        finish()
      }

      const timer = setTimeout(interrupt, timeout)
      options.signal?.addEventListener('abort', () => interrupt(), { once: true })

      child.stdout.on('data', (d: Buffer) => {
        const text = d.toString('utf8')
        stdout += text
        options.onData?.(text)
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        stderr += `无法启动 wsl.exe：${err.message}`
        finish()
      })
      child.on('close', (c) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', interrupt)
        code = c
        finish()
      })
    })
  }

  // --------------------------------------------------------------- sftp

  sftp(): Promise<import('ssh2').SFTPWrapper> {
    return Promise.resolve(this.sftpBackend.asSftp())
  }

  setSudoPassword(): void {
    /* WSL 本地会话不涉及凭据 */
  }

  end(): void {
    this.closed = true
    try {
      this.ptyProcess?.kill()
    } catch {
      /* ignore */
    }
    this.ptyProcess = null
    this.emit('close', { code: 0 })
  }
}