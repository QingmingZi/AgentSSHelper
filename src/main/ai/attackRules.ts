/**
 * ATT&CK 规则外置加载器。
 *
 * 规则表随应用打包在 resources/attack-rules.json（package.json files 已含
 * resources 目录）。这里在运行时读取并解析，把危险命令映射到 MITRE ATT&CK
 * 技术编号，仅用于在审批框辅助展示（不替代风险分级）。
 *
 * 离线可用、加载失败仅降级为「无 ATT&CK 标注」，不影响任何安全判定。
 */
import fs from 'node:fs'
import path from 'node:path'

export interface AttackRule {
  /** 正则字符串（匹配命令） */
  match: string
  /** MITRE ATT&CK 技术编号，如 T1548.003 */
  techniques: string[]
  /** 中文短说明 */
  label: string
  /** 战术阶段 */
  tactic: string
}

export interface AttackMatch {
  label: string
  tactic: string
  techniques: string[]
}

interface AttackRulesFile {
  version?: number
  rules?: Omit<AttackRule, never>[]
}

let cached: AttackRule[] | null = null
let loadError = ''

/** 定位 resources/attack-rules.json（打包后位于 app.asar/resources，开发态在项目根 resources） */
function locateRulesFile(): string {
  const candidates: string[] = []
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'attack-rules.json'))
  }
  // 开发/测试：从 __dirname 向上逐级找 resources/attack-rules.json
  let dir = path.resolve(__dirname)
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'resources', 'attack-rules.json'))
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return candidates.find((p) => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  }) ?? ''
}

/** 加载并缓存规则表；失败仅置标记，不抛。 */
export function loadAttackRules(): AttackRule[] {
  if (cached) return cached
  const file = locateRulesFile()
  if (!file) {
    loadError = '找不到 attack-rules.json'
    cached = []
    return cached
  }
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as AttackRulesFile
    cached = (parsed.rules ?? []).filter((r) => r?.match)
    return cached
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    cached = []
    return cached
  }
}

/** 规则是否已就绪（用于诊断，不影响降级） */
export function isAttackRulesReady(): boolean {
  return (cached ?? loadAttackRules()).length > 0
}

/** 命令命中的 ATT&CK 标注；空数组表示未命中或规则不可用。 */
export function matchAttackRules(command: string): AttackMatch[] {
  const rules = loadAttackRules()
  const out: AttackMatch[] = []
  for (const rule of rules) {
    let re: RegExp
    try {
      re = new RegExp(rule.match, 'i')
    } catch {
      continue
    }
    if (re.test(command)) {
      out.push({
        label: rule.label,
        tactic: rule.tactic,
        techniques: rule.techniques ?? []
      })
    }
  }
  return out
}

export function getAttackRulesError(): string {
  return loadError
}