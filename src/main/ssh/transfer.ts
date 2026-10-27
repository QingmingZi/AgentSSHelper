import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { OpenMode, SFTPWrapper, Stats } from 'ssh2'
import type { RemoteFileEntry } from '@shared/types'

const CHUNK_SIZE = 64 * 1024

/** POSIX 文件类型掩码 */
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

/** 由 mode 判定文件类型（不能用 & 0o120000 判断符号链接，会与普通文件重叠） */
export function fileTypeFromMode(mode: number): RemoteFileEntry['type'] {
  const fmt = mode & S_IFMT
  if (fmt === S_IFLNK) return 'symlink'
  if (fmt === S_IFDIR) return 'directory'
  if (fmt === S_IFREG) return 'file'
  return 'other'
}

export interface TransferProgress {
  taskId: string
  sessionId: string
  direction: 'upload' | 'download'
  source: string
  target: string
  transferredBytes: number
  totalBytes: number
  currentFile?: string
}

export type ProgressCallback = (progress: TransferProgress) => void

/** 远程目录列表 */
export async function listRemoteDir(sftp: SFTPWrapper, dir: string): Promise<RemoteFileEntry[]> {
  const raw = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
    sftp.readdir(dir, (err, list) => {
      if (err) reject(new Error(formatSftpError(err, dir)))
      else resolve((list ?? []) as Array<{ filename: string; attrs: Stats }>)
    })
  })

  return raw
    .map((item) => {
      const mode = item.attrs.mode ?? 0
      return {
        name: item.filename,
        // 注意：不能先剥掉目录尾部斜杠，否则根目录 '/' 会变成 ''，
        // 导致拼出 'opt' 这样的相对路径，远程端会报 No such file
        path: path.posix.join(dir, item.filename),
        type: fileTypeFromMode(mode),
        size: item.attrs.size ?? 0,
        mode,
        mtime: (item.attrs.mtime ?? 0) * 1000
      }
    })
    .sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1
      if (a.type !== 'directory' && b.type === 'directory') return 1
      return a.name.localeCompare(b.name)
    })
}

export async function statRemote(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<RemoteFileEntry | null> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, attrs) => {
      if (err || !attrs) return resolve(null)
      const mode = attrs.mode ?? 0
      resolve({
        name: path.posix.basename(remotePath),
        path: remotePath,
        type: fileTypeFromMode(mode),
        size: attrs.size ?? 0,
        mode,
        mtime: (attrs.mtime ?? 0) * 1000
      })
    })
  })
}

/** 在线编辑允许读取的远端文本文件大小上限（字节） */
export const MAX_EDIT_TEXT_BYTES = 8 * 1024 * 1024 // 8MB

/**
 * 读取远端文本文件内容为 UTF-8 字符串（流式读取，限制大小防止大文件撑爆内存）。
 * 返回 { content, size }；文件超过上限时抛出错误，提示改用下载方式。
 */
export async function readRemoteText(
  sftp: SFTPWrapper,
  remotePath: string
): Promise<{ content: string; size: number }> {
  const handle = await openRemote(sftp, remotePath, 'r')
  try {
    const stats = await fstatRemote(sftp, handle)
    const total = stats.size ?? 0
    if (total > MAX_EDIT_TEXT_BYTES) {
      throw new Error(`文件过大（${total} 字节），超过在线编辑上限 ${MAX_EDIT_TEXT_BYTES} 字节，请改用下载方式`)
    }
    const chunks: Buffer[] = []
    let position = 0
    while (position < total) {
      // 每次读入一块独立的 buffer：不能复用同一块再 subarray，
      // 否则所有 chunk 都是同一底层 ArrayBuffer 的视图，最终 concat 会拿到被
      // 最后一块覆盖的内容（大文件读出来会是重复/错乱，甚至看起来像逆序）。
      const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
      const bytesRead = await readRemote(sftp, handle, buffer, position)
      if (bytesRead <= 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    // 优先按 UTF-8 解码；带 BOM 时自动剥离
    let content = Buffer.concat(chunks).toString('utf8')
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
    return { content, size: total }
  } finally {
    await closeRemote(sftp, handle)
  }
}

/** 将文本内容写回远端文件（UTF-8；保留原始换行风格，统一按服务器端写入） */
export async function writeRemoteText(
  sftp: SFTPWrapper,
  remotePath: string,
  content: string
): Promise<void> {
  // 先读取现有文件以保留其 POSIX 权限位
  const existing = await statRemote(sftp, remotePath)
  const handle = await openRemote(sftp, remotePath, 'w')
  try {
    const data = Buffer.from(content, 'utf8')
    const chunkSize = CHUNK_SIZE
    let position = 0
    while (position < data.length) {
      const chunk = data.subarray(position, position + chunkSize)
      await writeRemote(sftp, handle, chunk, position)
      position += chunk.length
    }
  } finally {
    await closeRemote(sftp, handle)
  }
  // 回写权限位（open 'w' 可能重置权限；只取 setuid/setgid/sticky/rwx，
  // 屏蔽文件类型位 S_IFMT，因为 chmod 只接受权限位）
  if (existing && existing.mode) {
    const perm = existing.mode & 0o7777
    await new Promise<void>((resolve) => {
      sftp.chmod(remotePath, perm, () => resolve())
    })
  }
}

function openRemote(
  sftp: SFTPWrapper,
  remotePath: string,
  mode: OpenMode
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, mode, (err, handle) => {
      if (err) reject(new Error(formatSftpError(err, remotePath)))
      else resolve(handle)
    })
  })
}

