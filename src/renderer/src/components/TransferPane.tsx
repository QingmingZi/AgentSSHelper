import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { api } from '../api'
import type { RemoteFileEntry } from '@shared/types'
import TextEditorDialog from './TextEditorDialog'

interface TransferPaneProps {
  sessionId: string
}

interface ProgressItem {
  taskId: string
  direction: 'upload' | 'download'
  source: string
  target: string
  transferredBytes: number
  totalBytes: number
  status: 'running' | 'done' | 'error' | 'canceled'
  error?: string
}

function formatSize(bytes: number): string {
  if (!bytes) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function formatTime(ms: number): string {
  if (!ms) return '-'
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 常见的二进制扩展名——命中即视为不适合在线编辑，应改用下载 */
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svgz',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'zst', 'tgz',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'exe', 'msi', 'dll', 'so', 'o', 'a', 'bin', 'iso', 'dmg', 'appimage',
  'mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a',
  'mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'm4v',
  'wasm', 'class', 'jar', 'pyc', 'pyo', 'node', 'lib', 'dylib', 'sys',
  'pem', 'key', 'crt', 'cer', 'pub',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'sqlite', 'db', 'mdb', 'lock', 'idx', 'dat',
  'suo', 'pdb', 'map'
])

/** 判断是否适合在线编辑的文本文件（按扩展名排除已知二进制，而非白名单，避免漏掉无后缀的配置/脚本） */
function isTextEditable(name: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  // 无扩展名（或点开头的隐藏文件）也允许尝试编辑，由后端做大小/内容校验
  if (dot <= 0 || dot === lower.length - 1) return true
  const ext = lower.slice(dot + 1)
  return !BINARY_EXTS.has(ext)
}

