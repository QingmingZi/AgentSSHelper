import type {
  AiConfig,
  AiMetrics,
  CommandOutcome,
  CommandProgress,
  CommandRisk,
  CommandResult,
  ProposedCommand
} from '@shared/types'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { AiClient, estimateMessagesTokens, type ChatMessage } from './client'
import type { Store } from '../core/store'
import type { SessionManager } from '../ssh/manager'
import { baiduWebSearch, shouldSearch } from '../search/baiduSearch'

/** 命令提案块格式：
 * :::command
 * systemctl status nginx
 * :::
 */
const COMMAND_BLOCK = /:::command\s*\n?([\s\S]*?)\n?\s*:::/g

/** 只读命令白名单（可自动执行） */
const SAFE_COMMANDS = [
  'ls',
  'll',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'pwd',
  'cd',
  'echo',
  'date',
  'who',
  'w',
  'id',
  'whoami',
  'uname',
  'hostname',
  'uptime',
  'free',
  'df',
  'du',
  'stat',
  'find',
  'grep',
  'egrep',
  'awk',
  'sed -n',
  'sort',
  'uniq',
  'wc',
  'ps',
  'top -b',
  'htop',
  'lsof',
  'ss',
  'netstat',
  'ifconfig',
  'ip',
  'ping',
  'traceroute',
  'dig',
  'nslookup',
  'host',
  'lscpu',
  'lsblk',
  'lspci',
  'lsusb',
  'nproc',
  'mount',
  'findmnt',
  'systemctl status',
  'systemctl list-units',
  'systemctl list-timers',
  'systemctl --failed',
  'journalctl',
  'dmesg',
  'last',
  'history',
  'docker ps',
  'docker images',
  'docker logs',
  'kubectl get',
  'kubectl describe',
  'helm list',
  'crontab -l'
]

/**
 * 删除类命令 / 模式
 * 命中即判定为 delete，无论首词是什么（覆盖 `sudo rm -rf` 这类组合）
 */
const DELETE_PATTERNS: RegExp[] = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bshred\b/i,
  /\bunlink\b/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bfdisk\b/i,
  /\bwipefs\b/i,
  /\bmkswap\b/i,
  /\bdd\b/i,
  /\btruncate\b/i,
  /\bftruncate\b/i,
  /\buserdel\b/i,
  /\bgroupdel\b/i,
  /\bdocker\s+(rm|rmi)\b/i,
  /\bdocker\s+(system|volume)\s+(prune|rm)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bhelm\s+(uninstall|delete)\b/i,
  /\bgit\s+(clean|reset\s+--hard|push\b[^;]*--force)\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i
]

/**
 * 修改类命令 / 模式
 * 命中即判定为 modify（改变系统或文件状态，但不删除数据）
 */
const MODIFY_PATTERNS: RegExp[] = [
  /\b(mv|cp|chmod|chown|chgrp|chattr|setfacl|ln|touch|mkdir|patch|truncate)\b/i,
  /\bsystemctl\s+(start|stop|restart|reload|reboot|enable|disable|mask|daemon-reload|reload-or-restart)\b/i,
  /\b(service|initctl)\s+\S+/i,
  /\b(apt|apt-get|yum|dnf|apk|zypper)\b/i,
  /\b(pip|pip3|npm|yarn|pnpm|gem|composer)\s+(install|remove|uninstall|update|upgrade|add|init)\b/i,
  /\b(docker|podman)\s+(start|stop|restart|run|create|exec|build|compose|update)\b/i,
  /\bkubectl\s+(apply|edit|patch|scale|rollout|cordon|drain|exec)\b/i,
  /\bgit\s+(add|commit|checkout|switch|branch|merge|rebase|pull|push|reset|stash|tag|config)\b/i,
  /\bcrontab\s+(?!-l)\S*/i,
  /\bsed\b[^|;]*\s-i\b/i,
  /\btee\b/i,
  /\b(kill|killall|pkill)\b/i,
  /\b(reboot|shutdown|halt|poweroff)\b/i,
  /\b(iptables|ip6tables|ufw|firewall-cmd|nft)\b/i,
  /\b(mount|umount)\b/i,
  /\b(useradd|usermod|groupadd|groupmod|passwd|chpasswd|visudo)\b/i,
  /\bsudo\b/i,
  /\b(curl|wget)\b/i,
  /\b(tar|unzip)\b[^;]*\s(-x|--delete|--strip)\b/i,
  /\bsysctl\b/i,
  /\b(nano|vim|vi|emacs|less)\b\s*\S/i,
  /\bsystemd-run\b/i
]

/** 只读命令中出现即降级为 risky */
const DANGEROUS_PATTERNS: RegExp[] = [/\bsudo\b/i, /\bsu\s+\S/i, /\beval\b/i, /\bsource\b/i]

export type { CommandRisk }

/** 风险等级严重度：risky 最高（永不自动执行），safe 最低 */
const RISK_ORDER: Record<CommandRisk, number> = {
  safe: 0,
  modify: 1,
  delete: 2,
  risky: 3
}

