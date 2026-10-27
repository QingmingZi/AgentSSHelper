import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { api } from '../api'
import type {
  AiMetrics,
  CommandOutcome,
  CommandProgress,
  CommandRisk,
  CommandResult,
  ProposedCommand
} from '@shared/types'
import { getTerminalContext } from '../terminalBuffer'
import Markdown from './Markdown'

interface AIPaneProps {
  sessionId: string
  onToast: (level: 'info' | 'error' | 'success', message: string) => void
  /** 面板当前是否可见（不可见时不刷新配置） */
  visible: boolean
  /** 配置版本号，保存设置后自增，用于触发重新拉取 AI 配置 */
  configVersion: number
  /** 打开设置窗口 */
  onOpenSettings: () => void
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  pending?: boolean
  error?: string
  /** 首字延迟（流式过程中先到，完整指标在 ai:done 时补齐） */
  firstTokenMs?: number
  /** 本次请求的完整运行时指标 */
  metrics?: AiMetrics
  /** 本次回复是否使用了联网搜索结果 */
  searched?: boolean
}

/** 命令卡片状态 */
type CardStatus = 'pending' | 'running' | 'done' | 'error' | 'rejected'

interface CommandCard {
  commandId: string
  /** 触发该命令的 AI 消息 id，用于把审批卡片串到对应回复下方 */
  messageId: string
  command: string
  risk: CommandRisk
  status: CardStatus
  result?: CommandResult
  /** 执行中的实时输出（长时命令如 yum update），用于展示进度 */
  liveOutput?: string
  error?: string
}

const RISK_LABEL: Record<CommandRisk, string> = {
  safe: '只读',
  modify: '修改',
  delete: '删除',
  risky: '需确认'
}

/** token 数按 1024 进制缩写：262144 → 256k */
function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1024) return String(Math.round(value))
  if (value < 1024 * 1024) {
    const k = value / 1024
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`
  }
  return `${Number((value / (1024 * 1024)).toFixed(1))}M`
}

/** 毫秒 → 1.2s / 820ms */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 等待秒数 → 「5 秒」/「1 分 23 秒」 */
function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m} 分 ${s} 秒`
}

/** 输出速度 → 42.3 tok/s */
function formatSpeed(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return '—'
  return `${tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} tok/s`
}

