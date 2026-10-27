import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AiConfig, HostProfile } from '@shared/types'
import { Vault } from './vault'

const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxTokens: 2048,
  autoApproveSafeCommands: false,
  autoApproveModifyCommands: false,
  autoSubmitCommandResults: false,
  contextLines: 60,
  maxContextTokens: 256 * 1024,
  searchEnabled: false
}

export const BAIDU_SEARCH_DAILY_LIMIT = 50
export const BAIDU_SEARCH_MONTHLY_LIMIT = 1500

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, content, { encoding: 'utf8' })
  fs.renameSync(tmp, file)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T
    }
  } catch (err) {
    console.error(`[store] 读取失败 ${file}`, err)
  }
  return fallback
}

export class Store {
  readonly vault: Vault
  private readonly profilesFile: string
  private readonly aiFile: string
  private readonly searchCounterFile: string
  private profiles: HostProfile[] = []
  private ai: AiConfig = { ...DEFAULT_AI_CONFIG }
  private searchDailyUses: { date: string; count: number } = { date: '', count: 0 }
  private searchMonthlyUses: { month: string; count: number } = { month: '', count: 0 }

  constructor(userDataDir = app.getPath('userData')) {
    fs.mkdirSync(userDataDir, { recursive: true })
    this.vault = new Vault(userDataDir)
    this.profilesFile = path.join(userDataDir, 'profiles.json')
    this.aiFile = path.join(userDataDir, 'ai.json')
    this.searchCounterFile = path.join(userDataDir, 'search-counter.json')
    this.profiles = readJson<HostProfile[]>(this.profilesFile, [])
    this.ai = { ...DEFAULT_AI_CONFIG, ...readJson<Partial<AiConfig>>(this.aiFile, {}) }
    const counter = readJson<{ daily?: { date: string; count: number }; monthly?: { month: string; count: number } }>(
      this.searchCounterFile,
      {}
    )
    this.searchDailyUses = counter.daily ?? { date: '', count: 0 }
    this.searchMonthlyUses = counter.monthly ?? { month: '', count: 0 }
    // 迁移/自愈：早期版本把 apiKeySecretKey 从 ai.json 里丢掉了，导致重启后
    // 无法定位保险库里的 API Key。若缺该名字但保险库默认键 ai:apiKey 仍存在，
    // 自动恢复，避免出现「明明配了 AI 却提示未配置」。
    if (!this.ai.apiKeySecretKey && this.vault.has('ai:apiKey')) {
      this.ai = { ...this.ai, apiKeySecretKey: 'ai:apiKey' }
      this.setAiConfig({ apiKeySecretKey: 'ai:apiKey' })
    }
  }

  // ---------------------------------------------------------------- profiles

  listProfiles(): HostProfile[] {
    return [...this.profiles].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  }

  getProfile(id: string): HostProfile | undefined {
    return this.profiles.find((p) => p.id === id)
  }

  createProfile(input: Partial<HostProfile> & { host: string; username: string }): HostProfile {
    const now = Date.now()
    const profile: HostProfile = {
      id: randomUUID(),
      label: input.label?.trim() || input.host,
      host: input.host.trim(),
      port: input.port ?? 22,
      username: input.username.trim(),
      authType: input.authType ?? 'password',
      privateKeyPath: input.privateKeyPath,
      knownHostFingerprints: input.knownHostFingerprints ?? [],
      defaultShell: input.defaultShell ?? true,
      defaultDirectory: input.defaultDirectory,
      notes: input.notes,
      tags: input.tags,
      createdAt: now,
      updatedAt: now
    }
    this.profiles.push(profile)
    this.saveProfiles()
    return profile
  }

  updateProfile(id: string, patch: Partial<HostProfile>): HostProfile {
    const profile = this.getProfile(id)
    if (!profile) throw new Error(`主机配置不存在: ${id}`)
    const next: HostProfile = { ...profile, ...patch, id: profile.id, updatedAt: Date.now() }
    // 空字符串不应把已有值清空
    const nextRecord = next as unknown as Record<string, unknown>
    const originalRecord = profile as unknown as Record<string, unknown>
    const patchRecord = patch as unknown as Record<string, unknown>
    for (const key of Object.keys(patch)) {
      if (patchRecord[key] === '' && originalRecord[key] !== undefined) {
        nextRecord[key] = originalRecord[key]
      }
    }
    this.profiles = this.profiles.map((p) => (p.id === id ? next : p))
    this.saveProfiles()
    return next
  }

  removeProfile(id: string): void {
    const profile = this.getProfile(id)
    if (profile) {
      if (profile.passwordSecretKey) this.vault.remove(profile.passwordSecretKey)
      if (profile.passphraseSecretKey) this.vault.remove(profile.passphraseSecretKey)
    }
    this.profiles = this.profiles.filter((p) => p.id !== id)
    this.saveProfiles()
  }

