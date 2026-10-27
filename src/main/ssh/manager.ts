import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { HostProfile, SshStatus } from '@shared/types'
import { SshSession, type ConnectResult, type SessionCredentials } from './connection'
import type { Store } from '../core/store'

export interface ConnectOutcome {
  sessionId: string
  profileId: string
  fingerprint: string
  keyType: string
  serverVersion: string
}

/**
 * SSH 会话管理器
 * 负责会话生命周期、凭据解密、主机密钥指纹持久化，以及向渲染层广播状态事件。
 */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, SshSession>()
  private readonly store: Store

  constructor(store: Store) {
    super()
    this.store = store
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  list(): Array<{ sessionId: string; profileId: string; label: string; host: string }> {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.id,
      profileId: s.profile.id,
      label: s.profile.label,
      host: `${s.profile.username}@${s.profile.host}:${s.profile.port}`
    }))
  }

  get(sessionId: string): SshSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`会话不存在或已关闭: ${sessionId}`)
    return session
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * 连接一台主机。
   * @param credentials 覆盖凭据（留空则从保险库读取）
   */
  async connect(
    profileId: string,
    credentials: SessionCredentials = {},
    options: { trustNewHost?: boolean } = {}
  ): Promise<ConnectOutcome> {
    const profile = this.store.getProfile(profileId)
    if (!profile) throw new Error(`主机配置不存在: ${profileId}`)

    const password =
      credentials.password ?? (await this.store.getProfileSecret(profileId, 'password'))
    const passphrase =
      credentials.passphrase ?? (await this.store.getProfileSecret(profileId, 'passphrase'))
    const privateKeyPath = credentials.privateKeyPath ?? profile.privateKeyPath

    const sessionId = randomUUID()
    const session = new SshSession(sessionId, profile)

    // 主机密钥：首次信任或用户显式信任时写入指纹列表
    const effectiveProfile: HostProfile = { ...profile }
    if (options.trustNewHost) effectiveProfile.knownHostFingerprints = []

    const onTrust = (fingerprint: string, keyType: string): void => {
      this.store.addFingerprint(profile.id, fingerprint)
      this.emit('notice', {
        level: 'info',
        message: `已记录服务器主机密钥指纹 ${fingerprint} (${keyType})`
      })
    }

    this.sessions.set(sessionId, session)
    this.emitStatus(sessionId, profile.id, 'connecting', '正在连接...')

    session.on('data', (chunk: string) => this.emit('data', { sessionId, chunk }))
    session.on('error', (err: Error) => {
      this.emitStatus(sessionId, profile.id, 'error', err.message)
      this.emit('session-error', { sessionId, message: err.message })
    })
    session.on('close', () => {
      this.sessions.delete(sessionId)
      this.emitStatus(sessionId, profile.id, 'closed')
      this.emit('closed', { sessionId })
    })
    session.on('shell-close', (info: { code: number | null }) => {
      this.emit('shell-close', { sessionId, ...info })
    })
    session.on('shell-exit', (info: { code: number | null }) => {
      this.emit('shell-exit', { sessionId, ...info })
    })

    try {
      const result: ConnectResult = await session.connect(
        { password, passphrase, privateKeyPath },
        onTrust
      )
      session.setSudoPassword(password)
      this.emitStatus(sessionId, profile.id, 'connected', '已连接', result)
      return {
        sessionId,
        profileId: profile.id,
        fingerprint: result.fingerprint,
        keyType: result.keyType,
        serverVersion: result.serverVersion
      }
    } catch (err) {
      this.sessions.delete(sessionId)
      const message = err instanceof Error ? err.message : String(err)
      this.emitStatus(sessionId, profile.id, 'error', message)
      throw err
    }
  }

  close(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.end()
    this.sessions.delete(sessionId)
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }

  private emitStatus(
    sessionId: string,
    profileId: string,
    state: SshStatus['state'],
    message?: string,
    extra?: { serverVersion?: string; fingerprint?: string }
  ): void {
    const status: SshStatus = {
      sessionId,
      profileId,
      state,
      message,
      serverVersion: extra?.serverVersion,
      fingerprint: extra?.fingerprint
    }
    this.emit('status', status)
  }
}