export default function AIPane({
  sessionId,
  onToast,
  visible,
  configVersion,
  onOpenSettings
}: AIPaneProps): ReactElement {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [streamingId, setStreamingId] = useState('')
  const [liveFirstTokenMs, setLiveFirstTokenMs] = useState<number | null>(null)
  // 等待 AI 首字回复的已等待秒数（busy && 尚无流式文本时递增）
  const [waitMs, setWaitMs] = useState(0)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [cards, setCards] = useState<CommandCard[]>([])
  /** 已勾选、等待批量审批的命令 id */
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set())
  const [autoApproveModify, setAutoApproveModify] = useState(false)
  const [autoSubmitResults, setAutoSubmitResults] = useState(false)
  const [includeContext, setIncludeContext] = useState(true)
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  const [modelName, setModelName] = useState('')
  /** 是否启用了联网搜索增强（百度搜索） */
  const [searchEnabled, setSearchEnabled] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 当前正在流式输出的消息 id，用于区分新一轮回复 */
  const streamingIdRef = useRef('')
  /** 已声明「使用了联网搜索」但消息体尚未创建的消息 id（解决事件先于消息到达的竞态） */
  const searchedIdsRef = useRef<Set<string>>(new Set())

  /**
   * 拉取 AI 配置。
   * 面板是常驻挂载的，所以配置状态必须显式刷新：
   *  - 设置弹窗保存后（configVersion 变化）
   *  - 面板重新变为可见时（visible 由 false 变 true）
   * 否则「已配置」状态不会同步过来，界面会一直停在「尚未配置 AI 服务」。
   */
  const refreshConfig = useCallback(async (): Promise<void> => {
    const config = await api.ai.getConfig()
    setAutoApproveModify(config.autoApproveModifyCommands)
    setAutoSubmitResults(config.autoSubmitCommandResults)
    setModelName(config.model ?? '')
    setSearchEnabled(Boolean(config.searchEnabled))
    setAiReady(config.enabled && config.hasApiKey)
  }, [])

  useEffect(() => {
    void refreshConfig()
  }, [refreshConfig, configVersion])

  useEffect(() => {
    if (visible) void refreshConfig()
  }, [refreshConfig, visible])

  // 切换主机时清空上一台主机的会话与命令卡片
  useEffect(() => {
    setMessages([])
    setStreaming('')
    setStreamingId('')
    setLiveFirstTokenMs(null)
    setCards([])
    setSelectedCards(new Set())
    streamingIdRef.current = ''
    searchedIdsRef.current = new Set()
  }, [sessionId])

  const scrollToBottom = useCallback(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streaming, cards, scrollToBottom])

  // 问题已提交、AI 尚未返回首字时，累计等待时长并驱动「处理中」动画
  const waitingStart = busy && streaming === ''
  useEffect(() => {
    setWaitMs(0)
    if (!waitingStart) return
    const timer = setInterval(() => setWaitMs((w) => w + 1), 1000)
    return () => clearInterval(timer)
  }, [waitingStart])

  // ---------------------------------------------------------- 事件订阅

  useEffect(() => {
    const offDelta = api.on('ai:delta', (payload: any) => {
      if (payload.sessionId !== sessionId) return
      // 自动回传也会走 delta，这里一并置为忙碌，界面上能看到 AI 正在继续分析
      setBusy(true)
      const delta = payload.delta ?? ''
      if (streamingIdRef.current !== payload.messageId) {
        streamingIdRef.current = payload.messageId
        setStreamingId(payload.messageId)
        setStreaming(delta)
        setLiveFirstTokenMs(null)
      } else {
        setStreaming((prev) => prev + delta)
      }
    })

    // 首字延迟先到，完整指标在 ai:done 时补齐
    const offMetrics = api.on('ai:metrics', (payload: any) => {
      if (payload.sessionId !== sessionId) return
      if (streamingIdRef.current !== payload.messageId) {
        streamingIdRef.current = payload.messageId
        setStreamingId(payload.messageId)
      }
      setLiveFirstTokenMs(payload.firstTokenMs ?? null)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.messageId ? { ...m, firstTokenMs: payload.firstTokenMs } : m
        )
      )
    })

    const offDone = api.on('ai:done', (payload: any) => {
      if (payload.sessionId !== sessionId) return
      const metrics = payload.metrics as AiMetrics | undefined
      setStreaming('')
      setStreamingId('')
      setLiveFirstTokenMs(null)
      streamingIdRef.current = ''
      setBusy(false)
      setMessages((prev) => {
        const exists = prev.some((m) => m.id === payload.messageId)
        const searched = searchedIdsRef.current.has(payload.messageId)
        if (exists) {
          return prev.map((m) =>
            m.id === payload.messageId
              ? {
                  ...m,
                  content: payload.content,
                  pending: false,
                  metrics,
                  firstTokenMs: metrics?.firstTokenMs ?? m.firstTokenMs,
                  ...(searched ? { searched: true } : {})
                }
              : m
          )
        }
        return [
          ...prev,
          {
            id: payload.messageId,
            role: 'assistant',
            content: payload.content,
            createdAt: Date.now(),
            pending: false,
            metrics,
            firstTokenMs: metrics?.firstTokenMs,
            ...(searched ? { searched: true } : {})
          }
        ]
      })
    })

    const offError = api.on('ai:error', (payload: any) => {
      if (payload.sessionId !== sessionId) return
      setStreaming('')
      setStreamingId('')
      setLiveFirstTokenMs(null)
      streamingIdRef.current = ''
      setBusy(false)
      setMessages((prev) => [
        ...prev.map((m) =>
          m.id === payload.messageId ? { ...m, pending: false, error: payload.error } : m
        ),
        {
          id: `${payload.messageId}-err`,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          pending: false,
          error: payload.error
        }
      ])
    })

    // 本次回复使用了联网搜索结果 → 在回复上标记「已联网检索」。
    // 搜索在 AI 开始流式前就已发生，事件可能先于消息体到达，
    // 因此除对已存在消息打标外，还要记录进 searchedIdsRef，供消息创建时补标。
    const offSearch = api.on('ai:search-attached', (payload: any) => {
      if (payload.sessionId !== sessionId) return
      searchedIdsRef.current.add(payload.messageId)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === payload.messageId ? { ...m, searched: true } : m
        )
      )
    })

    // AI 提出的命令清单
    const offCommand = api.on('ai:command', (payload: { commands: ProposedCommand[] }) => {
      setCards((prev) => {
        const known = new Set(prev.map((c) => c.commandId))
        const incoming = (payload.commands ?? [])
          .filter((c) => !known.has(c.commandId))
          .map((c) => ({
            commandId: c.commandId,
            messageId: c.messageId ?? '',
            command: c.command,
            risk: c.risk,
            // 已被策略自动批准的命令直接进入执行中，避免闪现审批按钮
            status: (c.autoApproved ? 'running' : 'pending') as CardStatus
          }))
        return incoming.length ? [...prev, ...incoming] : prev
      })
    })

    // 命令执行结果
    const offResult = api.on('ai:command-result', (outcome: CommandOutcome) => {
      if (outcome.sessionId !== sessionId) return
      setCards((prev) =>
        prev.map((card) =>
          card.commandId === outcome.commandId
            ? {
                ...card,
                status: outcome.rejected
                  ? 'rejected'
                  : outcome.error
                    ? 'error'
                    : 'done',
                result: outcome.result,
                error: outcome.error
              }
            : card
        )
      )
    })

    // 长时命令实时进度：执行中把累计输出刷到卡片
    const offProgress = api.on('ai:command-progress', (progress: CommandProgress) => {
      if (progress.sessionId !== sessionId) return
      setCards((prev) =>
        prev.map((card) =>
          card.commandId === progress.commandId
            ? { ...card, liveOutput: progress.stdout || progress.stderr, status: 'running' }
            : card
        )
      )
    })

    return () => {
      offDelta()
      offMetrics()
      offDone()
      offError()
      offSearch()
      offCommand()
      offResult()
      offProgress()
    }
  }, [sessionId])

  // ------------------------------------------------------------ 动作

  /** 仍待确认、可批量审批的命令 */
  const pendingCards = useMemo(() => cards.filter((card) => card.status === 'pending'), [cards])

  // 命令状态变化后（已批准/拒绝/自动执行）移除失效的勾选，避免批量操作误带旧 id
  useEffect(() => {
    setSelectedCards((prev) => {
      if (prev.size === 0) return prev
      const pendingIds = new Set(pendingCards.map((card) => card.commandId))
      const next = new Set([...prev].filter((id) => pendingIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [pendingCards])

  const approve = useCallback(
    async (card: CommandCard, approved: boolean): Promise<void> => {
      setCards((prev) =>
        prev.map((c) => (c.commandId === card.commandId ? { ...c, status: 'running' } : c))
      )
      try {
        await api.ai.approveCommand(card.commandId, approved)
      } catch (err) {
        setCards((prev) =>
          prev.map((c) =>
            c.commandId === card.commandId
              ? { ...c, status: 'error', error: err instanceof Error ? err.message : String(err) }
              : c
          )
        )
        onToast('error', err instanceof Error ? err.message : String(err))
      }
    },
    [onToast]
  )

  /** 停止正在执行的命令（类似 Ctrl+C） */
  const stopThisCommand = useCallback(
    async (card: CommandCard): Promise<void> => {
      try {
        await api.ai.stopCommand(card.commandId)
        onToast('info', '已发送停止信号')
      } catch (err) {
        onToast('error', err instanceof Error ? err.message : String(err))
      }
    },
    [onToast]
  )

  /** 勾选 / 取消勾选一条待确认命令 */
  const toggleCardSelected = useCallback((commandId: string): void => {
    setSelectedCards((prev) => {
      const next = new Set(prev)
      if (next.has(commandId)) next.delete(commandId)
      else next.add(commandId)
      return next
    })
  }, [])

  /** 全选 / 取消全选待确认命令 */
  const toggleAllPending = useCallback((): void => {
    setSelectedCards((prev) =>
      prev.size === pendingCards.length
        ? new Set()
        : new Set(pendingCards.map((card) => card.commandId))
    )
  }, [pendingCards])

  /** 批量批准 / 拒绝已勾选的命令 */
  const approveSelected = useCallback(
    async (approved: boolean): Promise<void> => {
      const ids = pendingCards
        .map((card) => card.commandId)
        .filter((id) => selectedCards.has(id))
      if (ids.length === 0) return
      const idSet = new Set(ids)
      setCards((prev) =>
        prev.map((card) =>
          idSet.has(card.commandId)
            ? { ...card, status: approved ? 'running' : 'rejected' }
            : card
        )
      )
      setSelectedCards(new Set())
      try {
        await api.ai.approveCommands(ids, approved)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setCards((prev) =>
          prev.map((card) =>
            idSet.has(card.commandId) ? { ...card, status: 'error', error: message } : card
          )
        )
        onToast('error', message)
      }
    },
    [onToast, pendingCards, selectedCards]
  )

  const send = useCallback(async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: text, createdAt: Date.now() }
    ])
    setBusy(true)
    setStreaming('')
    const context = includeContext ? getTerminalContext(60) : undefined
    try {
      await api.ai.chat(sessionId, text, context)
    } catch (err) {
      setBusy(false)
      onToast('error', err instanceof Error ? err.message : String(err))
    }
  }, [busy, includeContext, input, onToast, sessionId])

  const scan = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStreaming('')
    setMessages((prev) => [
      ...prev,
      {
        id: `scan-${Date.now()}`,
        role: 'user',
        content: '【一键巡检】请对服务器做一次完整健康体检',
        createdAt: Date.now()
      }
    ])
    try {
      await api.ai.scan(sessionId)
    } catch (err) {
      setBusy(false)
      onToast('error', err instanceof Error ? err.message : String(err))
    }
  }, [busy, onToast, sessionId])

  const feedResultToAI = useCallback(
    async (command: string, result: CommandResult): Promise<void> => {
      setBusy(true)
      try {
        await api.ai.continueWithResult(sessionId, command, result)
        onToast('info', '执行结果已回传 AI')
      } catch (err) {
        onToast('error', err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [onToast, sessionId]
  )

  const stop = useCallback(async (): Promise<void> => {
    await api.ai.stop(sessionId)
    // 用户主动中止：立刻解除忙碌态，不等主进程的收尾广播
    setBusy(false)
    setStreaming('')
  }, [sessionId])

  /** 新会话：清空服务端上下文与该会话历史，并清空界面上的对话与命令卡片 */
  const newSession = useCallback(async (): Promise<void> => {
    if (busy) await api.ai.stop(sessionId)
    await api.ai.clearHistory(sessionId)
    setMessages([])
    setStreaming('')
    setStreamingId('')
    setLiveFirstTokenMs(null)
    setCards([])
    setSelectedCards(new Set())
    streamingIdRef.current = ''
    setBusy(false)
  }, [sessionId, busy])

  const toggleAutoApprove = async (
    key: 'autoApproveModifyCommands',
    value: boolean
  ): Promise<void> => {
    setAutoApproveModify(value)
    await api.ai.setConfig({ [key]: value })
  }

  const toggleAutoSubmit = async (value: boolean): Promise<void> => {
    setAutoSubmitResults(value)
    await api.ai.setConfig({ autoSubmitCommandResults: value })
  }

  /**
   * 把命令卡片按其所属的 AI 消息分组，
   * 这样审批卡片会串在对应回复下方，而不是全部堆到对话底部。
   */
  const cardsByMessage = useMemo(() => {
    const grouped = new Map<string, CommandCard[]>()
    const orphans: CommandCard[] = []
    for (const card of cards) {
      if (!card.messageId) {
        orphans.push(card)
        continue
      }
      const list = grouped.get(card.messageId)
      if (list) list.push(card)
      else grouped.set(card.messageId, [card])
    }
    return { grouped, orphans }
  }, [cards])

  /** 把当前对话（消息 + 命令执行结果）导出为 Markdown 日志 */
  const exportLog = useCallback(async (): Promise<void> => {
    const lines: string[] = []
    const now = new Date()
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(
      now.getMinutes()
    ).padStart(2, '0')}`
    lines.push('# AgentSSHelper 对话日志', '')
    lines.push(`- 导出时间：${now.toLocaleString()}`)
    lines.push(`- 会话 ID：${sessionId}`)
    if (modelName) lines.push(`- 模型：${modelName}`)
    lines.push(`- 消息数：${messages.length}，命令 ${cards.length} 条`, '', '---', '')

    const renderCard = (card: CommandCard): string[] => {
      const out: string[] = []
      const riskName = RISK_LABEL[card.risk] ?? card.risk
      const stateName =
        card.status === 'done'
          ? '已执行'
          : card.status === 'running'
            ? '执行中'
            : card.status === 'rejected'
              ? '已拒绝'
              : card.status === 'error'
                ? '执行出错'
                : '待确认'
      out.push(`> **命令卡片** \`${card.command}\`（${riskName} · ${stateName}）`)
      if (card.error) out.push('>', '', `> ❌ ${card.error}`)
      if (card.result) {
        const body = card.result.stdout || card.result.stderr || '(无输出)'
        out.push('>', '> 执行结果：')
        out.push(...body.split('\n').map((l) => `> ${l}`))
        if (card.result.code !== 0 && card.result.code !== null) {
          out.push(`>`, `> 退出码：${card.result.code}`)
        }
      }
      out.push('')
      return out
    }

    if (messages.length === 0) {
      lines.push('（当前会话暂无对话）')
    } else {
      for (const message of messages) {
        const label = message.role === 'user' ? '我' : 'AI'
        lines.push(`## ${label}`, '')
        if (message.error) {
          lines.push(`> ❌ ${message.error}`, '')
        } else {
          lines.push(message.content, '')
        }
        if (message.role === 'assistant') {
          for (const card of cardsByMessage.grouped.get(message.id) ?? []) {
            lines.push(...renderCard(card))
          }
        }
      }
    }
    // 游离命令（未归属到某条消息）补在末尾
    if (cardsByMessage.orphans.length) {
      lines.push('## 补充命令记录', '')
      for (const card of cardsByMessage.orphans) lines.push(...renderCard(card))
    }

    const content = lines.join('\n')
    const path = await api.system.exportConversation({
      content,
      defaultPath: `对话日志-${sessionId}-${stamp}.md`
    })
    if (path) onToast('info', `对话已导出：${path}`)
  }, [messages, cards, cardsByMessage, modelName, sessionId, onToast])

  /**
   * 长时命令（如 yum update）的实时输出框自动滚动到最新一行，
   * 让更新内容随进度自动呈现，无需手动下拖。
   * 仅当仍有 running 卡片且其 liveOutput 实际变化时才触发。
   */
  const liveSig = cards
    .filter((c) => c.status === 'running')
    .map((c) => c.liveOutput ?? '')
    .join('\u0000')
  useEffect(() => {
    if (!liveSig) return
    document.querySelectorAll('.cmd-live').forEach((el) => {
      el.scrollTop = el.scrollHeight
    })
    // 依赖累计文本签名：内容一变就滚到底，避免无谓刷新
  }, [liveSig])

  /**
   * 回复下方的运行时指标。
   *
   * 流式阶段只有首字延迟（先到），完整指标在 ai:done 时补齐，
   * 因此这里同时接受「仅首字」和「完整指标」两种输入。
   */
  const renderMetrics = (
    metrics?: AiMetrics,
    firstTokenMs?: number | null
  ): ReactElement | null => {
    if (!metrics && firstTokenMs == null) return null
    const first = metrics?.firstTokenMs ?? firstTokenMs ?? 0
    const used = metrics ? metrics.promptTokens + metrics.outputTokens : 0
    const max = metrics?.maxContextTokens ?? 0
    const ratio = max > 0 ? used / max : 0

    return (
      <div
        className={`chat-metrics${ratio >= 0.9 ? ' near-limit' : ''}`}
        title={
          metrics
            ? `输入 ${metrics.promptTokens} token / 输出 ${metrics.outputTokens} token / 总耗时 ${formatMs(metrics.durationMs)}`
            : undefined
        }
      >
        {modelName && (
          <>
            <span className="chat-model" title="模型">{modelName}</span>
            <span className="sep">·</span>
          </>
        )}
        <span>首字 {formatMs(first)}</span>
        {metrics ? (
          <>
            <span className="sep">·</span>
            <span>{formatSpeed(metrics.tokensPerSecond)}</span>
            <span className="sep">·</span>
            <span>
              上下文 {formatTokenCount(used)} / {formatTokenCount(max)}
              {metrics.estimated ? '（估算）' : ''}
            </span>
          </>
        ) : (
          <>
            <span className="sep">·</span>
            <span>生成中…</span>
          </>
        )}
      </div>
    )
  }

  /** 渲染一张命令审批卡片 */
  const renderCard = (card: CommandCard): ReactElement => (
    <div
      key={card.commandId}
      className={`cmd-card ${card.status}${selectedCards.has(card.commandId) ? ' selected' : ''}`}
    >
      <div className="cmd-head">
        {card.status === 'pending' && (
          <input
            type="checkbox"
            className="cmd-select"
            checked={selectedCards.has(card.commandId)}
            onChange={() => toggleCardSelected(card.commandId)}
            title="勾选后可批量批准或拒绝"
            aria-label={`选择命令 ${card.command}`}
          />
        )}
        <span className={`risk-tag ${card.risk}`}>{RISK_LABEL[card.risk]}</span>
        <code className="cmd-text">{card.command}</code>
      </div>

      {card.risk !== 'safe' && card.status === 'pending' && (
        <p className="cmd-hint">
          {card.risk === 'delete'
            ? '删除类命令，执行前需你确认。'
            : card.risk === 'modify'
              ? '修改类命令，执行前需你确认。'
              : '该命令无法静态判定风险，执行前需你确认。'}
        </p>
      )}

      {card.result && (
        <pre className="cmd-output">
          {card.result.stdout || card.result.stderr || '(无输出)'}
          {card.result.code !== 0 && card.result.code !== null && `\n[退出码 ${card.result.code}]`}
        </pre>
      )}

      {card.status === 'running' && card.liveOutput && (
        <pre className="cmd-output cmd-live" title="执行中的实时输出">
          {card.liveOutput}
        </pre>
      )}

      <div className="cmd-actions">
        {card.status === 'pending' && (
          <>
            <button className="btn tiny primary" onClick={() => void approve(card, true)}>
              执行
            </button>
            <button className="btn tiny ghost" onClick={() => void approve(card, false)}>
              拒绝
            </button>
            <button
              className="btn tiny ghost"
              onClick={() => void navigator.clipboard.writeText(card.command)}
            >
              复制
            </button>
          </>
        )}
        {card.status === 'done' && card.result && !autoSubmitResults && (
          <button
            className="btn tiny ghost"
            onClick={() => void feedResultToAI(card.command, card.result!)}
          >
            把结果交给 AI 继续分析
          </button>
        )}
        {(card.status === 'running' || card.status === 'rejected') && (
          <>
            {card.status === 'running' && (
              <button
                className="btn tiny ghost"
                title="停止正在执行的命令（类似 Ctrl+C）"
                onClick={() => void stopThisCommand(card)}
              >
                ⏹ 停止
              </button>
            )}
            <span className="hint">{card.status === 'running' ? '执行中…' : '已拒绝执行'}</span>
          </>
        )}
        {card.status === 'error' && <span className="error-text">{card.error ?? '执行失败'}</span>}
      </div>
    </div>
  )

  if (aiReady === false) {
    return (
      <div className="pane ai-pane">
        <div className="pane-toolbar">
          <span className="pane-title">AI 运维</span>
        </div>
        <div className="empty-state small">
          <div className="empty-icon">🤖</div>
          <h3>尚未配置 AI 服务</h3>
          <p>请在「设置」中填写 OpenAI 兼容接口地址、API Key 与模型名称后启用。</p>
          <div className="inline-row">
            <button className="btn primary" onClick={onOpenSettings}>
              去设置 AI 服务
            </button>
            <button className="btn ghost" onClick={() => void refreshConfig()}>
              重新检测
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pane ai-pane">
      <div className="pane-toolbar">
        <span className="pane-title">AI 运维</span>
        {searchEnabled && (
          <span className="search-on-badge" title="已启用联网搜索增强（百度搜索）：命中需检索的问题时自动搜索最新资料">
            联网搜索
          </span>
        )}
        <div className="spacer" />
        <label className="checkbox inline">
          <input
            type="checkbox"
            checked={includeContext}
            onChange={(e) => setIncludeContext(e.target.checked)}
          />
          <span>附带终端上下文</span>
        </label>
        <label
          className="checkbox inline"
          title="开启后修改/删除类命令也不再询问。默认关闭，修改与删除始终需要人工确认"
        >
          <input
            type="checkbox"
            checked={autoApproveModify}
            onChange={(e) => void toggleAutoApprove('autoApproveModifyCommands', e.target.checked)}
          />
          <span>修改删除免确认</span>
        </label>
        <label
          className="checkbox inline"
          title="命令执行完成后自动把结果回传给 AI 继续分析，无需手动点击回传"
        >
          <input
            type="checkbox"
            checked={autoSubmitResults}
            onChange={(e) => void toggleAutoSubmit(e.target.checked)}
          />
          <span>结果自动回传</span>
        </label>
        <button className="btn tiny" onClick={() => void scan()} disabled={busy}>
          一键巡检
        </button>
        <button className="btn tiny ghost" title="清空当前对话历史与上下文，开启全新会话" onClick={() => void newSession()}>
          新会话
        </button>
        <button
          className="btn tiny ghost"
          title="把当前对话（含命令执行结果）导出为 Markdown 日志"
          onClick={() => void exportLog()}
          disabled={messages.length === 0}
        >
          导出对话
        </button>
        <button className="btn tiny ghost" onClick={() => void stop()} disabled={!busy}>
          停止
        </button>
      </div>

      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && !streaming && (
          <div className="empty-state small">
            <div className="empty-icon">💡</div>
            <p>试试问：「磁盘满了怎么排查」「Nginx 为什么 502」「看下服务是否正常」。</p>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className="chat-turn">
            <div className={`chat-msg ${message.role}`} data-message-id={message.id}>
              <div className="chat-role">{message.role === 'user' ? '我' : 'AI'}</div>
              <div className="chat-body">
                {message.error ? (
                  <div className="inline-error">{message.error}</div>
                ) : (
                  <Markdown content={message.content} />
                )}
                {message.role === 'assistant' &&
                  message.searched &&
                  !message.error && (
                    <div className="search-attached-tag">已联网检索</div>
                  )}
                {message.role === 'assistant' &&
                  !message.error &&
                  renderMetrics(message.metrics, message.firstTokenMs)}
              </div>
            </div>
            {/* 该条回复触发的命令审批卡片，串在消息下方 */}
            {(cardsByMessage.grouped.get(message.id) ?? []).map((card) => renderCard(card))}
          </div>
        ))}

        {waitingStart && (
          <div className="chat-msg assistant streaming" data-waiting="1">
            <div className="chat-role">AI</div>
            <div className="chat-body">
              <div className="ai-processing">
                <span className="ai-spinner" aria-hidden="true" />
                <span className="ai-processing-label">AI 处理中</span>
                <span className="ai-wait-time">
                  已等待 {formatWait(waitMs)}
                </span>
                <button className="btn tiny ghost" onClick={() => void stop()} title="取消本次提问">
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {streaming && (
          <div className="chat-msg assistant streaming" data-message-id={streamingId}>
            <div className="chat-role">AI</div>
            <div className="chat-body">
              <Markdown content={streaming} />
              {renderMetrics(undefined, liveFirstTokenMs)}
            </div>
          </div>
        )}

        {/* 尚未收到对应回复的卡片（命令事件先于回复事件到达），先暂放末尾 */}
        {cardsByMessage.orphans.map((card) => renderCard(card))}
      </div>

      {/* 批量审批栏：勾选多条待确认命令后一次性批准或拒绝 */}
      {pendingCards.length > 0 && (
        <div className="cmd-batch">
          <label className="checkbox inline">
            <input
              type="checkbox"
              checked={selectedCards.size > 0 && selectedCards.size === pendingCards.length}
              onChange={toggleAllPending}
            />
            <span>全选待确认（{pendingCards.length}）</span>
          </label>
          <span className="hint">已选 {selectedCards.size} 条</span>
          <div className="spacer" />
          <button
            className="btn tiny primary"
            disabled={selectedCards.size === 0}
            onClick={() => void approveSelected(true)}
          >
            批准选中
          </button>
          <button
            className="btn tiny ghost"
            disabled={selectedCards.size === 0}
            onClick={() => void approveSelected(false)}
          >
            拒绝选中
          </button>
        </div>
      )}

      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="输入运维问题，Enter 发送，Shift+Enter 换行"
          rows={3}
          disabled={busy}
        />
        <button className="btn primary" onClick={() => void send()} disabled={busy || !input.trim()}>
          {busy ? '思考中…' : '发送'}
        </button>
      </div>
    </div>
  )
}