function closeRemote(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    sftp.close(handle, () => resolve())
  })
}

function writeRemote(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  position: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, 0, buffer.length, position, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function readRemote(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, 0, buffer.length, position, (err, bytesRead) => {
      if (err) reject(err)
      else resolve(bytesRead ?? 0)
    })
  })
}

function fstatRemote(sftp: SFTPWrapper, handle: Buffer): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (err, stats) => {
      if (err) reject(err)
      else resolve(stats)
    })
  })
}

async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  await new Promise<void>((resolve) => {
    sftp.mkdir(dir, () => resolve())
  })
}

/**
 * 上传单个文件（流式写入，支持进度上报与取消）
 */
export async function uploadFile(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  taskId: string,
  sessionId: string,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  overwrite = true
): Promise<void> {
  const stat = fs.statSync(localPath)
  const total = stat.size

  if (!overwrite) {
    const existing = await statRemote(sftp, remotePath)
    if (existing) throw new Error(`目标已存在：${remotePath}`)
  }

  const handle = await openRemote(sftp, remotePath, 'w')
  const fd = fs.openSync(localPath, 'r')
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  let position = 0

  try {
    while (position < total) {
      if (signal?.aborted) throw new Error('传输已取消')
      const bytesRead = fs.readSync(fd, buffer, 0, Math.min(CHUNK_SIZE, total - position), position)
      if (bytesRead <= 0) break
      const chunk = buffer.subarray(0, bytesRead)
      await writeRemote(sftp, handle, chunk, position)
      position += bytesRead
      onProgress({
        taskId,
        sessionId,
        direction: 'upload',
        source: localPath,
        target: remotePath,
        transferredBytes: position,
        totalBytes: total,
        currentFile: path.basename(localPath)
      })
    }
  } catch (err) {
    await closeRemote(sftp, handle)
    fs.closeSync(fd)
    throw err
  }

  fs.closeSync(fd)
  await closeRemote(sftp, handle)
}

/**
 * 下载单个文件（流式读取，支持进度上报与取消）
 */
export async function downloadFile(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  taskId: string,
  sessionId: string,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  overwrite = true
): Promise<void> {
  if (!overwrite && fs.existsSync(localPath)) {
    throw new Error(`本地文件已存在：${localPath}`)
  }

  const handle = await openRemote(sftp, remotePath, 'r')
  const remoteStat = await fstatRemote(sftp, handle)
  const total = remoteStat.size ?? 0

  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  const fd = fs.openSync(localPath, 'w')
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
  let position = 0

  try {
    while (position < total) {
      if (signal?.aborted) throw new Error('传输已取消')
      const bytesRead = await readRemote(sftp, handle, buffer, position)
      if (bytesRead <= 0) break
      fs.writeSync(fd, buffer, 0, bytesRead)
      position += bytesRead
      onProgress({
        taskId,
        sessionId,
        direction: 'download',
        source: remotePath,
        target: localPath,
        transferredBytes: position,
        totalBytes: total,
        currentFile: path.basename(remotePath)
      })
    }
  } catch (err) {
    await closeRemote(sftp, handle)
    fs.closeSync(fd)
    throw err
  }

  fs.closeSync(fd)
  await closeRemote(sftp, handle)
}

