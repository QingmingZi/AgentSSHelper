/**
 * 检索 Provider 抽象 + 内网友好。
 *
 * 目标（对齐三轴改进 v3）：
 *  - 检索是可缺席的插件：provider 不可用时主流程不阻塞、不报错、不退化到不安全；
 *  - 内网友好三件套：① 可配短超时（默认 2.5s）② 可用性缓存（失败后短路）③ 失败退避；
 *  - 单轮响应延迟不因检索增加（可用性缓存直接短路）。
 */

export interface SearchOptions {
  /** 最多保留的结果条数（top_k） */
  topK: number
  /** 新鲜度窗口，如 '1d' / '1w' / '1m'（按 provider 能力映射，可选） */
  freshness?: string
  /** 摘要单条最大字符数 */
  maxSnippetLen: number
}

export interface SearchOutcome {
  /** 搜索用关键词 */
  keyword: string
  /** 注入上下文的搜索摘要块（已消毒，调用方再套 <search_results> 标签） */
  snippet: string
  /** 命中条目数 */
  count: number
}

/** 检索 provider 接口：任何内置/第三方来源均可实现并挂到链上 */
export interface SearchProvider {
  readonly name: string
  /**
   * 搜索。返回 null 表示无需搜索或失败（静默降级）。
   * 不得抛出（让失败内网化，不影响主流程）。
   */
  search(query: string, opts: SearchOptions): Promise<SearchOutcome | null>
}

/** 默认短超时：搜索失败不应阻塞 AI 回答 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 2500
/** 默认 top_k */
export const DEFAULT_TOP_K = 5
/** 默认单条摘要上限 */
export const DEFAULT_SNIPPET_LEN = 600

/**
 * 检索 Provider 链：带可用性缓存与失败退避的调度器。
 * - 一旦某个 provider 连续失败达到阈值，进入冷却；冷却期间直接短路，不重试。
 * - 冷却随失败次数指数退避（上限 MAX_BACKOFF_MS）；成功则清零。
 * 这保证检索缺席/网络差时，不会拖慢每次 AI 回答。
 */
export class SearchManager {
  private readonly providers: SearchProvider[]
  private readonly unavailable = new Map<string, { until: number; fails: number }>()

  constructor(providers: SearchProvider[], opts: { initialBackoffMs?: number; maxBackoffMs?: number } = {}) {
    this.providers = providers
    this.initialBackoffMs = opts.initialBackoffMs ?? 5_000
    this.maxBackoffMs = opts.maxBackoffMs ?? 10 * 60_000
  }

  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number

  /** 返回仍未过冷却的 provider 名（用于诊断/测试） */
  coolingDown(): string[] {
    const now = Date.now()
    return [...this.unavailable.entries()]
      .filter(([, v]) => v.until > now)
      .map(([name]) => name)
  }

  private isAvailable(p: SearchProvider): boolean {
    const e = this.unavailable.get(p.name)
    return !e || e.until <= Date.now()
  }

  private fail(p: SearchProvider): void {
    const e = this.unavailable.get(p.name)
    const fails = (e?.fails ?? 0) + 1
    // 首次失败即进入短冷却；连续失败指数退避
    const backoff = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** (fails - 1))
    this.unavailable.set(p.name, { until: Date.now() + backoff, fails })
  }

  private succeed(p: SearchProvider): void {
    this.unavailable.delete(p.name)
  }

  /**
   * 依次尝试 providers，返回第一个成功结果；全部失败返回 null。
   * 被冷却的 provider 直接跳过（短路），不产生网络请求。
   */
  async search(query: string, opts: SearchOptions): Promise<SearchOutcome | null> {
    if (!query.trim()) return null
    for (const p of this.providers) {
      if (!this.isAvailable(p)) continue
      try {
        const out = await p.search(query, opts)
        if (out) {
          this.succeed(p)
          return out
        }
        // 返回 null（无需搜索或失败）也按失败处理，计入冷却，避免反复尝试不可用源
        this.fail(p)
      } catch {
        this.fail(p)
      }
    }
    return null
  }
}

/** 把 outcome 包成带信任标签的注入块（对齐 v3 动作 #3） */
export function wrapSearchBlock(outcome: SearchOutcome): string {
  return `<search_results trust="untrusted" source="provider">\n${outcome.snippet}\n</search_results>`
}