import { Server } from 'ssh2'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 用于自动化测试的本地 SSH 服务端
 * 支持：口令认证、exec、交互式 shell、SFTP（读写、列目录、创建目录）
 */

const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  OP_UNSUPPORTED: 8
}

export interface FakeServerOptions {
  root: string
  port?: number
  username?: string
  password?: string
}

export interface FakeServer {
  port: number
  close: () => Promise<void>
  /** 记录收到的 exec 命令 */
  execLog: string[]
}

function hostKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  return privateKey
}

export async function startFakeSshServer(options: FakeServerOptions): Promise<FakeServer> {
  const { root } = options
  const username = options.username ?? 'tester'
  const password = options.password ?? 's3cret'
  fs.mkdirSync(root, { recursive: true })

  const execLog: string[] = []

  const resolveRemote = (p: string): string => {
    if (!p || p === '.' || p === '~') return root
    const normalized = p.replace(/\\/g, '/')
    if (normalized.startsWith('~')) return path.join(root, normalized.slice(1))
    if (normalized.startsWith('/')) return path.join(root, normalized.replace(/^\/+/, ''))
    return path.join(root, normalized)
  }

  const toAttrs = (stat: fs.Stats): Record<string, number> => ({
    mode: stat.mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000)
  })

  const server = new Server({ hostKeys: [hostKeyPem()] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        ctx.accept()
      } else if (ctx.method === 'none') {
        ctx.reject(['password'], false)
      } else {
        ctx.reject()
      }
    })

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()

        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept) => accept?.())
        session.on('env', (accept) => accept?.())

        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          const command = info.command
          execLog.push(command)

          if (command.includes('uname')) {
            stream.write('Linux fakehost 6.1.0-test x86_64 GNU/Linux\n')
          } else if (command.includes('sleep-forever')) {
            // 永不结束的进程，用于测试超时中断
            return
          } else if (command.includes('cat /etc/os-release')) {
            stream.write('NAME="Fake Linux"\nID=linux\nVERSION_ID="1.0"\n')
          } else if (command.includes('$HOME')) {
            // 模拟 printf %s "$HOME"
            stream.write(`${root}\n`)
          } else if (command.includes('pwd')) {
            stream.write('/home/tester\n')
          } else if (command.startsWith('echo ')) {
            stream.write(`${command.slice(5)}\n`)
          } else if (command.includes('progress-test')) {
            // 分时分段输出，用于测试长时命令的实时进度回传
            stream.write('step-1\n')
            setTimeout(() => {
              stream.write('step-2\n')
              setTimeout(() => {
                stream.write('step-3\n')
                stream.exit(0)
                stream.end()
              }, 50)
            }, 50)
            return
          } else if (command.includes('run-forever')) {
            // 持续输出且永不结束，用于测试「停止执行」(类似 Ctrl+C)
            const timer = setInterval(() => stream.write(`tick ${Date.now()}\n`), 40)
            stream.on('close', () => clearInterval(timer))
            return
          } else if (command.includes('exit-code-42')) {
            stream.stderr.write('boom\n')
            stream.exit(42)
          } else if (command.includes('/proc/meminfo')) {
            // 模拟 SystemUsageMonitor 的 CPU / 内存探测命令返回
            stream.write('mem=25202630/33023904\n')
            stream.write('cpu=820/2000\n')
            stream.exit(0)
            stream.end()
            return
          } else {
            stream.write(`executed: ${command}\n`)
          }
          stream.exit(0)
          stream.end()
        })

        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('fake-shell$ ')
          stream.on('data', (data: Buffer) => {
            const text = data.toString('utf8')
            if (text.includes('exit')) {
              stream.exit(0)
              stream.end()
              return
            }
            stream.write(`echo:${text.trim()}\r\n`)
            stream.write('fake-shell$ ')
          })
        })

        session.on('sftp', (accept) => {
          const sftp = accept()
          const handles = new Map<string, { file: string; dir?: boolean; listing?: string[] }>()
          let handleSeq = 0
          const newHandle = (entry: { file: string; dir?: boolean; listing?: string[] }): Buffer => {
            const id = String(++handleSeq)
            handles.set(id, entry)
            return Buffer.from(id)
          }
          const getHandle = (h: Buffer): { file: string; dir?: boolean; listing?: string[] } | undefined =>
            handles.get(h.toString('utf8'))

          sftp.on('REALPATH', (reqid, p) => {
            const target = resolveRemote(p)
            sftp.name(reqid, [
              {
                filename: p === '/' ? '/' : p,
                longname: p,
                attrs: { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }
              }
            ])
            void target
          })

          sftp.on('STAT', (reqid, p) => {
            try {
              sftp.attrs(reqid, toAttrs(fs.statSync(resolveRemote(p))))
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE)
            }
          })

          sftp.on('LSTAT', (reqid, p) => {
            try {
              sftp.attrs(reqid, toAttrs(fs.lstatSync(resolveRemote(p))))
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE)
            }
          })

          sftp.on('FSTAT', (reqid, h) => {
            const entry = getHandle(h)
            if (!entry) return sftp.status(reqid, STATUS.FAILURE)
            try {
              sftp.attrs(reqid, toAttrs(fs.statSync(entry.file)))
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })

          sftp.on('OPENDIR', (reqid, p) => {
            try {
              const target = resolveRemote(p)
              const listing = fs.readdirSync(target)
              sftp.handle(reqid, newHandle({ file: target, dir: true, listing }))
            } catch {
              sftp.status(reqid, STATUS.NO_SUCH_FILE)
            }
          })

          sftp.on('READDIR', (reqid, h) => {
            const entry = getHandle(h)
            if (!entry || !entry.listing) return sftp.status(reqid, STATUS.FAILURE)
            if (entry.listing.length === 0) return sftp.status(reqid, STATUS.EOF)
            const names = entry.listing.map((name) => {
              const stat = fs.statSync(path.join(entry.file, name))
              return {
                filename: name,
                longname: `${name}`,
                attrs: toAttrs(stat)
              }
            })
            entry.listing = []
            sftp.name(reqid, names)
          })

          sftp.on('OPEN', (reqid, filename, flags) => {
            const target = resolveRemote(filename)
            // flags: 0x1 read, 0x2 write, 0x4 append, 0x8 create, 0x10 truncate
            const wantsWrite = (flags & 0x2) !== 0 || (flags & 0x4) !== 0
            const wantsCreate = (flags & 0x8) !== 0
            const wantsTruncate = (flags & 0x10) !== 0
            try {
              if (wantsWrite) {
                if (wantsCreate) {
                  fs.writeFileSync(target, '')
                } else if (wantsTruncate) {
                  fs.writeFileSync(target, '')
                } else if (!fs.existsSync(target)) {
                  return sftp.status(reqid, STATUS.NO_SUCH_FILE)
                }
              } else if (!fs.existsSync(target)) {
                return sftp.status(reqid, STATUS.NO_SUCH_FILE)
              }
              sftp.handle(reqid, newHandle({ file: target }))
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })

          sftp.on('READ', (reqid, h, offset, len) => {
            const entry = getHandle(h)
            if (!entry) return sftp.status(reqid, STATUS.FAILURE)
            try {
              const fd = fs.openSync(entry.file, 'r')
              const buffer = Buffer.alloc(len)
              const bytesRead = fs.readSync(fd, buffer, 0, len, Number(offset))
              fs.closeSync(fd)
              if (bytesRead <= 0) return sftp.status(reqid, STATUS.EOF)
              sftp.data(reqid, buffer.subarray(0, bytesRead))
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })

          sftp.on('WRITE', (reqid, h, offset, data) => {
            const entry = getHandle(h)
            if (!entry) return sftp.status(reqid, STATUS.FAILURE)
            try {
              const fd = fs.openSync(entry.file, 'r+')
              fs.writeSync(fd, data, 0, data.length, Number(offset))
              fs.closeSync(fd)
              sftp.status(reqid, STATUS.OK)
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })

          sftp.on('CLOSE', (reqid, h) => {
            handles.delete(h.toString('utf8'))
            sftp.status(reqid, STATUS.OK)
          })

          sftp.on('MKDIR', (reqid, p) => {
            try {
              fs.mkdirSync(resolveRemote(p), { recursive: true })
              sftp.status(reqid, STATUS.OK)
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })

          sftp.on('REMOVE', (reqid, p) => {
            try {
              fs.unlinkSync(resolveRemote(p))
              sftp.status(reqid, STATUS.OK)
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })

          sftp.on('RMDIR', (reqid, p) => {
            try {
              fs.rmdirSync(resolveRemote(p))
              sftp.status(reqid, STATUS.OK)
            } catch {
              sftp.status(reqid, STATUS.FAILURE)
            }
          })
        })
      })
    })

    client.on('error', () => undefined)
  })

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }

  return {
    port: address.port,
    execLog,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