export default function TransferPane({ sessionId }: TransferPaneProps): ReactElement {
  const [cwd, setCwd] = useState('~')
  const [entries, setEntries] = useState<RemoteFileEntry[]>([])
  const [selected, setSelected] = useState<RemoteFileEntry | null>(null)
  const [localPath, setLocalPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [useNativeScp, setUseNativeScp] = useState(false)
  const [items, setItems] = useState<ProgressItem[]>([])
  const [error, setError] = useState('')
  /** 正在编辑的远端文本文件（null 表示编辑器已关闭） */
  const [editing, setEditing] = useState<RemoteFileEntry | null>(null)

  const load = useCallback(
    async (dir: string): Promise<void> => {
      setLoading(true)
      setError('')
      try {
        const list = await api.sftp.list(sessionId, dir)
        setEntries(list)
        setCwd(dir)
        setSelected(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [sessionId]
  )

  /**
   * ssh2 的 SFTP 不会展开 `~`，需要先通过 exec 拿到远端 HOME 的绝对路径。
   */
  const resolveHome = useCallback(async (): Promise<string> => {
    try {
      const result = await api.ssh.exec(sessionId, 'printf %s "$HOME"', { timeout: 8000 })
      const home = result.stdout.trim()
      if (home.startsWith('/')) return home
    } catch {
      /* 回退到根目录 */
    }
    return '/'
  }, [sessionId])

  useEffect(() => {
    void (async () => {
      const home = await resolveHome()
      await load(home)
    })()
    void api.system.homeDir().then(setLocalPath)
  }, [load, resolveHome])

  // 传输进度事件
  useEffect(() => {
    const offProgress = api.on('transfer:progress', (payload: any) => {
      if (payload.sessionId !== sessionId) return
      setItems((prev) => {
        const index = prev.findIndex((i) => i.taskId === payload.taskId)
        const nextItem: ProgressItem = {
          taskId: payload.taskId,
          direction: payload.direction,
          source: payload.source,
          target: payload.target,
          transferredBytes: payload.transferredBytes ?? 0,
          totalBytes: payload.totalBytes ?? 0,
          status: 'running'
        }
        if (index >= 0) {
          const merged = { ...prev[index], ...nextItem }
          const copy = [...prev]
          copy[index] = merged
          return copy
        }
        return [nextItem, ...prev]
      })
    })

    const offDone = api.on('transfer:done', (payload: any) => {
      if (payload.sessionId !== sessionId) return
      setItems((prev) =>
        prev.map((item) =>
          item.taskId === payload.taskId
            ? { ...item, status: payload.status, error: payload.error }
            : item
        )
      )
      if (payload.status === 'done') void load(cwd)
    })

    return () => {
      offProgress()
      offDone()
    }
  }, [sessionId, cwd, load])

  const crumbs = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean)
    const out = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc += `/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  }, [cwd])

  /** 计算上级目录（远端路径统一使用绝对路径，避免相对路径歧义） */
  const parentPath = useMemo(() => {
    const parts = cwd.split('/').filter(Boolean)
    if (parts.length <= 1) return '/'
    return '/' + parts.slice(0, -1).join('/')
  }, [cwd])

  /** 拼接远端绝对路径，避免出现 'opt' 这类相对路径 */
  const remoteJoin = (dir: string, ...parts: string[]): string => {
    const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
    const joined = [base === '' ? '/' : base, ...parts].join('/')
    return joined.replace(/\/{2,}/g, '/')
  }

  const upload = async (): Promise<void> => {
    const picked = await api.system.pickFile()
    if (!picked) return
    // 目标目录：选中目录则传入选中目录，否则用当前目录
    const targetDir = selected?.type === 'directory' ? selected.path : cwd
    const fileName = picked.split(/[\\/]/).filter(Boolean).pop() ?? 'upload.bin'
    await api.transfer.run({
      sessionId,
      direction: 'upload',
      source: picked,
      target: remoteJoin(targetDir, fileName),
      overwrite: true,
      useNativeScp
    })
  }

  const uploadFolder = async (): Promise<void> => {
    const picked = await api.system.pickDirectory()
    if (!picked) return
    const name = picked.split(/[\\/]/).filter(Boolean).pop() ?? 'upload'
    await api.transfer.run({
      sessionId,
      direction: 'upload',
      source: picked,
      target: remoteJoin(cwd, name),
      recursive: true,
      overwrite: true,
      useNativeScp
    })
  }

  const download = async (): Promise<void> => {
    if (!selected) return
    const dir = localPath || (await api.system.homeDir())
    const target = selected.type === 'directory' ? `${dir}/${selected.name}` : `${dir}/${selected.name}`
    await api.transfer.run({
      sessionId,
      direction: 'download',
      source: selected.path,
      target,
      recursive: selected.type === 'directory',
      overwrite: true,
      useNativeScp
    })
  }

  return (
    <div className="pane transfer-pane">
      <div className="pane-toolbar">
        <span className="pane-title">文件传输</span>
        <div className="spacer" />
        <label className="checkbox inline">
          <input
            type="checkbox"
            checked={useNativeScp}
            onChange={(e) => setUseNativeScp(e.target.checked)}
          />
          <span>使用系统 scp 命令（仅私钥认证）</span>
        </label>
      </div>

      <div className="transfer-body">
        <section className="remote-browser">
          <div className="browser-toolbar">
            <button className="btn tiny ghost" onClick={() => void load('/')}>
              /
            </button>
            <button className="btn tiny ghost" onClick={() => void load(parentPath)}>
              上级
            </button>
            <button className="btn tiny ghost" onClick={() => void load(cwd)}>
              刷新
            </button>
            <div className="crumbs">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path}>
                  {index > 0 && <span className="crumb-sep">/</span>}
                  <button className="crumb" onClick={() => void load(crumb.path)}>
                    {crumb.label}
                  </button>
                </span>
              ))}
            </div>
          </div>

          {error && <div className="inline-error">{error}</div>}

          <div className="file-table">
            <div className="file-row head">
              <span className="col-name">名称</span>
              <span className="col-size">大小</span>
              <span className="col-time">修改时间</span>
            </div>
            {loading && <div className="file-row empty">加载中…</div>}
            {!loading && entries.length === 0 && !error && (
              <div className="file-row empty">目录为空</div>
            )}
            {entries.map((entry) => (
              <div
                key={entry.path}
                className={`file-row ${selected?.path === entry.path ? 'selected' : ''}`}
                onClick={() => setSelected(entry)}
                onDoubleClick={() => {
                  if (entry.type === 'directory') {
                    void load(entry.path)
                  } else if (entry.type === 'file' && isTextEditable(entry.name)) {
                    setEditing(entry)
                  }
                }}
              >
                <span className="col-name">
                  <span className="file-icon">
                    {entry.type === 'directory' ? '📁' : entry.type === 'symlink' ? '🔗' : '📄'}
                  </span>
                  {entry.name}
                </span>
                <span className="col-size">{entry.type === 'directory' ? '-' : formatSize(entry.size)}</span>
                <span className="col-time">{formatTime(entry.mtime)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="transfer-side">
          <div className="side-block">
            <h4>上传到远程</h4>
            <p className="hint">目标目录：{cwd}</p>
            <div className="side-actions">
              <button className="btn small" onClick={() => void upload()}>
                上传文件…
              </button>
              <button className="btn small" onClick={() => void uploadFolder()}>
                上传文件夹…
              </button>
            </div>
          </div>

          <div className="side-block">
            <h4>下载到本地</h4>
            <label className="field">
              <span>本地目录</span>
              <div className="inline-row">
                <input
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="本地目标目录"
                />
                <button
                  className="btn ghost"
                  onClick={async () => {
                    const picked = await api.system.pickDirectory()
                    if (picked) setLocalPath(picked)
                  }}
                >
                  浏览…
                </button>
              </div>
            </label>
            <div className="side-actions">
              <button className="btn small" disabled={!selected} onClick={() => void download()}>
                下载选中项
              </button>
              {selected?.type === 'file' && isTextEditable(selected.name) && (
                <button className="btn small" onClick={() => setEditing(selected)}>
                  编辑文本
                </button>
              )}
              <button
                className="btn small ghost"
                disabled={!selected}
                onClick={() => void api.system.revealPath(localPath)}
              >
                打开本地目录
              </button>
            </div>
            {selected && (
              <p className="hint">
                选中：{selected.name}（{selected.type === 'directory' ? '目录' : formatSize(selected.size)}）
              </p>
            )}
          </div>

          <div className="side-block grow">
            <h4>传输任务</h4>
            <div className="transfer-list">
              {items.length === 0 && <div className="hint">暂无传输任务</div>}
              {items.map((item) => {
                const percent =
                  item.totalBytes > 0 ? Math.min(100, Math.round((item.transferredBytes / item.totalBytes) * 100)) : 0
                return (
                  <div key={item.taskId} className={`transfer-item ${item.status}`}>
                    <div className="transfer-line">
                      <span className="dir-tag">{item.direction === 'upload' ? '↑' : '↓'}</span>
                      <span className="transfer-name" title={`${item.source} → ${item.target}`}>
                        {item.source.split(/[\\/]/).pop()}
                      </span>
                      <span className="transfer-state">{item.status}</span>
                    </div>
                    <div className="progress">
                      <div className="progress-bar" style={{ width: `${percent}%` }} />
                    </div>
                    <div className="progress-text">
                      {item.totalBytes > 0
                        ? `${formatSize(item.transferredBytes)} / ${formatSize(item.totalBytes)} (${percent}%)`
                        : item.error || '处理中…'}
                    </div>
                    {item.status === 'running' && (
                      <button className="btn tiny danger" onClick={() => void api.transfer.cancel(item.taskId)}>
                        取消
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      </div>

      {editing && (
        <TextEditorDialog
          sessionId={sessionId}
          remotePath={editing.path}
          fileName={editing.name}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
