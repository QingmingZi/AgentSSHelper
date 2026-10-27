import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { api } from '../api'
import type { AuthType, HostProfile } from '@shared/types'
import Modal from './Modal'

interface HostDialogProps {
  mode: 'create' | 'edit'
  profile?: HostProfile
  onCancel: () => void
  onSubmit: (
    values: Partial<HostProfile> & { host: string; username: string },
    secrets?: { password?: string; passphrase?: string }
  ) => void | Promise<void>
}

export default function HostDialog({
  mode,
  profile,
  onCancel,
  onSubmit
}: HostDialogProps): ReactElement {
  const [label, setLabel] = useState(profile?.label ?? '')
  const [host, setHost] = useState(profile?.host ?? '')
  const [port, setPort] = useState(profile?.port ?? 22)
  const [username, setUsername] = useState(profile?.username ?? '')
  const [authType, setAuthType] = useState<AuthType>(profile?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState(profile?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [defaultDirectory, setDefaultDirectory] = useState(profile?.defaultDirectory ?? '')
  const [notes, setNotes] = useState(profile?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [sshAuthSock, setSshAuthSock] = useState<string>('')

  useEffect(() => {
    void (async () => {
      const info = await api.system.info()
      setSshAuthSock(info.sshAuthSock ?? '未设置')
      if (!profile) return
      const hasPassword = await api.profiles.hasSecret(profile.id, 'password')
      if (hasPassword) setPassword('********')
    })()
  }, [profile])

  const submit = (): void => {
    if (!host.trim() || !username.trim()) return
    setBusy(true)
    const values: Partial<HostProfile> & { host: string; username: string } = {
      label: label.trim() || host.trim(),
      host: host.trim(),
      port,
      username: username.trim(),
      authType,
      privateKeyPath: authType === 'privateKey' ? privateKeyPath.trim() : undefined,
      defaultDirectory: defaultDirectory.trim() || undefined,
      notes: notes.trim() || undefined
    }

    const secrets: { password?: string; passphrase?: string } = {}
    if (authType === 'password' && password && !masked) secrets.password = password
    if (authType === 'privateKey' && passphrase) secrets.passphrase = passphrase

    onSubmit(values, Object.keys(secrets).length ? secrets : undefined)
  }

  const pickKey = async (): Promise<void> => {
    const picked = await api.profiles.pickKeyFile()
    if (picked) setPrivateKeyPath(picked)
  }

  const masked = password === '********'

  return (
    <Modal onClose={onCancel} wide>
      <h3>{mode === 'create' ? '新建主机配置' : '编辑主机配置'}</h3>

        <div className="grid-2">
          <label className="field">
            <span>别名</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 生产环境 Web-01" />
          </label>
          <label className="field">
            <span>主机地址</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="10.0.0.12 或 example.com"
              autoFocus
            />
          </label>
          <label className="field">
            <span>端口</span>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 22)}
              min={1}
              max={65535}
            />
          </label>
          <label className="field">
            <span>用户名</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </label>
        </div>

        <label className="field">
          <span>认证方式</span>
          <div className="auth-seg" role="radiogroup" aria-label="认证方式">
            {(
              [
                ['password', '口令登录'],
                ['privateKey', '私钥登录'],
                ['agent', 'SSH Agent']
              ] as Array<[AuthType, string]>
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={authType === value}
                className={`auth-seg-item${authType === value ? ' active' : ''}`}
                onClick={() => setAuthType(value)}
              >
                {text}
              </button>
            ))}
          </div>
        </label>

        {authType === 'password' && (
          <label className="field">
            <span>登录口令{masked && '（已保存，留空则不修改）'}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="留空则连接时询问"
            />
          </label>
        )}

        {authType === 'privateKey' && (
          <>
            <label className="field">
              <span>私钥文件</span>
              <div className="inline-row">
                <input
                  value={privateKeyPath}
                  onChange={(e) => setPrivateKeyPath(e.target.value)}
                  placeholder="C:\\Users\\xxx\\.ssh\\id_ed25519"
                />
                <button className="btn ghost" onClick={() => void pickKey()}>
                  浏览…
                </button>
              </div>
            </label>
            <label className="field">
              <span>私钥 passphrase（可留空）</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="私钥未加密时留空"
              />
            </label>
          </>
        )}

        {authType === 'agent' && (
          <p className="note">
            使用环境变量 <code>SSH_AUTH_SOCK</code> 指向的 ssh-agent 转发认证。当前值：
            <code>{sshAuthSock}</code>
          </p>
        )}

        <div className="grid-2">
          <label className="field">
            <span>默认工作目录（可留空）</span>
            <input
              value={defaultDirectory}
              onChange={(e) => setDefaultDirectory(e.target.value)}
              placeholder="/var/www"
            />
          </label>
          <label className="field">
            <span>备注</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="用途说明" />
          </label>
        </div>

        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={busy || !host.trim() || !username.trim()}>
            保存
          </button>
        </div>
    </Modal>
  )
}
