import { execFileSync, spawnSync } from 'node:child_process'

/**
 * WSL 发行版信息
 */
export interface WslDistro {
  /** 发行版名，如 Ubuntu-24.04（用于 wsl.exe -d <name>） */
  name: string
  /** 是否为默认发行版 */
  isDefault: boolean
  /** 运行状态 */
  state: string
  /** WSL 版本（1 或 2） */
  version: string
  /** 标记为不可用（如 WSL 未安装或命令不可用） */
  unavailable?: boolean
}

/**
 * 探测本机是否有可用的 WSL 环境（wsl.exe 可执行）。
 */
export function isWslAvailable(): boolean {
  try {
    execFileSync('wsl.exe', ['--status'], { stdio: 'pipe', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * 解析 wsl.exe -l -v 的表格输出。
 * 输出常为 UTF-16LE 编码，需先转码；表格列为 NAME / STATE / VERSION，默认发行版带 `*`。
 */
function decodeWslBuffer(buf: Buffer): string {
  // 1) 显式 UTF-16LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '')
  }
  // 2) 启发式：若 null 字节占比高（每 2 字节 1 个，ASCII 内容放宽到每 4 字节至少 1 个），视为 UTF-16LE
  let nullCount = 0
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x00) nullCount++
  if (buf.length > 4 && nullCount / buf.length > 0.2) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '')
  }
  // 3) 常规 UTF-8 / 本地字节
  return buf.toString('utf8')
}

/**
 * 枚举本机已安装的 WSL 发行版。
 * 不使用 `-l --format=csv`（部分版本 WSL 不支持），改为解析 `-l -v` 表格。
 */
export function listWslDistros(): WslDistro[] {
  try {
    const res = execFileSync('wsl.exe', ['-l', '-v'], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    const text = decodeWslBuffer(res)
    return parseWslList(text)
  } catch {
    return []
  }
}

/** 解析 wsl.exe -l -v 的文本输出为结构化发行版列表 */
export function parseWslList(text: string): WslDistro[] {
  const lines = text.split(/\r?\n/)
  const out: WslDistro[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    // 表头或空行跳过
    if (!trimmed || /^NAME\s+STATE\s+VERSION/i.test(trimmed)) continue
    // 去掉前导的默认标记 *
    const isDefault = trimmed.startsWith('*')
    const body = isDefault ? trimmed.slice(1).trim() : trimmed
    // 以两个及以上连续空格切分列（发行版名、状态、版本）
    const parts = body.split(/\s{2,}|[\t]+/)
    if (parts.length < 1 || !parts[0]) continue
    out.push({
      name: parts[0].trim(),
      isDefault,
      state: (parts[1] ?? '').trim() || 'Stopped',
      version: (parts[2] ?? '').trim() || '2'
    })
  }
  return out
}

/** 解析时仍可能被 MSVC/本地化的表头干扰，返回原始列表或空 */
export function getWslRootFsPath(distro: string): string {
  // \\wsl$\<distro> 挂载点
  return `\\\\wsl$\\${distro}`
}

/** 运行一条 WSL 命令并返回输出（供 exec 复用） */
export function runWslExec(
  distro: string,
  command: string,
  opts: { timeoutMs?: number } = {}
): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync('wsl.exe', ['-d', distro, '--', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeoutMs ?? 60_000,
    env: process.env
  })
  return {
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? ''
  }
}