import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { api } from './api'
import type { HostProfile, SshStatus, SystemUsage } from '@shared/types'
import Sidebar from './components/Sidebar'
import HostDialog from './components/HostDialog'
import TerminalPane from './components/TerminalPane'
import TransferPane from './components/TransferPane'
import AIPane from './components/AIPane'
import SettingsDialog from './components/SettingsDialog'
import Modal from './components/Modal'

export interface SessionInfo {
  sessionId: string
  profileId: string
  label: string
  host: string
  status: SshStatus
}

/** WSL 发行版（渲染层展示用） */
export interface WslDistroDisplay {
  name: string
  isDefault: boolean
  state: string
  version: string
}

type TabKey = 'terminal' | 'transfer' | 'ai'

interface Toast {
  id: number
  level: 'info' | 'error' | 'success'
  message: string
}

/** 顶部栏的资源占用条：一条有颜色的进度条 + 标签 + 百分比数值 */
function mbToGb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return '—'
  const gb = mb / 1024
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)}G`
}

function UsageBar({
  label,
  value,
  hint
}: {
  label: string
  /** 0~100，为 null 表示采集到（显示为—） */
  value: number | null
  hint: string
}): ReactElement {
  const safe = value == null ? 0 : Math.max(0, Math.min(100, value))
  const tone = safe >= 90 ? 'danger' : safe >= 70 ? 'warn' : 'ok'
  return (
    <div className="usage-bar" title={`服务器${label}占用：${hint}`}>
      <span className="usage-label">{label}</span>
      <div className="usage-track">
        <div className={`usage-fill tone-${tone}`} style={{ width: `${safe}%` }} />
      </div>
      <span className="usage-value">{hint}</span>
    </div>
  )
}

export default function App(): ReactElement {
  const [profiles, setProfiles] = useState<HostProfile[]>([])
  const [wslDistros, setWslDistros] = useState<WslDistroDisplay[]>([])
  const [wslAvailable, setWslAvailable] = useState(false)
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({})
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('terminal')
  const [hostDialog, setHostDialog] = useState<{ mode: 'create' | 'edit'; profile?: HostProfile } | null>(
    null
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** AI 配置版本号：设置保存后自增，通知 AI 面板重新拉取配置 */
  const [aiConfigVersion, setAiConfigVersion] = useState(0)
  const [credentialPrompt, setCredentialPrompt] = useState<{
    profile: HostProfile
    kind: 'password' | 'passphrase'
  } | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(0)
  /** 各会话的实时 CPU / 内存占用（主进程周期采样广播） */
  const [usages, setUsages] = useState<Record<string, SystemUsage>>({})

  const pushToast = useCallback((level: Toast['level'], message: string): void => {
    const id = ++toastId.current
    setToasts((prev) => [...prev, { id, level, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000)
  }, [])

  const refreshProfiles = useCallback(async (): Promise<void> => {
    const list = await api.profiles.list()
    setProfiles(list)
  }, [])

  useEffect(() => {
    void refreshProfiles()
  }, [refreshProfiles])

  // 加载本机 WSL 发行版
  useEffect(() => {
    let alive = true
    void api.wsl
      .list()
      .then((res) => {
        if (!alive) return
        setWslAvailable(res.available)
        setWslDistros(res.distros ?? [])
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // 主进程事件订阅
  useEffect(() => {
    const offStatus = api.on('ssh:status', (payload: SshStatus) => {
      setSessions((prev) => {
        const current = prev[payload.sessionId]
        if (!current) return prev
        return {
          ...prev,
          [payload.sessionId]: {
            ...current,
            status: { ...current.status, ...payload }
          }
        }
      })
    })

    const offExit = api.on('ssh:exit', (payload: { sessionId: string }) => {
      setSessions((prev) => {
        const current = prev[payload.sessionId]
        if (!current) return prev
        return {
          ...prev,
          [payload.sessionId]: {
            ...current,
            status: { ...current.status, state: 'closed', message: '连接已关闭' }
          }
        }
      })
      setActiveProfileId((prev) => {
        const closed = sessions[payload.sessionId]
        return closed && closed.profileId === prev ? null : prev
      })
    })

    const offToast = api.on('app:toast', (payload: { level?: 'info' | 'error' | 'success'; message: string }) => {
      pushToast(payload.level ?? 'info', payload.message)
    })

    // 服务器实时资源占用（CPU / 内存）
    const offUsage = api.on('system:usage', (payload: SystemUsage) => {
      setUsages((prev) => ({ ...prev, [payload.sessionId]: payload }))
    })

    return () => {
      offStatus()
      offExit()
      offToast()
      offUsage()
    }
  }, [pushToast, sessions])

  const activeSession = useMemo(() => {
    if (!activeProfileId) return null
    const found = Object.values(sessions).find((s) => s.profileId === activeProfileId)
    return found ?? null
  }, [activeProfileId, sessions])

  const sessionForProfile = useCallback(
    (profileId: string): SessionInfo | undefined =>
      Object.values(sessions).find((s) => s.profileId === profileId),
    [sessions]
  )

  // ------------------------------------------------------------ 连接流程

  const doConnect = useCallback(
    async (profile: HostProfile, credentials?: { password?: string; passphrase?: string }) => {
      try {
        const result = await api.ssh.connect(profile.id, credentials)
        setSessions((prev) => ({
          ...prev,
          [result.sessionId]: {
            sessionId: result.sessionId,
            profileId: profile.id,
            label: profile.label,
            host: `${profile.username}@${profile.host}:${profile.port}`,
            status: {
              sessionId: result.sessionId,
              profileId: profile.id,
              state: 'connected',
              message: '已连接',
              serverVersion: result.serverVersion,
              fingerprint: result.fingerprint
            }
          }
        }))
        setActiveProfileId(profile.id)
        setTab('terminal')
        pushToast('success', `已连接到 ${profile.label}${result.fingerprint ? ` (${result.fingerprint})` : ''}`)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        pushToast('error', `连接失败：${message}`)
        throw err
      }
    },
    [pushToast]
  )

  const handleConnect = useCallback(
    async (profile: HostProfile) => {
      const existing = sessionForProfile(profile.id)
      if (existing && existing.status.state === 'connected') {
        setActiveProfileId(profile.id)
        return
      }
      if (profile.authType === 'password') {
        const has = await api.profiles.hasSecret(profile.id, 'password')
        if (!has) {
          setCredentialPrompt({ profile, kind: 'password' })
          return
        }
      }
      if (profile.authType === 'privateKey') {
        const has = await api.profiles.hasSecret(profile.id, 'passphrase')
        if (!has) {
          setCredentialPrompt({ profile, kind: 'passphrase' })
          return
        }
      }
      await doConnect(profile)
    },
    [doConnect, pushToast, sessionForProfile]
  )

  const submitCredential = useCallback(
    async (value: string, remember: boolean) => {
      const prompt = credentialPrompt
      if (!prompt) return
      setCredentialPrompt(null)
      if (remember && value) {
        await api.profiles.setSecret(prompt.profile.id, prompt.kind, value)
      }
      const credentials =
        prompt.kind === 'password' ? { password: value } : { passphrase: value }
      await doConnect(prompt.profile, credentials)
    },
    [credentialPrompt, doConnect]
  )

  const handleDisconnect = useCallback(
    async (profileId: string) => {
      const session = sessionForProfile(profileId)
      if (!session) return
      if (profileId.startsWith('wsl:')) {
        await api.wsl.disconnect(session.sessionId)
      } else {
        await api.ssh.disconnect(session.sessionId)
      }
      setSessions((prev) => {
        const next = { ...prev }
        delete next[session.sessionId]
        return next
      })
      setActiveProfileId((prev) => (prev === profileId ? null : prev))
      pushToast('info', '已断开连接')
    },
    [pushToast, sessionForProfile]
  )

  const handleWslConnect = useCallback(
    async (distro: WslDistroDisplay) => {
      const profileId = `wsl:${distro.name}`
      const existing = sessionForProfile(profileId)
      if (existing && existing.status.state === 'connected') {
        setActiveProfileId(profileId)
        return
      }
      try {
        const result = await api.wsl.connect(distro.name)
        setSessions((prev) => ({
          ...prev,
          [result.sessionId]: {
            sessionId: result.sessionId,
            profileId,
            label: `WSL · ${distro.name}`,
            host: `wsl@${distro.name}`,
            status: {
              sessionId: result.sessionId,
              profileId,
              state: 'connected',
              message: '已连接'
            }
          }
        }))
        setActiveProfileId(profileId)
        setTab('terminal')
        pushToast('success', `已进入 WSL 发行版 ${distro.name}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        pushToast('error', `WSL 连接失败：${message}`)
      }
    },
    [sessionForProfile, pushToast]
  )

  const handleSaveProfile = useCallback(
    async (
      values: Partial<HostProfile> & { host: string; username: string },
      secrets?: { password?: string; passphrase?: string }
    ) => {
      let profileId: string
      if (hostDialog?.mode === 'edit' && hostDialog.profile) {
        await api.profiles.update(hostDialog.profile.id, values)
        profileId = hostDialog.profile.id
        pushToast('success', '主机配置已更新')
      } else {
        const created = await api.profiles.create(values)
        profileId = created.id
        pushToast('success', '主机配置已创建')
      }
      if (secrets?.password) await api.profiles.setSecret(profileId, 'password', secrets.password)
      if (secrets?.passphrase) await api.profiles.setSecret(profileId, 'passphrase', secrets.passphrase)
      await refreshProfiles()
    },
    [hostDialog, pushToast, refreshProfiles]
  )

  const handleDeleteProfile = useCallback(
    async (profile: HostProfile) => {
      await api.profiles.remove(profile.id)
      await refreshProfiles()
      pushToast('info', `已删除 ${profile.label}`)
    },
    [pushToast, refreshProfiles]
  )

  const sessionId = activeSession?.sessionId ?? null
  const activeUsage = sessionId ? usages[sessionId] : undefined

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⌘</span>
          <span className="brand-name">AgentSSHelper</span>
        </div>
        <nav className="tabs">
          {(
            [
              ['terminal', '终端'],
              ['transfer', '文件传输'],
              ['ai', 'AI 运维']
            ] as Array<[TabKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              className={`tab ${tab === key ? 'active' : ''}`}
              onClick={() => setTab(key)}
              disabled={!sessionId}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {activeSession && (
            <span className={`status-pill ${activeSession.status.state}`}>
              {activeSession.status.state === 'connected' ? '● 已连接' : activeSession.status.message}
            </span>
          )}
          {activeSession?.status.state === 'connected' && activeUsage && (
            <div className="usage-bars">
              <UsageBar
                label="CPU"
                value={activeUsage.cpu}
                hint={activeUsage.cpu == null ? '—' : `${activeUsage.cpu}%`}
              />
              <UsageBar
                label="内存"
                value={activeUsage.mem}
                hint={
                  activeUsage.mem == null
                    ? '—'
                    : `${activeUsage.mem}%${activeUsage.memUsed != null ? ` · ${mbToGb(activeUsage.memUsed)}/${mbToGb(activeUsage.memTotal ?? 0)}` : ''}`
                }
              />
            </div>
          )}
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
        </div>
      </header>

      <div className="body">
        <Sidebar
          profiles={profiles}
          sessions={sessions}
          activeProfileId={activeProfileId}
          wslAvailable={wslAvailable}
          wslDistros={wslDistros}
          onSelect={(id) => {
            setActiveProfileId(id)
            setTab('terminal')
          }}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onWslConnect={handleWslConnect}
          onWslDisconnect={handleDisconnect}
          onCreate={() => setHostDialog({ mode: 'create' })}
          onEdit={(profile) => setHostDialog({ mode: 'edit', profile })}
          onDelete={handleDeleteProfile}
        />

        <main className="content">
          {!sessionId ? (
            <div className="empty-state">
              <div className="empty-icon">🔌</div>
              <h2>还没有连接任何服务器</h2>
              <p>在左侧选择一台主机并点击「连接」，或新建一个主机配置。</p>
              <button className="btn primary" onClick={() => setHostDialog({ mode: 'create' })}>
                新建主机配置
              </button>
            </div>
          ) : (
            <>
              <div className={`pane-host ${tab === 'terminal' ? '' : 'hidden'}`}>
                <TerminalPane sessionId={sessionId} visible={tab === 'terminal'} />
              </div>
              <div className={`pane-host ${tab === 'transfer' ? '' : 'hidden'}`}>
                <TransferPane sessionId={sessionId} />
              </div>
              <div className={`pane-host ${tab === 'ai' ? '' : 'hidden'}`}>
                <AIPane
                  sessionId={sessionId}
                  onToast={pushToast}
                  visible={tab === 'ai'}
                  configVersion={aiConfigVersion}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              </div>
            </>
          )}
        </main>
      </div>

      {hostDialog && (
        <HostDialog
          mode={hostDialog.mode}
          profile={hostDialog.profile}
          onCancel={() => setHostDialog(null)}
          onSubmit={async (values, secrets) => {
            await handleSaveProfile(values, secrets)
            setHostDialog(null)
          }}
        />
      )}

      {credentialPrompt && (
        <CredentialDialog
          title={
            credentialPrompt.kind === 'password'
              ? `连接 ${credentialPrompt.profile.label} —— 输入登录口令`
              : `连接 ${credentialPrompt.profile.label} —— 输入私钥 passphrase`
          }
          secret={credentialPrompt.kind === 'password'}
          onCancel={() => setCredentialPrompt(null)}
          onSubmit={submitCredential}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSaved={() => setAiConfigVersion((v) => v + 1)}
        />
      )}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.level}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  )
}

interface CredentialDialogProps {
  title: string
  secret: boolean
  onCancel: () => void
  onSubmit: (value: string, remember: boolean) => void
}

function CredentialDialog({
  title,
  secret,
  onCancel,
  onSubmit
}: CredentialDialogProps): ReactElement {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)

  return (
    <Modal onClose={onCancel}>
      <h3>{title}</h3>
      <label className="field">
        <span>{secret ? '口令' : 'Passphrase（可留空）'}</span>
        <input
          type={secret ? 'password' : 'password'}
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value) {
              setBusy(true)
              onSubmit(value, remember)
            }
          }}
          placeholder={secret ? '请输入登录口令' : '私钥未加密时可留空'}
        />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>记住并加密保存到系统密钥库</span>
      </label>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn primary"
          disabled={busy || (secret && !value)}
          onClick={() => {
            setBusy(true)
            onSubmit(value, remember)
          }}
        >
          连接
        </button>
      </div>
    </Modal>
  )
}