/** awk 系命令：程序里的写法有特殊含义，需要单独判断 */
const AWK_FAMILY = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/** 单个 shell 片段 */
interface ShellSegment {
  /** 去掉引号内容后的单词 */
  words: string[]
  /** 引号内的原始文本 */
  quoted: string[]
}

interface ShellParseResult {
  segments: ShellSegment[]
  /** 引号外出现 > 重定向（会写文件；含 1> file、2> file 等） */
  hasRedirect: boolean
  /** 引号外出现丢弃式重定向（>/dev/null、2>/dev/null、>/dev/null 2>&1 等） */
  hasNullRedirect: boolean
  /** 出现命令替换（$( 或反引号） */
  hasSubstitution: boolean
}

/**
 * 引号感知的 shell 拆分。
 *
 * 只读命令里大量出现引号内的 | > ; （awk 的正则、sed 的脚本），
 * 这些是程序内容而不是 shell 语法，不能当成复合命令处理。
 */
function parseShell(command: string): ShellParseResult {
  const segments: ShellSegment[] = []
  let words: string[] = []
  let quoted: string[] = []
  let current = ''
  let hasRedirect = false
  let hasNullRedirect = false
  let hasSubstitution = false

  const endWord = (): void => {
    if (current) {
      words.push(current)
      current = ''
    }
  }
  const endSegment = (): void => {
    endWord()
    if (words.length || quoted.length) segments.push({ words: [...words], quoted: [...quoted] })
    words = []
    quoted = []
  }

  let i = 0
  while (i < command.length) {
    const ch = command[i]

    // 反斜杠转义：下一个字符按字面量处理（如 find 的 \; ）
    if (ch === '\\' && i + 1 < command.length) {
      current += command[i + 1]
      i += 2
      continue
    }

    // 单引号：内部全部字面量
    if (ch === "'") {
      let j = i + 1
      let buf = ''
      while (j < command.length && command[j] !== "'") {
        buf += command[j]
        j++
      }
      quoted.push(buf)
      i = j + 1
      continue
    }

    // 双引号：内部仍是字面量，但命令替换依然生效
    if (ch === '"') {
      let j = i + 1
      let buf = ''
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '$' && command[j + 1] === '(') hasSubstitution = true
        if (command[j] === '`') hasSubstitution = true
        buf += command[j]
        j++
      }
      quoted.push(buf)
      i = j + 1
      continue
    }

    if (ch === '`') {
      hasSubstitution = true
      i++
      continue
    }
    if (ch === '$' && command[i + 1] === '(') {
      hasSubstitution = true
      i += 2
      continue
    }
    if (ch === '>') {
      endWord()
      // 解析重定向目标：>/dev/null、2>/dev/null 属「丢弃」，不算写文件
      let k = i + 1
      while (k < command.length && (command[k] === ' ' || command[k] === '\t')) k++
      let target = ''
      while (k < command.length && !/[\s|;]/.test(command[k])) {
        target += command[k]
        k++
      }
      if (
        target.toLowerCase() === '/dev/null' ||
        target.toLowerCase() === 'nul' ||
        target === '&1' ||
        target === '&2' ||
        target === '&0'
      ) {
        hasNullRedirect = true
      } else {
        hasRedirect = true
      }
      i = k
      continue
    }
    if (ch === '|' || ch === ';' || ch === '&') {
      endSegment()
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      endWord()
      i++
      continue
    }

    current += ch
    i++
  }
  endSegment()
  return { segments, hasRedirect, hasNullRedirect, hasSubstitution }
}

