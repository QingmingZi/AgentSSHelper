import { EventEmitter } from 'node:events'
import type { SystemUsage } from '@shared/types'
import type { SessionManager } from './manager'

/**
 * 服务器实时资源占用采样器。
 *
 * 每 `intervalMs`（默认 2s）对**所有已连接的会话**执行一次轻量只读探测，
 * 解析 CPU 使用率与内存占用，解析成功后通过 `usage` 事件广播，供渲染层顶部栏动态显示。
 *
 * 探测命令只依赖 /proc 与 awk，最大限度兼容各类 Linux 发行版（busybox 也带 awk）。
 * CPU 通过 /proc/stat 两次采样（间隔 1s）的增量计算，内存通过 /proc/meminfo。
 */
export class SystemUsageMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly sessions: SessionManager,
    private readonly intervalMs = 2_000
  ) {
    super()
  }

  /** 开始周期采样 */
  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs)
  }

  /** 停止采样 */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }

  isRunning(): boolean {
    return this.running
  }

  private async pollOnce(): Promise<void> {
    const sessions = this.sessions.list()
    // 无连接会话时直接跳过，保持定时器运行，新连接后自动恢复采样
    if (sessions.length === 0) return
    await Promise.allSettled(
      sessions.map((s) => this.sample(s.sessionId).catch(() => undefined))
    )
  }

  private async sample(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    const res = await session.exec(PROBE_COMMAND, { timeout: 2_500 })
    const usage = parseUsage(sessionId, res.stdout)
    if (!usage) return
    this.emit('usage', usage satisfies SystemUsage)
  }
}

/**
 * 单条只读探测命令：
 *  - 输出一行 mem=<availableKB>/<totalKB>
 *  - 输出一行 cpu=<busyTicks>/<totalDeltaTicks>
 *  - 内嵌 sleep 1 采集 CPU 自上次累计的增量，再除以自身 delta 得到该等待区间利用率，
 *    避免依赖开机以来的均值造成数值反应迟钝。
 */
const PROBE_COMMAND = [
  `mem_kb=$(awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{print a"/"t}' /proc/meminfo)`,
  // CPU：取两次 /proc/stat 的 cpu 行（间隔 sleep 1）。
  // total = 除第1列外所有字段($2..$NF)之和；rest(idle) = idle($5)+iowait($6)。
  // 单次 awk 只读一次 /proc/stat 并输出 "total rest" 两值，避免多次读快照不一致。
  `s1=$(awk 'NR==1{for(i=2;i<=NF;i++)t+=$i; print t" " ($5+$6)}' /proc/stat)`,
  `sleep 1`,
  `s2=$(awk 'NR==1{for(i=2;i<=NF;i++)t+=$i; print t" " ($5+$6)}' /proc/stat)`,
  `t1=\${s1% *}`,
  `r1=\${s1##* }`,
  `t2=\${s2% *}`,
  `r2=\${s2##* }`,
  `dt=$((t2-t1))`,
  `dr=$((r2-r1))`,
  `db=$((dt-dr))`,
  `echo "mem=$mem_kb"`,
  `echo "cpu=$db/$dt"`
].join('; ')

function parseUsage(sessionId: string, stdout: string): SystemUsage | null {
  const lines = stdout.split('\n')
  const memLine = lines.find((l) => l.startsWith('mem='))
  const cpuLine = lines.find((l) => l.startsWith('cpu='))

  let memUsed: number | null = null
  let memTotal: number | null = null
  let mem: number | null = null
  if (memLine) {
    const m = memLine.match(/^mem=(\d+)\/(\d+)$/)
    if (m) {
      const availKB = Number(m[1])
      const totalKB = Number(m[2])
      if (totalKB > 0) {
        memTotal = Math.round((totalKB / 1024) * 10) / 10
        const usedKB = totalKB - availKB
        memUsed = Math.round((usedKB / 1024) * 10) / 10
        mem = Math.round((usedKB / totalKB) * 1000) / 10
      }
    }
  }

  let cpu: number | null = null
  if (cpuLine) {
    const c = cpuLine.match(/^cpu=(\d+)\/(\d+)$/)
    if (c) {
      const busy = Number(c[1])
      const total = Number(c[2])
      if (total > 0) {
        cpu = Math.min(100, Math.max(0, Math.round((busy / total) * 1000) / 10))
      }
    }
  }

  if (mem === null && cpu === null) return null

  return {
    sessionId,
    cpu,
    mem,
    memUsed,
    memTotal,
    sampledAt: Date.now()
  }
}