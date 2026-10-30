import { useEffect, useRef, useState } from 'react'
import type { ReactElement, MouseEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { api } from '../api'
import { appendTerminalOutput } from '../terminalBuffer'

interface TerminalPaneProps {
  sessionId: string
  /** 面板是否可见；不可见时保留终端实例与回滚缓冲 */
  visible: boolean
}

const THEME = {
  background: '#0f1116',
  foreground: '#d5d9e0',
  cursor: '#6ee7b7',
  cursorAccent: '#0f1116',
  selectionBackground: '#2d3748',
  black: '#1a1d24',
  red: '#f87171',
  green: '#6ee7b7',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#67e8f9',
  white: '#d5d9e0',
  brightBlack: '#6b7280',
  brightRed: '#fca5a5',
  brightGreen: '#a7f3d0',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#f3f4f6'
}

export default function TerminalPane({ sessionId, visible }: TerminalPaneProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const startedRef = useRef<string | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [copied, setCopied] = useState(false)

  // 复制选中文本：无选区或会话不可用则忽略
  const copySelection = async (): Promise<void> => {
    const term = termRef.current
    if (!term) return
    const sel = term.getSelection()
    if (!sel) return
    await api.clipboard.writeText(sel)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  // 黏贴系统剪贴板到终端输入流
  const pasteClipboard = async (): Promise<void> => {
    const text = await api.clipboard.readText()
    if (text) api.ssh.shellInput(sessionId, text)
  }

  // 工具栏按钮动作：先让按钮失焦、把键盘交还终端，再执行操作。
  // 否则按钮持有焦点时，回车/空格会再次触发点击（复制/黏贴重复执行、按钮呈高亮）。
  const toolbarBlur = (e: MouseEvent<HTMLElement>, run: () => void): void => {
    e.currentTarget.blur()
    if (termRef.current) termRef.current.focus()
    run()
  }

  const openCtxMenu = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.type === 'contextmenu') e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const runCtx = (action: 'copy' | 'paste' | 'clear'): void => {
    setCtxMenu(null)
    if (action === 'copy') void copySelection()
    else if (action === 'paste') void pasteClipboard()
    else clear()
  }

  // 创建终端实例（仅在会话变化时创建，切换标签页不会重建，保留回滚缓冲）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      theme: THEME,
      scrollback: 20_000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    const disposeData = term.onData((data) => {
      api.ssh.shellInput(sessionId, data)
    })

    // 复制/黏贴快捷键：Ctrl+Shift+C 复制选中、Ctrl+Shift+V 黏贴剪贴板。
    // 拦截后返回 false，避免 xterm 把组合键发进远端或触发浏览器默认行为。
    // 故意不用 preventDefault 兜底浏览器，仅精确命中两个组合。
    term.attachCustomKeyEventHandler((event) => {
      const k = (event.key || '').toLowerCase()
      const mod = (event.ctrlKey || event.metaKey) && event.shiftKey
      if (!mod) return true
      if (k === 'c') {
        void copySelection()
        return false
      }
      if (k === 'v') {
        void pasteClipboard()
        return false
      }
      return true
    })

    const offData = api.on('ssh:data', (payload: { sessionId: string; chunk: string }) => {
      if (payload.sessionId !== sessionId) return
      appendTerminalOutput(payload.chunk)
      term.write(payload.chunk)
    })

    const offExit = api.on('ssh:exit', (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return
      term.write('\r\n\x1b[90m[会话已结束]\x1b[0m\r\n')
    })

    const resizeObserver = new ResizeObserver(() => {
      // 面板隐藏时容器尺寸为 0，此时不能 fit
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      try {
        fit.fit()
        api.ssh.shellResize(sessionId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      disposeData.dispose()
      offData()
      offExit()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      startedRef.current = null
    }
  }, [sessionId])

  // 仅在面板可见时建立 shell，保证尺寸正确且同一连接只开一个 shell
  useEffect(() => {
    if (!visible) return
    const container = containerRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!container || !term || !fit) return
    if (container.clientWidth === 0 || container.clientHeight === 0) return

    if (startedRef.current === sessionId) {
      // 重新可见时同步一次尺寸
      try {
        fit.fit()
        api.ssh.shellResize(sessionId, term.cols, term.rows)
      } catch {
        /* ignore */
      }
      return
    }
    startedRef.current = sessionId

    try {
      fit.fit()
    } catch {
      /* ignore */
    }

    void api.ssh
      .shellStart(sessionId, { cols: term.cols, rows: term.rows })
      .then(() => setReady(true))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [sessionId, visible])

  const clear = (): void => termRef.current?.clear()

  return (
    <div className="pane terminal-pane">
      <div className="pane-toolbar">
        <span className="pane-title">交互式终端</span>
        <div className="spacer" />
        {error && <span className="error-text">{error}</span>}
        {!error && <span className="hint">{ready ? '已连接' : '正在建立会话…'}</span>}
        <button
          className="btn tiny ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => toolbarBlur(e, () => void copySelection())}
          title="复制选中文本 (Ctrl+Shift+C)"
        >
          {copied ? '已复制' : '复制'}
        </button>
        <button
          className="btn tiny ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => toolbarBlur(e, () => void pasteClipboard())}
          title="从系统剪贴板黏贴 (Ctrl+Shift+V)"
        >
          黏贴
        </button>
        <button className="btn tiny ghost" onMouseDown={(e) => e.preventDefault()} onClick={(e) => toolbarBlur(e, clear)}>
          清屏
        </button>
      </div>
      <div
        className="terminal-host"
        ref={containerRef}
        onClick={() => setCtxMenu(null)}
        onContextMenu={(e) => {
          e.preventDefault()
          openCtxMenu(e)
        }}
      >
        {ctxMenu && (
          <div
            className="terminal-ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button className="ctx-item" onClick={() => runCtx('copy')}>
              复制
            </button>
            <button className="ctx-item" onClick={() => runCtx('paste')}>
              黏贴
            </button>
            <div className="ctx-sep" />
            <button className="ctx-item" onClick={() => runCtx('clear')}>
              清屏
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