/** 取命令名（去掉目录前缀） */
function baseName(token: string): string {
  const cleaned = token.replace(/^['"]/, '').replace(/['"]$/, '')
  return cleaned.split('/').filter(Boolean).pop() ?? cleaned
}

/** 是否像路径（路径里的关键词不是命令，不应参与分级） */
function isPathLike(token: string): boolean {
  return token.includes('/') || token.startsWith('.')
}

/**
 * 用于关键词匹配的可扫描文本：
 *  - 第一个单词取命令名（/bin/rm -> rm）
 *  - 其余路径型单词剔除（/etc/passwd 不应命中 passwd 关键词）
 *  - 引号内容不参与（它是数据，不是命令）
 */
function buildScannable(words: string[]): string {
  const kept: string[] = []
  words.forEach((word, index) => {
    if (index === 0) {
      kept.push(baseName(word))
      return
    }
    if (isPathLike(word)) return
    kept.push(word)
  })
  return kept.join(' ')
}

/** 多词白名单模式是否在单词序列中连续出现 */
function containsWordSequence(words: string[], pattern: string): boolean {
  const parts = pattern.split(/\s+/)
  for (let i = 0; i + parts.length <= words.length; i++) {
    if (parts.every((part, j) => words[i + j] === part)) return true
  }
  return false
}

/** 是否命中只读白名单 */
function isWhitelisted(words: string[], base: string): boolean {
  return SAFE_COMMANDS.some((pattern) => {
    if (!pattern.includes(' ')) return base === pattern
    return containsWordSequence(words, pattern)
  })
}

/**
 * awk 程序里的危险写法：
 *  - 输出重定向 print > "file" / print >>"file"（写文件）
 *  - 管道到命令 print | "cmd"（执行命令）
 * 条件里的比较（$3 > 1000）与正则里的 |（/error|warn/）不算危险。
 */
function awkProgramIsDangerous(program: string): boolean {
  // 去掉正则字面量 /.../，其中的 | 只是 alternation
  const withoutRegex = program.replace(/\/[^/]*\//g, '""')
  if (/>>\s*["']/.test(withoutRegex)) return true
  if (/>\s*["']/.test(withoutRegex)) return true
  if (withoutRegex.includes('|')) return true
  return false
}

/** 对单个 shell 片段分级 */
function classifySegment(segment: ShellSegment): CommandRisk {
  const { words, quoted } = segment
  if (!words.length) return 'risky'

  const base = baseName(words[0])
  const scannable = buildScannable(words)

  // awk 系：程序里可能藏着重定向或管道
  if (AWK_FAMILY.has(base) && quoted.some((program) => awkProgramIsDangerous(program))) {
    return 'risky'
  }

  if (DELETE_PATTERNS.some((re) => re.test(scannable))) return 'delete'
  if (MODIFY_PATTERNS.some((re) => re.test(scannable))) return 'modify'

  // find 的 -delete 会删数据，-exec/-ok 会执行任意命令，都无法静态判定
  if (base === 'find') {
    if (words.some((w) => /^-(delete|exec|execdir|ok|okdir)$/.test(w))) {
      return words.includes('-delete') ? 'delete' : 'risky'
    }
  }

  if (!isWhitelisted(words, base)) return 'risky'
  if (DANGEROUS_PATTERNS.some((re) => re.test(scannable))) return 'risky'
  return 'safe'
}

/**
 * 判定命令风险等级
 *
 * safe   只读，位于白名单内
 * delete 删除数据
 * modify 修改状态
 * risky  无法静态判定（命令替换、输出重定向、未知程序），始终需要人工确认
 *
 * 复合命令按 shell 层级拆分成多个片段逐段分级，
 * 只要每一段都是只读，整条命令（含只读管道）才算只读。
 */
export function classifyCommand(raw: string): CommandRisk {
  const cmd = raw.trim()
  if (!cmd) return 'risky'

  const parsed = parseShell(cmd)
  // 命令替换无法静态判定，一律需人工确认
  if (parsed.hasSubstitution) return 'risky'
  // 写文件式重定向（> file、2>file 等）会覆盖/写入数据，需人工确认；
  // 丢弃式（>/dev/null、2>/dev/null、2>&1）不写文件，视为只读的一部分。
  if (parsed.hasRedirect) return 'risky'
  if (!parsed.segments.length) return 'risky'

  let worst: CommandRisk = 'safe'
  for (const segment of parsed.segments) {
    const risk = classifySegment(segment)
    if (RISK_ORDER[risk] > RISK_ORDER[worst]) worst = risk
  }
  return worst
}

/** 风险等级的中文标签 */
export const RISK_LABELS: Record<CommandRisk, string> = {
  safe: '只读',
  modify: '修改',
  delete: '删除',
  risky: '需确认'
}

/**
 * 是否允许免确认自动执行
 * - safe   受「自动执行只读命令」开关控制
 * - modify / delete 受「修改删除免确认」开关控制，默认关闭
 * - risky  永不自动执行
 */
export function canAutoApprove(risk: CommandRisk, config: AiConfig): boolean {
  // 只读命令（ls/df/status/grep/awk/管道等）无副作用，始终自动执行，
  // 避免「只读类型却要人工批准」的歧义，也让界面不再闪现审批按钮。
  if (risk === 'safe') return true
  if (risk === 'modify' || risk === 'delete') return config.autoApproveModifyCommands
  return false
}

/** 从 AI 回复中提取命令提案 */
export function extractCommands(text: string): string[] {
  const out: string[] = []
  let match: RegExpExecArray | null
  COMMAND_BLOCK.lastIndex = 0
  while ((match = COMMAND_BLOCK.exec(text)) !== null) {
    const cmd = match[1].trim()
    if (cmd) out.push(cmd)
  }
  return out
}

export interface HostContext {
  label: string
  host: string
  port: number
  username: string
  osInfo: string
  workingDir: string
}

export const DEFAULT_SYSTEM_PROMPT = `你是一名资深 Linux 运维工程师（SRE），通过 SSH 远程管理 Linux 服务器。

工作准则：
1. 先分析再动手。需要信息时直接读取，不要臆测系统状态。
2. 你可以执行命令。所有需要执行的命令必须写在独立块中，格式严格如下：
:::command
command --with-args
:::
每个块只放一条命令。解释性文字放在命令块之外。
3. **每轮最多只给一条命令**：需要连续操作时，先给第一条，等它的执行结果返回后再基于真实输出给下一条；绝不一次给出多条后续命令。
4. 命令会经过风险分级与审批：
   - 只读命令（查看状态、日志、资源占用）可直接执行；
   - 修改类（重启服务、改配置、改权限、安装软件）与删除类（删除文件、清理数据）必须由用户确认后才会执行；
   - 只读命令组成的管道（如 df -h | sort）按只读处理；输出重定向（>）与命令替换（$( )）一律需要用户确认。
   因此，凡是修改或删除操作，都要用文字清楚说明「将执行什么、影响什么、能否回滚」，便于用户判断。
5. 不要为了「顺手」而删除文件或清理数据。确实需要时，先说明原因并给出可回滚方案。
6. 用中文回答，结论先行，给出具体命令与步骤，不要空泛而谈。`

/**
 * 运维专业知识注入（提炼自 linux-agent-skills 技能库）。
 * 精选 AgentSSHelper 最常用的运维场景，压缩成命令速查表注入 system prompt，
 * 让 AI 在分析、排障、回复时直接套用专业命令，避免空泛建议。
 * 控制篇幅，只保留高价值、可直接执行的命令。
 */
export const LINUX_SKILLS_PROMPT = `【运维知识速查表（可直接套用）】

一、性能排查（USE 方法：利用率/饱和度/错误）
- 60秒诊断：uptime; dmesg | tail; vmstat 1 5; mpstat -P ALL 1 5; pidstat 1 5; iostat -xz 1 5; free -m; sar -n DEV 1 5
- CPU 高：ps aux --sort=-%cpu | head; top -H -p PID; vmstat 1（看 iowait/context switch $12 $13）
- 内存高/不足：free -m; ps aux --sort=-%mem | head; dmesg | grep -i oom; cat /proc/PID/oom_score
- 磁盘 IO 瓶颈：iostat -x 1（%util>80 忙、await>10ms 延迟高、avgqu-sz>1 队列积压）; iotop -o; df -h / df -i
- 找大文件：du -sh /* | sort -rh | head; find / -type f -size +100M; 已删占用 lsof | grep deleted
- 网络：ss -s; ss -tan state time-wait | wc -l; netstat -s | grep overflow

二、网络排障
- 端口监听：ss -tlnp | grep :PORT（或 lsof -i :PORT）
- 连通性：ping -c 4 HOST; nc -zv HOST PORT; traceroute -n / mtr HOST
- DNS：dig HOST; dig +short HOST; cat /etc/resolv.conf
- HTTP 测试：curl -I URL; curl -w "HTTP:%{http_code} Time:%{time_total}s" -o /dev/null -s URL
- 抓包：tcpdump -i any port 80 -nn; tcpdump -i eth0 host IP
- 定位占用端口进程：lsof -i :PORT → fuser -k 8080/tcp

三、Nginx / Web 排障
- 配置检测：nginx -t（改配置后必测）; nginx -T
- 服务：systemctl status/restart/reload nginx
- 502/504：查后端服务与 upstream，upstream 到后端；504 增大 proxy_read_timeout
- 日志：tail -f /var/log/nginx/error.log; 访问日志在 /var/log/nginx/access.log
- 权限问题：检查文件属主、SELinux（getenforce）

四、日志分析
- 按时间：journalctl --since "1 hour ago" --until "2026-01-01 10:00"
- 搜索：grep -E "error|warn" LOG; grep -C 3 error LOG; rg "pat" LOG
- 统计：grep -c; sort | uniq -c | sort -rn（频率排行）
- awk 解析：awk '{print $1}' LOG; awk '$9 == 500' LOG（第9列状态码）
- access.log 分析：状态码 awk '{print $9}' | sort | uniq -c | sort -rn; IP 排行 awk '{print $1}' | sort | uniq -c | sort -rn | head; 404 统计
- 安全分析：grep "Failed password" /var/log/auth.log

五、系统加固 / 安全基线（只读排查用，修改类需用户确认）
- SSH：grep -E "PermitRootLogin|PasswordAuthentication" /etc/ssh/sshd_config; 建议 PermitRootLogin no、PubkeyAuthentication yes
- 密码策略：grep -E "PASS_MAX_DAYS|PASS_MIN_LEN" /etc/login.defs
- 内核：sysctl net.ipv4.tcp_syncookies
- 关键文件权限：ls -l /etc/shadow /etc/passwd /etc/gshadow; stat -c '%a %n' /etc/passwd
- 无密码账户：awk -F: '$2 == "" {print $1}' /etc/shadow
- SUID 异常：find / -perm /4000 -type f 2>/dev/null
- 开放端口：ss -tlnp`

export function buildSystemPrompt(config: AiConfig, context: HostContext): string {
  const custom = config.systemPrompt?.trim()
  const base = custom || DEFAULT_SYSTEM_PROMPT
  const searchHint = config.searchEnabled
    ? `

【联网检索】本工具会在必要时自动调用百度搜索。若收到的提问中包含【在线资料 · 百度搜索】块，请优先参考其中的最新资料作答，并在涉及具体命令、版本、配置时以检索到的内容为准；引用资料时简要注明来源。`
    : ''
  return `${base}

---
【当前连接上下文】
主机别名：${context.label}
地址：${context.username}@${context.host}:${context.port}
系统信息：${context.osInfo || '未知'}
当前工作目录：${context.workingDir || '未知'}
---

${LINUX_SKILLS_PROMPT}${searchHint}`
}

/** 一键巡检采集的只读诊断命令 */
export const DIAGNOSTIC_COMMANDS = [
  'uname -a',
  'cat /etc/os-release',
  'uptime',
  'free -m',
  'df -h',
  'df -i',
  'lsblk',
  'ps aux --sort=-%mem | head -15',
  'ss -s',
  'systemctl --failed --no-pager',
  'dmesg -T | tail -30',
  'journalctl -p err -n 30 --no-pager'
]

export interface ChatOptions {
  /** 终端最近输出等上下文 */
  context?: string
  onDelta: (text: string) => void
  /** 首个 token 到达耗时（毫秒） */
  onFirstToken?: (latencyMs: number) => void
  onCommand: (commands: string[]) => void
  onDone: (fullText: string, metrics?: AiMetrics) => void
  onError: (err: Error) => void
  /** 本次请求实际使用了联网搜索结果时回调（参数为搜索关键词） */
  onSearched?: (keyword: string) => void
}

export class AiOpsService extends EventEmitter {
  private readonly histories = new Map<string, ChatMessage[]>()
  private readonly aborters = new Map<string, AbortController>()
  /** 等待用户确认的命令 */
  private readonly pending = new Map<string, ProposedCommand>()
  /** 被用户手动停止的会话：停止后不再自动回传，避免点「停止」后链条继续跑 */
  private readonly stoppedSessions = new Set<string>()
  /** 每个会话的「结果回传」串行队列，避免并发回传把对话历史插乱 */
  private readonly continueQueues = new Map<string, Promise<void>>()
  /** 每个会话最近一次回传的内容签名，用于去重：同一命令+同一结果不会重复注入历史 */
  private readonly lastFeed = new Map<string, string>()
  /** 正在执行的命令：commandId -> AbortController，供「停止执行」中断（类似 Ctrl+C） */
  private readonly runningCommands = new Map<string, AbortController>()

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager
  ) {
    super()
  }

  /**
   * 处理 AI 提出的命令。
   * 规则：一轮回复只执行第一条命令，其余命令一律丢弃（不建卡片）。
   * 后续命令依赖上一步输出，交给 AI 看到真实结果后续算。
   * - 广播单条命令清单，供界面渲染审批卡片
   * - 符合自动执行策略的命令直接执行，否则挂起等待用户确认
   */
  async dispatchCommands(
    sessionId: string,
    messageId: string,
    commands: string[]
  ): Promise<ProposedCommand[]> {
    // 每轮最多执行一条命令：后续命令往往依赖上一步输出，
    // 交给 AI 看到真实结果后续算。多余的命令一律丢弃，不建卡片。
    const first = commands[0]?.trim()
    if (!first) return []
    const config = this.store.getAiConfig()
    const risk = classifyCommand(first)
    // 单步执行：唯一命令可自动执行（取决于其风险与开关），无需等待后继
    const autoApproved = canAutoApprove(risk, config)
    const record: ProposedCommand = {
      commandId: randomUUID(),
      sessionId,
      messageId,
      command: first,
      risk,
      autoApproved
    }

    // 先同步广播清单，保证界面先建卡片再收到执行结果
    this.emit('commands', [record])

    if (record.autoApproved) {
      await this.executeProposal(record)
    } else {
      this.pending.set(record.commandId, record)
    }
    return [record]
  }

  /**
   * 用户对命令做出审批决定。
   * @param approved true=执行，false=拒绝
   */
  async approveCommand(commandId: string, approved: boolean): Promise<CommandOutcome | undefined> {
    const proposal = this.pending.get(commandId)
    if (!proposal) throw new Error('命令不存在或已处理')
    this.pending.delete(commandId)

    if (!approved) {
      const outcome: CommandOutcome = {
        commandId,
        sessionId: proposal.sessionId,
        command: proposal.command,
        risk: proposal.risk,
        rejected: true
      }
      this.emit('command-outcome', outcome)
      return outcome
    }
    return this.executeProposal(proposal)
  }

  /**
   * 批量审批多条待确认命令。
   *
   * 审批卡片上勾选后一次提交，避免逐条点击。执行按提交顺序串行，
   * 单条失败（例如已被其他操作处理）不会中断整批。
   */
  async approveCommands(commandIds: string[], approved: boolean): Promise<CommandOutcome[]> {
    const outcomes: CommandOutcome[] = []
    for (const commandId of commandIds) {
      try {
        const outcome = await this.approveCommand(commandId, approved)
        if (outcome) outcomes.push(outcome)
      } catch {
        // 命令不存在或已处理：跳过，继续处理剩余命令
      }
    }
    return outcomes
  }

  /**
   * 停止正在执行的命令（等效 Ctrl+C）。
   * 中断当前命令的 SSH 通道，命令将以中断状态结束。
   */
  stopCommand(commandId: string): boolean {
    const controller = this.runningCommands.get(commandId)
    if (!controller) return false
    controller.abort()
    return true
  }

  /** 实际执行一条已获准的命令 */
  private async executeProposal(proposal: ProposedCommand): Promise<CommandOutcome> {
    const controller = new AbortController()
    let stdoutBuf = ''
    let stderrBuf = ''
    const pushProgress = (): void => {
      this.emit('command-progress', {
        commandId: proposal.commandId,
        sessionId: proposal.sessionId,
        command: proposal.command,
        stdout: stdoutBuf,
        stderr: stderrBuf
      } satisfies CommandProgress)
    }
    this.runningCommands.set(proposal.commandId, controller)
    try {
      const result = await this.executeCommand(proposal.sessionId, proposal.command, {
        signal: controller.signal,
        onData: (chunk) => {
          stdoutBuf += chunk
          pushProgress()
        }
      })
      const outcome: CommandOutcome = { ...proposal, result }
      this.emit('command-outcome', outcome)
      return outcome
    } catch (err) {
      const outcome: CommandOutcome = {
        ...proposal,
        error: err instanceof Error ? err.message : String(err)
      }
      this.emit('command-outcome', outcome)
      return outcome
    } finally {
      this.runningCommands.delete(proposal.commandId)
    }
  }

  /** 清理某会话下所有待确认命令 */
  clearPending(sessionId: string): void {
    for (const [id, proposal] of [...this.pending]) {
      if (proposal.sessionId === sessionId) this.pending.delete(id)
    }
  }

  private async client(): Promise<AiClient> {
    const config = this.store.getAiConfig()
    const apiKey = (await this.store.getAiApiKey()) ?? ''
    return new AiClient(config, apiKey)
  }

  /**
   * 取出（并首次创建）某个会话的对话历史。
   * 必须把数组存回 map，否则历史只是临时数组，请求发出后即丢失，
   * AI 将失去多轮对话上下文。
   */
  private historyFor(sessionId: string): ChatMessage[] {
    let history = this.histories.get(sessionId)
    if (!history) {
      history = []
      this.histories.set(sessionId, history)
    }
    return history
  }

  /** 读取远端系统信息，作为 AI 上下文 */
  async collectHostContext(sessionId: string): Promise<HostContext> {
    const profile = this.sessions.get(sessionId).profile
    let osInfo = ''
    let workingDir = ''
    try {
      const [os, pwd] = await Promise.all([
        this.sessions.get(sessionId).exec('cat /etc/os-release 2>/dev/null || uname -a', {
          timeout: 8000
        }),
        this.sessions.get(sessionId).exec('pwd', { timeout: 8000 })
      ])
      osInfo = (os.stdout || os.stderr).trim().split('\n').slice(0, 4).join('; ')
      workingDir = pwd.stdout.trim()
    } catch {
      /* 上下文采集失败不阻断对话 */
    }
    return {
      label: profile.label,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      osInfo,
      workingDir
    }
  }

  /**
   * 按最大上下文预算裁剪请求消息。
   *
   * 保留 system 提示与最后一条消息（当前问题 / 命令结果 / 巡检报告），
   * 从最早的历史消息开始丢弃，避免 prompt + 输出超过模型窗口。
   * 最后一条消息即使仍然超预算也不丢，否则请求会变成没有用户问题的空对话。
   */
  private fitMessagesToContext(messages: ChatMessage[], config: AiConfig): ChatMessage[] {
    const maxContext = Math.max(1024, config.maxContextTokens || 256 * 1024)
    // 给模型输出预留空间，至少保留 256 token
    const budget = Math.max(512, maxContext - Math.max(256, config.maxTokens))
    const result = messages.map((message) => ({ ...message }))

    while (result.length > 2 && estimateMessagesTokens(result) > budget) {
      const index = result.findIndex(
        (message, i) => i > 0 && i < result.length - 1 && message.role !== 'system'
      )
      if (index < 0) break
      result.splice(index, 1)
    }
    return result
  }

  /** 发送一条用户消息，流式返回 AI 回复 */
  async chat(sessionId: string, userMessage: string, options: ChatOptions): Promise<void> {
    const config = this.store.getAiConfig()
    if (!config.enabled) {
      options.onError(new Error('AI 运维未启用，请先在设置中配置 API'))
      return
    }
    const apiKey = this.store.getAiApiKey()
    if (!apiKey) {
      options.onError(new Error('未配置 API Key'))
      return
    }

    // 用户重新提问即视为解除之前的「停止」
    this.resume(sessionId)

    const context = await this.collectHostContext(sessionId)
    const system = buildSystemPrompt(config, context)

    const history = this.historyFor(sessionId)
    // 系统提示固定在第一条，并随主机信息刷新
    if (history.length === 0 || history[0].role !== 'system') {
      history.unshift({ role: 'system', content: system })
    } else {
      history[0] = { role: 'system', content: system }
    }

    // 本次请求的消息 = 历史快照 + 当前问题。
    // 终端上下文只出现在本次请求里，不写进历史，
    // 否则每一轮都会在历史里堆一份重复的终端快照，白白消耗 token。
    // 联网搜索（百度）开启时，命中启发式则先检索并注入摘要，不写进历史。
    let userContent = options.context?.trim()
      ? `${userMessage}\n\n【终端最近输出（供参考）】\n${options.context.trim()}`
      : userMessage

    if (config.searchEnabled) {
      const baiduKey = await this.store.getBaiduSearchKey()
      if (baiduKey && shouldSearch(userMessage)) {
        const result = await baiduWebSearch(userMessage, baiduKey)
        if (result) {
          this.store.recordSearchUsage()
          options.onSearched?.(result.keyword)
          // 搜索结果优先注入，让模型基于最新资料回答
          userContent = `${result.snippet}\n\n${userContent}`
        }
      }
    }

    const requestMessages = this.fitMessagesToContext(
      [
        ...history.map((message) => ({ ...message })),
        {
          role: 'user',
          content: userContent
        }
      ],
      config
    )

    // 历史只记录干净的对话轮次
    history.push({ role: 'user', content: userMessage })

    const controller = new AbortController()
    this.aborters.set(sessionId, controller)

    await (await this.client()).chat(requestMessages, {
      onDelta: options.onDelta,
      onFirstToken: options.onFirstToken,
      onDone: (full, metrics) => {
        history.push({ role: 'assistant', content: full })
        this.truncate(history)
        this.aborters.delete(sessionId)
        // 用户点了「停止」：半截回复里解析出的命令不再进入审批 / 执行流程
        if (!controller.signal.aborted) options.onCommand(extractCommands(full))
        options.onDone(full, metrics)
      },
      onError: (err) => {
        this.aborters.delete(sessionId)
        options.onError(err)
      }
    }, controller.signal)
  }

  /**
   * 把命令执行结果回传给 AI 继续分析。
   *
   * 同一会话内的多次回传会被串行化：
   * 并发回传会让对话历史出现「连续两条 user 消息」，模型容易读错上下文。
   */
  async continueWithResult(
    sessionId: string,
    command: string,
    result: CommandResult,
    handlers: {
      onDelta?: (text: string) => void
      onFirstToken?: (latencyMs: number) => void
      onCommand?: (commands: string[]) => void
      onDone?: (full: string, metrics?: AiMetrics) => void
      onError?: (err: Error) => void
    } = {}
  ): Promise<void> {
    const previous = this.continueQueues.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.runContinueWithResult(sessionId, command, result, handlers),
      () => this.runContinueWithResult(sessionId, command, result, handlers)
    )
    this.continueQueues.set(
      sessionId,
      task.then(
        () => undefined,
        () => undefined
      )
    )
    await task
  }

  private async runContinueWithResult(
    sessionId: string,
    command: string,
    result: CommandResult,
    handlers: {
      onDelta?: (text: string) => void
      onFirstToken?: (latencyMs: number) => void
      onCommand?: (commands: string[]) => void
      onDone?: (full: string, metrics?: AiMetrics) => void
      onError?: (err: Error) => void
    }
  ): Promise<void> {
    // 用户已手动停止：排队的回传直接丢弃，不再打扰用户
    if (this.stoppedSessions.has(sessionId)) return
    // 去重：同一命令 + 相同结果已经在历史末尾注入过，跳过本次，
    // 避免重复的「命令执行结果」块把对话撑大、让模型重复输出。
    const signature = `${command}\u0000${result?.code ?? ''}\u0000${result?.stdout ?? ''}\u0000${result?.stderr ?? ''}`
    if (this.lastFeed.get(sessionId) === signature) return
    this.lastFeed.set(sessionId, signature)
    const history = this.historyFor(sessionId)
    history.push({
      role: 'user',
      content: `命令 \`${command}\` 的执行结果：\n退出码：${result.code}\n标准输出：\n${result.stdout || '(空)'}\n标准错误：\n${result.stderr || '(空)'}`
    })
    const controller = new AbortController()
    this.aborters.set(sessionId, controller)
    const apiKey = await this.store.getAiApiKey()
    if (!apiKey) {
      handlers.onError?.(new Error('未配置 API Key'))
      return
    }
    const requestMessages = this.fitMessagesToContext(history, this.store.getAiConfig())
    await (await this.client()).chat(requestMessages, {
      onDelta: (text) => handlers.onDelta?.(text),
      onFirstToken: (latencyMs) => handlers.onFirstToken?.(latencyMs),
      onDone: (full, metrics) => {
        history.push({ role: 'assistant', content: full })
        this.truncate(history)
        this.aborters.delete(sessionId)
        // 追问回复中若又提出新命令，同样进入审批流程；
        // 但用户点过「停止」时，半截回复里的命令不再执行
        const commands = controller.signal.aborted ? [] : extractCommands(full)
        if (commands.length) handlers.onCommand?.(commands)
        handlers.onDone?.(full, metrics)
      },
      onError: (err) => {
        this.aborters.delete(sessionId)
        handlers.onError?.(err)
      }
    }, controller.signal)
  }

  stop(sessionId: string): void {
    this.aborters.get(sessionId)?.abort()
    this.aborters.delete(sessionId)
    // 停止后不再自动回传：正在排队的回传任务也会被丢弃
    this.stoppedSessions.add(sessionId)
  }

  /** 会话是否已被用户手动停止 */
  isStopped(sessionId: string): boolean {
    return this.stoppedSessions.has(sessionId)
  }

  /** 用户重新发起对话 / 手动回传时解除停止状态 */
  resume(sessionId: string): void {
    this.stoppedSessions.delete(sessionId)
  }

  /** 一键巡检：采集只读诊断信息，交给 AI 分析 */
  async scan(sessionId: string, options: Omit<ChatOptions, 'onCommand'>): Promise<void> {
    const config = this.store.getAiConfig()
    if (!config.enabled) {
      options.onError(new Error('AI 运维未启用，请先在设置中配置 API'))
      return
    }
    // 巡检同样视为用户重新发起，解除「停止」
    this.resume(sessionId)
    const session = this.sessions.get(sessionId)

    const collected: Array<{ cmd: string; output: string; code: number | null }> = []
    for (const cmd of DIAGNOSTIC_COMMANDS) {
      try {
        const res = await session.exec(cmd, { timeout: 15_000 })
        const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
        collected.push({ cmd, output: output || '(无输出)', code: res.code })
      } catch (err) {
        collected.push({ cmd, output: `执行失败：${err instanceof Error ? err.message : err}`, code: null })
      }
    }

    const context = await this.collectHostContext(sessionId)
    const system = buildSystemPrompt(config, context)
    const report = collected
      .map((c) => `$ ${c.cmd}\n${c.output}`)
      .join('\n\n')

    const prompt = `请对这台服务器做一次完整健康巡检。以下是已采集的系统状态信息：

${report}

请输出：
1. 总体健康结论（正常 / 有隐患 / 存在故障）
2. 逐项发现的问题点，标注严重程度（严重/警告/提示）
3. 针对每个问题的处置建议，需要执行的命令用命令块给出

注意：采集过程中包含管道命令属于只读操作，但你在建议中的命令仍需按规则用命令块单独给出。`

    const history = this.historyFor(sessionId)
    // 系统提示同样刷新
    if (history.length === 0 || history[0].role !== 'system') {
      history.unshift({ role: 'system', content: system })
    } else {
      history[0] = { role: 'system', content: system }
    }

    // 巡检报告较长：只出现在本次请求里，历史里留一条简短记录，
    // 既保持上下文连续，又不至于让长报告在每轮里反复携带。
    const requestMessages = this.fitMessagesToContext(
      [...history.map((message) => ({ ...message })), { role: 'user', content: prompt }],
      config
    )
    history.push({ role: 'user', content: '【一键巡检】请对服务器做完整健康体检' })

    const controller = new AbortController()
    this.aborters.set(sessionId, controller)
    await (await this.client()).chat(requestMessages, {
      onDelta: options.onDelta,
      onFirstToken: options.onFirstToken,
      onDone: (full, metrics) => {
        history.push({ role: 'assistant', content: full })
        this.truncate(history)
        this.aborters.delete(sessionId)
        options.onDone(full, metrics)
      },
      onError: (err) => {
        this.aborters.delete(sessionId)
        options.onError(err)
      }
    }, controller.signal)
  }

  /** 执行已获准的命令。仅供内部审批流程调用，外部不得直接调用 */
  private async executeCommand(
    sessionId: string,
    command: string,
    options: {
      sudo?: boolean
      timeout?: number
      signal?: AbortSignal
      onData?: (chunk: string) => void
    } = {}
  ): Promise<CommandResult> {
    const session = this.sessions.get(sessionId)
    return session.exec(command, {
      sudo: options.sudo,
      timeout: options.timeout ?? 120_000,
      cwd: session.profile.defaultDirectory,
      signal: options.signal,
      onData: options.onData
    })
  }

  private truncate(history: ChatMessage[]): void {
    // 保留 system + 最近 20 条，控制上下文长度
    if (history.length > 21) {
      const system = history[0]
      const tail = history.slice(history.length - 20)
      this.setHistory(history, [system, ...tail])
    }
  }

  private setHistory(old: ChatMessage[], next: ChatMessage[]): void {
    old.splice(0, old.length, ...next)
  }

  clearHistory(sessionId: string): void {
    this.histories.delete(sessionId)
    this.lastFeed.delete(sessionId)
  }
}