  /** 记住服务器主机密钥指纹 */
  addFingerprint(id: string, fingerprint: string): void {
    const profile = this.getProfile(id)
    if (!profile) return
    if (profile.knownHostFingerprints.includes(fingerprint)) return
    profile.knownHostFingerprints.push(fingerprint)
    profile.updatedAt = Date.now()
    this.saveProfiles()
  }

  private saveProfiles(): void {
    atomicWrite(this.profilesFile, JSON.stringify(this.profiles, null, 2))
  }

  // --------------------------------------------------------------------- AI

  getAiConfig(): AiConfig {
    return { ...this.ai }
  }

  setAiConfig(patch: Partial<AiConfig>): AiConfig {
    this.ai = { ...this.ai, ...patch }
    // apiKeySecretKey 只是保险库条目的「名字」，不是密钥明文本身，必须一起持久化，
    // 否则应用重启后找不到 API Key 落库的位置，getAiApiKey() 会返回 undefined，
    // 导致「明明配了 AI 却提示尚未配置 AI 服务」。
    atomicWrite(this.aiFile, JSON.stringify(this.ai, null, 2))
    return this.getAiConfig()
  }

  /** 写入 API Key 到保险库并记录键名 */
  async setAiApiKey(value: string | undefined): Promise<void> {
    if (value === undefined || value === '') {
      if (this.ai.apiKeySecretKey) this.vault.remove(this.ai.apiKeySecretKey)
      this.setAiConfig({ apiKeySecretKey: undefined })
      return
    }
    const key = this.ai.apiKeySecretKey ?? 'ai:apiKey'
    await this.vault.set(key, value)
    this.setAiConfig({ apiKeySecretKey: key })
  }

  async getAiApiKey(): Promise<string | undefined> {
    return this.ai.apiKeySecretKey ? this.vault.get(this.ai.apiKeySecretKey) : undefined
  }

  /** 写入百度搜索 API Key 到保险库并记录键名 */
  async setBaiduSearchKey(value: string | undefined): Promise<void> {
    if (value === undefined || value === '') {
      if (this.ai.baiduSearchKeySecretKey) this.vault.remove(this.ai.baiduSearchKeySecretKey)
      this.setAiConfig({ baiduSearchKeySecretKey: undefined })
      return
    }
    const key = this.ai.baiduSearchKeySecretKey ?? 'ai:baiduSearchKey'
    await this.vault.set(key, value)
    this.setAiConfig({ baiduSearchKeySecretKey: key })
  }

  async getBaiduSearchKey(): Promise<string | undefined> {
    return this.ai.baiduSearchKeySecretKey
      ? this.vault.get(this.ai.baiduSearchKeySecretKey)
      : undefined
  }

  /**
   * 查询百度搜索配额使用情况。
   * 免费额度按自然日/自然月累计，跨天后自动重置当日计数。
   * 返回 { 是否缺省，当日已用，当月已用 }，供界面按 50/日、1500/月 展示比例。
   */
  getSearchQuota(): { dailyUsed: number; monthlyUsed: number } {
    const daily = this.searchDailyUses
    const monthly = this.searchMonthlyUses
    const today = this.localDateKey()
    const month = this.localMonthKey()
    return {
      dailyUsed: daily.date === today ? daily.count : 0,
      monthlyUsed: monthly.month === month ? monthly.count : 0
    }
  }

  /** 记录一次百度搜索调用（成功后） */
  recordSearchUsage(): void {
    const today = this.localDateKey()
    const month = this.localMonthKey()
    if (this.searchDailyUses.date !== today) this.searchDailyUses = { date: today, count: 0 }
    if (this.searchMonthlyUses.month !== month) this.searchMonthlyUses = { month, count: 0 }
    this.searchDailyUses.count += 1
    this.searchMonthlyUses.count += 1
    this.persistSearchCounter()
  }

  private localDateKey(): string {
    const now = new Date()
    return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
  }

  private localMonthKey(): string {
    const now = new Date()
    return `${now.getFullYear()}-${now.getMonth() + 1}`
  }

  private persistSearchCounter(): void {
    atomicWrite(
      this.searchCounterFile,
      JSON.stringify({ daily: this.searchDailyUses, monthly: this.searchMonthlyUses }, null, 2)
    )
  }

  // ------------------------------------------------------------- 主机凭据

  async setProfileSecret(
    profileId: string,
    kind: 'password' | 'passphrase',
    value: string
  ): Promise<void> {
    const profile = this.getProfile(profileId)
    if (!profile) throw new Error(`主机配置不存在: ${profileId}`)
    const key = `${profileId}:${kind}`
    await this.vault.set(key, value)
    if (kind === 'password') profile.passwordSecretKey = key
    else profile.passphraseSecretKey = key
    profile.updatedAt = Date.now()
    this.saveProfiles()
  }

  async getProfileSecret(
    profileId: string,
    kind: 'password' | 'passphrase'
  ): Promise<string | undefined> {
    const profile = this.getProfile(profileId)
    if (!profile) return undefined
    const key = kind === 'password' ? profile.passwordSecretKey : profile.passphraseSecretKey
    return key ? this.vault.get(key) : undefined
  }
}
