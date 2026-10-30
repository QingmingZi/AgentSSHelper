/**
 * 对话 + 命令历史持久化（按主机/Profile 稳定键保留）。
 *
 * 目标（用户需求：增加命令历史 和 AI 运维对话保留）：
 *  - 保留 3 天内的对话与命令历史，超过 3 天自动清理；
 *  - 打开应用后按 Profile 自动加载已保留的历史；
 *  - 以 profileId 为键，而非会话 sessionId —— sessionId 是每次连接临时生成的，
 *    重启 / 重连后变化，唯 profileId（主机身份）稳定，才能跨重启恢复。
 *
 * 采用 Single-File JSON（atomicWrite 原子落盘）：
 *  - conversations: 每主机保留的对话消息（模型实际用于多轮上下文的历史）；
 *  - commandHistory: 每主机保留的命令执行记录（命令历史审计）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AttackMatch, CommandResult, CommandRisk, ProposedCommand, RiskKind } from '@shared/types'

/** 保留窗口：3 天（毫秒） */
export const CONVERSATION_RETENTION_MS = 3 * 24 * 60 * 60 * 1000

/** 单个对话消息（与 AiOpsService 历史同一形状，便于序列化） */
export interface PersistedMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 单主机的对话记录 */
export interface PersistedConversation {
  profileKey: string
  /** 最近一次写入时间戳（毫秒），用于 3 天过期清理 */
  updatedAt: number
  messages: PersistedMessage[]
}

/** 单主机的命令历史条目 */
export interface PersistedCommandEntry {
  commandId: string
  messageId: string
  command: string
  risk: CommandRisk
  riskKind?: RiskKind
  attacks?: AttackMatch[]
  /** done / rejected / error / pending / running */
  status: string
  executedAt: number
  result?: CommandResult
  error?: string
}

interface ConversationFile {
  conversations?: Record<string, PersistedConversation>
  commandHistory?: Record<string, PersistedCommandEntry[]>
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8' })
    fs.renameSync(tmp, file)
  } catch (err) {
    // 落盘失败不应中断主流程：仅记录，历史在内存中仍可用
    console.error(`[conversation-store] 写入失败 ${file}`, err)
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as T
      // 防御：读到非法结构时退回默认
      return raw ?? fallback
    }
  } catch (err) {
    console.error(`[conversation-store] 读取失败 ${file}`, err)
  }
  return fallback
}

export class ConversationStore {
  private readonly file: string
  private data: ConversationFile

  constructor(dir: string) {
    this.file = path.join(dir, 'ai-conversations.json')
    this.data = readJson<ConversationFile>(this.file, {})
  }

  /** 清理超过保留窗口的对话与命令历史，返回保持不变的文件内容 */
  private pruneLocked(now = Date.now()): void {
    const conv = this.data.conversations ?? {}
    const cmds = this.data.commandHistory ?? {}
    let changed = false
    for (const key of Object.keys(conv)) {
      const updatedAt = conv[key]?.updatedAt ?? 0
      if (now - updatedAt > CONVERSATION_RETENTION_MS) {
        delete conv[key]
        changed = true
      }
    }
    this.data.conversations = conv

    const cutoff = now - CONVERSATION_RETENTION_MS
    for (const key of Object.keys(cmds)) {
      let arr = cmds[key] ?? []
      const before = arr.length
      arr = arr.filter((c) => (c.executedAt ?? 0) >= cutoff)
      if (arr.length !== before) changed = true
      cmds[key] = arr
    }
    this.data.commandHistory = cmds
    if (changed) this.persist()
  }

  /** 读取某主机的已保留对话（3 天内）；无则返回 null */
  loadConversation(profileKey: string): PersistedConversation | null {
    this.pruneLocked()
    const conv = this.data.conversations?.[profileKey]
    if (!conv) return null
    const messages = Array.isArray(conv.messages) ? conv.messages : []
    if (!messages.length) return null
    return { ...conv, messages }
  }

  /** 保存某主机对话；同时顺手清理过期条 */
  saveConversation(profileKey: string, messages: PersistedMessage[]): void {
    if (!messages?.length) return
    this.pruneLocked()
    this.data.conversations = this.data.conversations ?? {}
    this.data.conversations[profileKey] = {
      profileKey,
      updatedAt: Date.now(),
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    }
    this.persist()
  }

  /** 读取某主机的命令历史（3 天内） */
  loadCommandHistory(profileKey: string): PersistedCommandEntry[] {
    this.pruneLocked()
    return this.data.commandHistory?.[profileKey] ?? []
  }

  /** 追加一条命令历史并去重（同一 commandId 覆盖）；同时清理过期 */
  recordCommand(profileKey: string, entry: PersistedCommandEntry): void {
    this.pruneLocked()
    this.data.commandHistory = this.data.commandHistory ?? {}
    const arr = (this.data.commandHistory[profileKey] ?? []).filter(
      (c) => c.commandId !== entry.commandId
    )
    arr.push(entry)
    this.data.commandHistory[profileKey] = arr
    this.persist()
  }

  /** 更新某条命令的执行状态（结果 / 错误） */
  updateCommandStatus(
    profileKey: string,
    commandId: string,
    patch: { status?: string; result?: CommandResult; error?: string }
  ): void {
    this.pruneLocked()
    const arr = (this.data.commandHistory?.[profileKey] ?? []).map((c) =>
      c.commandId === commandId ? { ...c, ...patch } : c
    )
    if (this.data.commandHistory) this.data.commandHistory[profileKey] = arr
    this.persist()
  }

  /** 删除某主机的全部历史（新会话 / 清空历史时） */
  clear(profileKey: string): void {
    if (this.data.conversations) delete this.data.conversations[profileKey]
    if (this.data.commandHistory) delete this.data.commandHistory[profileKey]
    this.persist()
  }

  private persist(): void {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2))
  }
}

/**
 * 便捷构造：按某条 command 记录生成持久化条目。
 * 供 AiOpsService 在分发命令时写入。
 */
export function commandEntryFromProposal(
  proposal: ProposedCommand,
  extra?: { status?: string; result?: CommandResult; error?: string }
): PersistedCommandEntry {
  return {
    commandId: proposal.commandId,
    messageId: proposal.messageId,
    command: proposal.command,
    risk: proposal.risk,
    riskKind: proposal.riskKind,
    attacks: proposal.attacks,
    status: extra?.status ?? 'pending',
    executedAt: Date.now(),
    ...(extra?.result ? { result: extra.result } : {}),
    ...(extra?.error ? { error: extra.error } : {})
  }
}