import fs from 'node:fs'
import path from 'node:path'
import type { SFTPWrapper } from 'ssh2'

/**
 * WSL 伪 SFTP 后端。
 *
 * 通过 `\\wsl$\<distro>\` 把 WSL 的 Linux 文件系统当作本地路径访问，
 * 对外暴露与 ssh2 SFTPWrapper 相同的方法签名，从而让现有的
 * transfer.ts / sftp IPC 通道 / TransferPane 无需改动即可直接复用。
 *
 * 注意：Windows 下 Node 的 stat.mode 已按 POSIX 语义给出一套
 * 文件类型位（S_IFDIR / S_IFREG 等），transfer 的 fileTypeFromMode
 * 可据此正确区分文件/目录。
 */

/** 将 Linux 绝对路径映射为 \\wsl$\<distro> 的 Windows 路径 */
export function wslLinuxToWindows(distro: string, linuxPath: string): string {
  const cleaned = String(linuxPath || '').replace(/^\//, '')
  // 使用 win32 语义拼接 UNC，避免 posix 分隔符混入
  const win = `\\\\wsl$\\${distro}` + path.win32.sep + cleaned.split('/').filter(Boolean).join(path.win32.sep)
  return win
}

/** 由 Windows 文件 handle（fd）构造 transfer 需要的 attrs（mode/size/mtime） */
function toSftpAttrs(st: fs.Stats): {
  mode: number
  size: number
  mtime: number
  atime: number
} {
  return {
    mode: st.mode,
    size: st.size,
    mtime: Math.floor(st.mtimeMs / 1000),
    atime: Math.floor(st.atimeMs / 1000)
  }
}

export class WslSftp {
  constructor(private readonly distro: string) {}

  private toWin(p: string): string {
    return wslLinuxToWindows(this.distro, p)
  }

  /**
   * 构造一个兼容 ssh2.SFTPWrapper 的对象（结构兼容，运行时可被
   * transfer.ts 当作 SFTPWrapper 使用）。
   */
  asSftp(): SFTPWrapper {
    const s = this
    // 仅实现现有 transfer.ts / ipc 使用到的回调方法
    return {
      readdir(dir: string, cb: (err: Error | undefined, list?: unknown) => void): void {
        try {
          const winDir = s.toWin(dir)
          const entries = fs.readdirSync(winDir, { withFileTypes: true })
          const list = entries.map((e) => {
            const full = path.join(winDir, e.name)
            let attrs: ReturnType<typeof toSftpAttrs>
            try {
              // 用 lstat 检测符号链接，避免 Windows 无法解析 Linux 符号链接时报错；
              // 符号链接仍保留 POSIX 类型位，使 transfer 能识别并安全跳过。
              const st = fs.lstatSync(full)
              const mapped = { ...st } as fs.Stats
              if (st.isSymbolicLink()) {
                mapped.mode = 0o120000 // S_IFLNK
              }
              attrs = toSftpAttrs(mapped)
            } catch {
              attrs = { mode: 0, size: 0, mtime: 0, atime: 0 }
            }
            return { filename: e.name, attrs }
          })
          cb(undefined, list)
        } catch (err) {
          cb(err as Error)
        }
      },
      stat(target: string, cb: (err: Error | undefined, attrs?: unknown) => void): void {
        try {
          cb(undefined, toSftpAttrs(fs.statSync(s.toWin(target))))
        } catch (err) {
          cb(err as Error)
        }
      },
      open(
        target: string,
        mode: 'r' | 'w' | string,
        cb: (err: Error | undefined, handle?: Buffer) => void
      ): void {
        try {
          const fd = fs.openSync(s.toWin(target), mode === 'w' ? 'w' : 'r')
          cb(undefined, Buffer.from(String(fd)))
        } catch (err) {
          cb(err as Error)
        }
      },
      close(handle: Buffer, cb: (err?: Error) => void): void {
        try {
          fs.closeSync(Number(handle.toString()))
          cb()
        } catch (err) {
          cb(err as Error)
        }
      },
      fstat(handle: Buffer, cb: (err: Error | undefined, attrs?: unknown) => void): void {
        try {
          cb(undefined, toSftpAttrs(fs.fstatSync(Number(handle.toString()))))
        } catch (err) {
          cb(err as Error)
        }
      },
      write(
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        cb: (err?: Error, bytesWritten?: number) => void
      ): void {
        try {
          const n = fs.writeSync(Number(handle.toString()), buffer, offset, length, position)
          cb(undefined, n)
        } catch (err) {
          cb(err as Error)
        }
      },
      read(
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        cb: (err?: Error, bytesRead?: number) => void
      ): void {
        try {
          const n = fs.readSync(Number(handle.toString()), buffer, offset, length, position)
          cb(undefined, n)
        } catch (err) {
          cb(err as Error)
        }
      },
      mkdir(target: string, cb: (err: Error | undefined) => void): void {
        try {
          fs.mkdirSync(s.toWin(target), { recursive: true })
          cb(undefined)
        } catch (err) {
          cb(err as Error)
        }
      },
      chmod(_target: string, _perm: number, cb?: (err?: Error) => void): void {
        // Windows 本地文件系统没有 POSIX 权限位，chmod 为空操作
        if (cb) cb(undefined)
      },
      on(_event: string, _listener: (...args: never[]) => void): WslSftp {
        return s
      }
    } as unknown as SFTPWrapper
  }
}