/** 递归上传目录 */
export async function uploadDirectory(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  taskId: string,
  sessionId: string,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  overwrite = true
): Promise<void> {
  await ensureRemoteDir(sftp, remoteDir)
  const entries = fs.readdirSync(localDir, { withFileTypes: true })
  for (const entry of entries) {
    if (signal?.aborted) throw new Error('传输已取消')
    const localChild = path.join(localDir, entry.name)
    const remoteChild = path.posix.join(remoteDir, entry.name)
    if (entry.isDirectory()) {
      await uploadDirectory(sftp, localChild, remoteChild, taskId, sessionId, onProgress, signal, overwrite)
    } else if (entry.isFile()) {
      await uploadFile(sftp, localChild, remoteChild, taskId, sessionId, onProgress, signal, overwrite)
    }
  }
}

/** 递归下载目录 */
export async function downloadDirectory(
  sftp: SFTPWrapper,
  remoteDir: string,
  localDir: string,
  taskId: string,
  sessionId: string,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
  overwrite = true
): Promise<void> {
  fs.mkdirSync(localDir, { recursive: true })
  const entries = await listRemoteDir(sftp, remoteDir)
  for (const entry of entries) {
    if (signal?.aborted) throw new Error('传输已取消')
    const localChild = path.join(localDir, entry.name)
    if (entry.type === 'directory') {
      await downloadDirectory(sftp, entry.path, localChild, taskId, sessionId, onProgress, signal, overwrite)
    } else if (entry.type === 'file') {
      if (!overwrite && fs.existsSync(localChild)) continue
      await downloadFile(sftp, entry.path, localChild, taskId, sessionId, onProgress, signal, overwrite)
    }
  }
}

export interface NativeScpOptions {
  host: string
  port: number
  username: string
  privateKeyPath?: string
  passphrase?: string
  strictHostKeyChecking?: 'yes' | 'accept-new' | 'no'
}

/**
 * 调用系统 OpenSSH 的 scp 命令传输。
 * 注意：OpenSSH scp 无法通过标准输入安全地传递口令，因此仅支持私钥/agent 认证。
 */
export function runNativeScp(
  options: NativeScpOptions & {
    direction: 'upload' | 'download'
    source: string
    target: string
    recursive?: boolean
    signal?: AbortSignal
    onOutput?: (chunk: string) => void
  }
): Promise<{ code: number | null; stderr: string }> {
  const args: string[] = ['-P', String(options.port)]
  if (options.recursive) args.push('-r')
  if (options.privateKeyPath) args.push('-i', options.privateKeyPath)
  args.push('-o', 'StrictHostKeyChecking=' + (options.strictHostKeyChecking ?? 'accept-new'))
  args.push('-o', 'BatchMode=yes')

  const remoteSpec = `${options.username}@${options.host}`
  if (options.direction === 'upload') {
    args.push(options.source, `${remoteSpec}:${options.target}`)
  } else {
    args.push(`${remoteSpec}:${options.source}`, options.target)
  }

  return new Promise((resolve, reject) => {
    const child = spawn('scp', args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      stderr += text
      options.onOutput?.(text)
    })
    child.stdout.on('data', (d: Buffer) => options.onOutput?.(d.toString('utf8')))
    const onAbort = (): void => {
      child.kill()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort)
      reject(new Error(`无法启动系统 scp：${err.message}（请确认已安装 OpenSSH 客户端）`))
    })
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stderr })
    })
  })
}

export function formatSftpError(err: Error & { code?: string }, target: string): string {
  const code = err.code ?? ''
  const map: Record<string, string> = {
    ENOENT: '远程路径不存在',
    EACCES: '权限不足',
    EEXIST: '目标已存在',
    EPERM: '操作不被允许',
    ENOTDIR: '路径不是目录'
  }
  const reason = map[code] ?? err.message
  return `${reason}：${target}`
}

/** 传输任务登记处：用于取消与进度广播 */
export class TransferRegistry {
  private controllers = new Map<string, AbortController>()

  create(taskId: string): AbortController {
    const controller = new AbortController()
    this.controllers.set(taskId, controller)
    return controller
  }

  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(taskId)
    return true
  }

  release(taskId: string): void {
    this.controllers.delete(taskId)
  }
}
