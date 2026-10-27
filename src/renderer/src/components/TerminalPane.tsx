import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
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
        <button className="btn tiny ghost" onClick={clear}>
          清屏
        </button>
      </div>
      <div className="terminal-host" ref={containerRef} />
    </div>
  )
}
