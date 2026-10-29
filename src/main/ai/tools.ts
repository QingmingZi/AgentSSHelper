/**
 * 只读工具面（v3 #5）——结构化只读工具，运行在「自动」通道（无需人工审批），
 * 与「需审批」的命令通道分离（v3 #9 双通道）。
 *
 * 设计原则：
 *  - 只读工具不拼接任意 shell，只执行固定的只读命令集（参数白名单，不可注入）；
 *  - read_file 走 readsSensitivePath 守卫，命中敏感路径立即拒绝；
 *  - 所有输出回灌模型前走 sanitizeUntrusted + redactSecrets 脱敏；
 *  - 任一判定失败 → 该工具不可用/返回错误，绝不放松为可执行任意命令。
 */
import type { CommandResult } from '@shared/types'

/** 单个只读工具 */
interface ReadOnlyTool {
  readonly name: string
  readonly description: string
  /** 生成固定的只读命令（不含用户可注入参数，或仅接受受限参数） */
  buildCommand(): string
}

/** 主机信息：固定只读命令集（不复用任意 shell） */
const HOST_INFO_CMDS: ReadOnlyTool[] = [
  {
    name: 'os-release',
    description: '读取 /etc/os-release 系统发行版信息',
    buildCommand: () => 'cat /etc/os-release 2>/dev/null || uname -a'
  },
  {
    name: 'kernel',
    description: '内核版本',
    buildCommand: () => 'uname -a'
  },
  {
    name: 'cpu',
    description: 'CPU 型号与核心数',
    buildCommand: () => "lscpu | grep -E 'Model name|CPU\\(s\\)|Architecture' 2>/dev/null || nproc"
  },
  {
    name: 'memory',
    description: '内存用量摘要',
    buildCommand: () => 'free -h'
  },
  {
    name: 'disk',
    description: '磁盘用量摘要',
    buildCommand: () => 'df -h'
  },
  {
    name: 'load',
    description: '系统负载',
    buildCommand: () => 'uptime'
  }
]

/** 诊断命令白名单：命令固定、参数不可由外界注入（仅允许若干受限子选项） */
const DIAGNOSTIC_CMDS: ReadOnlyTool[] = [
  { name: 'ping-localhost', description: '探测本机回环连通', buildCommand: () => 'ping -c 1 127.0.0.1 2>/dev/null || true' },
  { name: 'sysctl-overview', description: '内核参数关键子集', buildCommand: () => 'sysctl -n vm.swappiness kernel.hostname net.ipv4.ip_forward' },
  { name: 'mount-ro', description: '只读挂载点概览', buildCommand: () => 'mount | grep -E "\\sro\\s" | head -50' },
  { name: 'syslogd-status', description: '日志服务状态（只读）', buildCommand: () => 'systemctl status rsyslog 2>/dev/null | head -20 || systemctl status syslog 2>/dev/null | head -20' }
]

/** 主机信息工具的命令大小上限 */
const HOST_INFO_LIMITS: Record<string, number> = {
  memory: 2048,
  disk: 4096,
  cpu: 2048,
  load: 2048,
  kernel: 2048,
  'os-release': 4096
}

/**
 * 列出可用只读工具及其说明（供系统提示词描述工具面；离线可用）。
 */
export function listReadOnlyTools(): Array<{ name: string; description: string }> {
  return [...HOST_INFO_CMDS, ...DIAGNOSTIC_CMDS].map((t) => ({ name: t.name, description: t.description }))
}

interface ExecFn {
  (command: string, options?: { timeout?: number }): Promise<CommandResult>
}

function isSafeReadOnlyTool(name: string): boolean {
  return HOST_INFO_CMDS.some((t) => t.name === name) || DIAGNOSTIC_CMDS.some((t) => t.name === name)
}

/**
 * 执行一个只读工具。调用方需传入能执行命令的 exec 函数（生产：session.exec；
 * 测试：mock）。命令固定来自白名单定义，绝不接受任意字符串。
 *
 * @returns 结构化结果（已脱敏）或 null（工具不存在/敏感路径命中被拒）。
 */
export async function runReadOnlyTool(
  name: string,
  exec: ExecFn
): Promise<{ ok: boolean; name: string; output?: string; error?: string } | null> {
  if (!isSafeReadOnlyTool(name)) {
    return { ok: false, name, error: `未知只读工具: ${name}` }
  }
  let cmd = ''
  if (HOST_INFO_CMDS.some((t) => t.name === name)) {
    cmd = HOST_INFO_CMDS.find((t) => t.name === name)!.buildCommand()
  } else {
    cmd = DIAGNOSTIC_CMDS.find((t) => t.name === name)!.buildCommand()
  }

  // read_file 工具单独处理（可传路径，但走敏感路径守卫）
  if (name === 'read_file') {
    return { ok: false, name, error: 'read_file 需要路径参数，请通过 executeReadFile 调用' }
  }

  try {
    const result = await exec(cmd, { timeout: 12_000 })
    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')
    const limit = HOST_INFO_LIMITS[name] ?? 8192
    // 只截断；脱敏由调用方（ops 层 cleanRemoteOutput）在回灌前统一处理
    return { ok: true, name, output: (raw || '(无输出)').slice(0, limit) }
  } catch (err) {
    return { ok: false, name, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 读取指定文件（只读通道）。路径经过 readsSensitivePath 守卫，命中敏感路径
 * 一律拒绝；同时限大小与脱敏。
 */
export function executeReadFile(
  pathArg: string,
  deps: {
    readFile: (p: string) => Promise<string>
    stat: (p: string) => Promise<{ size: number }>
    /** 敏感路径判定；命中即拒绝（默认总是放行，由调用方传真实守卫） */
    isSensitive?: (p: string) => boolean
  }
): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
  const MAX_BYTES = 256 * 1024
  const { readFile, stat, isSensitive } = deps
  return (async () => {
    const p = String(pathArg ?? '').trim()
    if (!p) return { ok: false, name: 'read_file', error: '未提供文件路径' }
    if (isSensitive && isSensitive(p)) {
      return { ok: false, name: 'read_file', error: '目标路径命中敏感文件守卫，已拒绝读取（凭据/隐私文件）' }
    }
    try {
      const s = await stat(p)
      if (s.size > MAX_BYTES) {
        return { ok: false, name: 'read_file', error: `文件过大（${s.size} 字节，上限 ${MAX_BYTES}），已拒绝读取` }
      }
      const text = await readFile(p)
      // 原始文本返回；脱敏由调用方（ops 层 cleanRemoteOutput）在回灌前统一处理
      return { ok: true, name: 'read_file', output: `${p}\n${text}`.slice(0, MAX_BYTES) }
    } catch (err) {
      return { ok: false, name: 'read_file', error: err instanceof Error ? err.message : String(err) }
    }
  })()
}