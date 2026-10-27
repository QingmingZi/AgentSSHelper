import { safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { hostname, platform, userInfo } from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 凭据保险库
 *
 * 首选方案：Electron safeStorage（异步 API）
 *   - Windows  -> DPAPI（当前用户 + 机器绑定）
 *   - macOS    -> Keychain
 *   - Linux    -> libsecret / kwallet
 *   密钥材料由操作系统密钥库托管，应用无法读取原始密钥。
 *
 * 降级方案：safeStorage 不可用时（常见于无桌面会话的 Linux）
 *   用 scrypt 派生出本地主密钥，材料为随机盐 + 机器/用户指纹，保存在 userData 下。
 *   强度弱于系统密钥库，界面会给出提示。
 */

interface Envelope {
  alg: 'safe' | 'local'
  /** alg=safe 时为 safeStorage.encryptStringAsync 的密文 */
  data: string
  /** alg=local 时为 GCM 参数 */
  iv?: string
  tag?: string
}

interface LocalMaterial {
  salt: string
  secret: string
}

const ALGO = 'aes-256-gcm'

export class Vault {
  private readonly file: string
  private readonly materialFile: string
  private envelopes: Record<string, Envelope> = {}
  private material: LocalMaterial | null = null
  private warned = false
  /** 缓存系统密钥库可用性，避免每次读写都探测 */
  private systemAvailable: boolean | null = null

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'secrets.json')
    this.materialFile = path.join(userDataDir, '.vault-material')
    this.load()
  }

  /**
   * 系统密钥库是否真正提供加密。
   * Linux 上 safeStorage 可能退化为 basic_text（等价明文），这种情况同样视为不可用。
   */
  async isSystemKeychainAvailable(): Promise<boolean> {
    if (this.systemAvailable !== null) return this.systemAvailable
    let available = false
    try {
      if (await safeStorage.isAsyncEncryptionAvailable()) {
        let backend = ''
        try {
          backend = safeStorage.getSelectedStorageBackend()
        } catch {
          backend = ''
        }
        available = backend !== 'basic_text'
      }
    } catch {
      available = false
    }
    this.systemAvailable = available
    return available
  }

  /** 实际生效的加密后端描述，用于 UI 展示 */
  async backend(): Promise<'system' | 'local-fallback'> {
    return (await this.isSystemKeychainAvailable()) ? 'system' : 'local-fallback'
  }

  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as {
          items?: Record<string, Envelope>
        }
        this.envelopes = raw.items ?? {}
      }
    } catch {
      this.envelopes = {}
    }
  }

  private persist(): void {
    const payload = { version: 1, items: this.envelopes }
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  private getLocalMaterial(): LocalMaterial {
    if (this.material) return this.material
    if (fs.existsSync(this.materialFile)) {
      const parsed = JSON.parse(fs.readFileSync(this.materialFile, 'utf8')) as LocalMaterial
      this.material = parsed
      return parsed
    }
    const material: LocalMaterial = {
      salt: randomBytes(16).toString('hex'),
      secret: randomBytes(32).toString('hex')
    }
    fs.writeFileSync(this.materialFile, JSON.stringify(material), { encoding: 'utf8', mode: 0o600 })
    this.material = material
    return material
  }

  private localKey(): Buffer {
    const { salt, secret } = this.getLocalMaterial()
    const info = userInfo()
    const fingerprint = [hostname(), platform(), info.username, secret].join('|')
    return scryptSync(fingerprint, salt, 32)
  }

  private encryptLocal(plain: string): Envelope {
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGO, this.localKey(), iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return {
      alg: 'local',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: enc.toString('base64')
    }
  }

  private decryptLocal(env: Envelope): string {
    const decipher = createDecipheriv(ALGO, this.localKey(), Buffer.from(env.iv!, 'base64'))
    decipher.setAuthTag(Buffer.from(env.tag!, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString(
      'utf8'
    )
  }

  async set(key: string, value: string): Promise<void> {
    if (!value) {
      this.remove(key)
      return
    }
    let env: Envelope
    if (await this.isSystemKeychainAvailable()) {
      env = { alg: 'safe', data: (await safeStorage.encryptStringAsync(value)).toString('base64') }
    } else {
      env = this.encryptLocal(value)
      if (!this.warned) {
        this.warned = true
        console.warn('[vault] 系统密钥库不可用，已降级为本地派生密钥加密（强度较弱）')
      }
    }
    this.envelopes[key] = env
    this.persist()
  }

  async get(key: string): Promise<string | undefined> {
    const env = this.envelopes[key]
    if (!env) return undefined
    try {
      if (env.alg === 'safe') {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(env.data, 'base64'))
        // 密钥发生轮换时，用新密钥重新加密并回写
        if (decrypted.shouldReEncrypt) {
          try {
            const fresh = await safeStorage.encryptStringAsync(decrypted.result)
            env.data = fresh.toString('base64')
            this.persist()
          } catch (err) {
            console.error('[vault] 重新加密失败', err)
          }
        }
        return decrypted.result
      }
      return this.decryptLocal(env)
    } catch (err) {
      console.error(`[vault] 解密失败: ${key}`, err)
      return undefined
    }
  }

  /** 只判断是否存在，不触发解密，可保持同步 */
  has(key: string): boolean {
    return Boolean(this.envelopes[key])
  }

  remove(key: string): void {
    if (this.envelopes[key]) {
      delete this.envelopes[key]
      this.persist()
    }
  }

  /** 脱敏展示，例如 sk-abcd••••wxyz */
  async preview(key: string): Promise<string> {
    const value = await this.get(key)
    if (!value) return ''
    if (value.length <= 10) return '••••••'
    return `${value.slice(0, 6)}••••${value.slice(-4)}`
  }
}
