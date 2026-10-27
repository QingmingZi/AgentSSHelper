import type { HostProfile } from '@shared/types'
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { SessionInfo } from '../App'
import { api } from '../api'

interface SidebarProps {
  profiles: HostProfile[]
  sessions: Record<string, SessionInfo>
  activeProfileId: string | null
  onSelect: (profileId: string) => void
  onConnect: (profile: HostProfile) => void
  onDisconnect: (profileId: string) => void
  onCreate: () => void
  onEdit: (profile: HostProfile) => void
  onDelete: (profile: HostProfile) => void
}

export default function Sidebar({
  profiles,
  sessions,
  activeProfileId,
  onSelect,
  onConnect,
  onDisconnect,
  onCreate,
  onEdit,
  onDelete
}: SidebarProps): ReactElement {
  const sessionByProfile = new Map<string, SessionInfo>()
  for (const session of Object.values(sessions)) {
    sessionByProfile.set(session.profileId, session)
  }

  // 侧边栏常驻显示应用版本号
  const [version, setVersion] = useState('')
  useEffect(() => {
    let alive = true
    void api.system
      .info()
      .then((info) => {
        if (alive) setVersion(info.version)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>主机</span>
        <button className="btn tiny primary" onClick={onCreate} title="新建主机配置">
          ＋
        </button>
      </div>

      <div className="host-list">
        {profiles.length === 0 && <div className="host-list-empty">还没有主机配置</div>}
        {profiles.map((profile) => {
          const session = sessionByProfile.get(profile.id)
          const connected = session?.status.state === 'connected'
          const connecting = session?.status.state === 'connecting'
          return (
            <div
              key={profile.id}
              className={`host-item ${activeProfileId === profile.id ? 'active' : ''}`}
              onClick={() => onSelect(profile.id)}
              onDoubleClick={() => onConnect(profile)}
            >
              <span className={`dot ${connected ? 'on' : connecting ? 'pending' : 'off'}`} />
              <div className="host-meta">
                <div className="host-label" title={profile.label}>
                  {profile.label}
                </div>
                <div className="host-sub">
                  {profile.username}@{profile.host}:{profile.port}
                </div>
              </div>
              <div className="host-actions">
                {connected ? (
                  <button
                    className="icon-btn"
                    title="断开连接"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDisconnect(profile.id)
                    }}
                  >
                    ⏻
                  </button>
                ) : (
                  <button
                    className="icon-btn"
                    title="连接"
                    disabled={connecting}
                    onClick={(e) => {
                      e.stopPropagation()
                      onConnect(profile)
                    }}
                  >
                    {connecting ? '…' : '▶'}
                  </button>
                )}
                <button
                  className="icon-btn"
                  title="编辑"
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(profile)
                  }}
                >
                  ✎
                </button>
                <button
                  className="icon-btn danger"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm(`确认删除主机配置「${profile.label}」？已保存的口令会一并清除。`)) {
                      onDelete(profile)
                    }
                  }}
                >
                  🗑
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <span className="hint">双击主机名可快速连接</span>
        {version && <span className="app-version">AgentSSHelper v{version}</span>}
      </div>
    </aside>
  )
}
