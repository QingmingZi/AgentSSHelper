/** 共享类型定义（主进程 / 预加载 / 渲染进程共用） */

export type AuthType = 'password' | 'privateKey' | 'agent'

export interface HostProfile {
  id: string
  label: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** 私钥文件路径（authType=privateKey 时使用） */
  privateKeyPath?: string
  /** 私钥 passphrase 的保险库键名（不存明文） */
  passphraseSecretKey?: string
  /** 口令的保险库键名（不存明文） */
  passwordSecretKey?: string
  /** 已信任的服务器主机密钥指纹（SHA256），用于防中间人 */
  knownHostFingerprints: string[]
  /** 连接后是否自动进入交互式 shell */
  defaultShell?: boolean
  /** 远程默认工作目录 */
  defaultDirectory?: string
  notes?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
}

export interface AiConfig {
  enabled: boolean
  baseUrl: string
  /** API Key 的保险库键名（不存明文） */
  apiKeySecretKey?: string
  model: string
  temperature: number
  maxTokens: number
  /** 是否自动执行只读命令（只读命令白名单内） */
  autoApproveSafeCommands: boolean
  /** 是否允许修改/删除类命令免确认自动执行。默认关闭，即此类命令一律需人工确认 */
  autoApproveModifyCommands: boolean
  /** 命令执行结果是否自动回传给 AI 继续分析。默认关闭 */
  autoSubmitCommandResults: boolean
  /** 自定义系统提示词（留空则用内置运维提示词） */
  systemPrompt?: string
  /** 每次请求附带的终端上下文行数 */
  contextLines: number
  /** 模型最大上下文窗口（token），默认 256k；用于上下文裁剪与用量展示 */
  maxContextTokens: number
  /** 是否启用百度搜索增强：AI 需要检索时先调用百度搜索取摘要注入上下文 */
  searchEnabled: boolean
  /** 百度搜索 API Key 的保险库键名（不存明文） */
  baiduSearchKeySecretKey?: string
}

export interface AiConfigView extends Omit<AiConfig, 'apiKeySecretKey' | 'baiduSearchKeySecretKey'> {
  hasApiKey: boolean
  apiKeyPreview: string
  hasBaiduSearchKey: boolean
  baiduSearchKeyPreview: string
  /** 百度搜索配额使用情况 */
  searchQuota: SearchQuota
}

/** 百度搜索配额（免费额度按天/按月统计） */
export interface SearchQuota {
  /** 当日已用次数 */
  dailyUsed: number
  /** 每日上限（免费额度） */
  dailyLimit: number
  /** 当月已用次数 */
  monthlyUsed: number
  /** 每月上限（免费额度） */
  monthlyLimit: number
  /** 当日已用量比例 0..1 */
  dailyRatio: number
  /** 当月已用量比例 0..1 */
  monthlyRatio: number
}

/** 单次 AI 请求的运行时指标 */
export interface AiMetrics {
  /** 首个 token 到达耗时（毫秒） */
  firstTokenMs: number
  /** 请求总耗时（毫秒） */
  durationMs: number
  /** 输入（上下文）token 数 */
  promptTokens: number
  /** 输出 token 数 */
  outputTokens: number
  /** 输出速度（token/s，按首字之后到结束计算） */
  tokensPerSecond: number
  /** 当前配置的最大上下文 token 数 */
  maxContextTokens: number
  /** token 数是否来自本地估算（服务端未返回 usage） */
  estimated: boolean
}

export interface SshStatus {
  sessionId: string
  profileId: string
  state: 'connecting' | 'connected' | 'closed' | 'error'
  message?: string
  serverVersion?: string
  fingerprint?: string
}

export interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  mode: number
  mtime: number
  /** 符号链接目标 */
  linkTo?: string
}

export interface TransferTask {
  taskId: string
  sessionId: string
  direction: 'upload' | 'download'
  source: string
  target: string
  totalBytes: number
  transferredBytes: number
  status: 'pending' | 'running' | 'done' | 'error' | 'canceled'
  error?: string
}

export interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
  /** 是否被超时或手动中断 */
  timedOut?: boolean
}

export interface AiMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  /** 从回复中解析出的待执行命令 */
  commands?: string[]
  createdAt: number
  /** 该条消息关联的会话 */
  sessionId?: string
  pending?: boolean
  error?: string
}

/**
 * 命令风险分级（内部判定，供安全模型使用）
 * - safe   只读命令，位于白名单内
 * - modify 修改系统或文件状态
 * - delete 删除数据
 * - risky  无法静态判定（复合命令、未知程序），始终需要人工确认
 */
export type CommandRisk = 'safe' | 'modify' | 'delete' | 'risky'

/**
 * 展示用风险类别（对齐三轴改进 v3 的「四级分离、审批框可读」）：
 * - safe         只读，可自动执行
 * - unknown      未见危险、但无法静态判定（未知程序 / 命令替换 / 复合）
 * - modify       修改型（非删除），需确认
 * - delete       删除数据，需确认
 * - dangerous    高危（sudo/su/source/eval/嵌套危险命令名等），需确认且醒目提示
 * 由内部 CommandRisk 派生，仅用于 UI 展示区分，不影响内部安全判定。
 */
export type RiskKind = 'safe' | 'unknown' | 'modify' | 'delete' | 'dangerous'

/** AI 提出的待执行命令 */
export interface ProposedCommand {
  commandId: string
  sessionId: string
  messageId: string
  command: string
  risk: CommandRisk
  /** 展示用风险类别（未知 vs 危险分离），供审批框醒目区分 */
  riskKind?: RiskKind
  /** 是否已由系统自动批准执行 */
  autoApproved: boolean
}

/** 命令执行结果 */
export interface CommandOutcome {
  commandId: string
  sessionId: string
  command: string
  risk: CommandRisk
  /** 展示用风险类别 */
  riskKind?: RiskKind
  result?: CommandResult
  error?: string
  /** 用户明确拒绝执行 */
  rejected?: boolean
}

/** 命令执行过程中的实时进度（长时命令如 yum update 的中间输出） */
export interface CommandProgress {
  commandId: string
  sessionId: string
  command: string
  /** 已累计的 stdout */
  stdout: string
  /** 已累计的 stderr */
  stderr: string
}

/** 服务器实时资源占用（轮询采样） */
export interface SystemUsage {
  sessionId: string
  /** CPU 使用率百分比 0~100，采集失败时为 null */
  cpu: number | null
  /** 内存使用率百分比 0~100 */
  mem: number | null
  /** 内存用量（已用 / 总量，单位 MB），可空 */
  memUsed: number | null
  memTotal: number | null
  /** 采集时间戳(ms) */
  sampledAt: number
}

/** 主进程 -> 渲染进程的事件通道 */
export const IPC = {
  sshStatus: 'ssh:status',
  sshData: 'ssh:data',
  sshExit: 'ssh:exit',
  aiDelta: 'ai:delta',
  aiMetrics: 'ai:metrics',
  aiDone: 'ai:done',
  aiError: 'ai:error',
  aiCommand: 'ai:command',
  aiCommandResult: 'ai:command-result',
  aiCommandProgress: 'ai:command-progress',
  aiSearchAttached: 'ai:search-attached',
  transferProgress: 'transfer:progress',
  transferDone: 'transfer:done',
  systemUsage: 'system:usage',
  toast: 'app:toast'
} as const
