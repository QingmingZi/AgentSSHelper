/**
 * 百度 AI 搜索 provider（实现 SearchProvider）。
 *
 * 面向国内用户：百度 AI 搜索（千帆 ModelBuilder 的 web_search）国内可达、
 * 返回结构化摘要，是 AI 联网搜索增强最稳妥的来源。
 * 端点：POST https://qianfan.baidubce.com/v2/ai_search/web_search
 * 认证：Authorization: Bearer <API Key>
 * 协议：OpenAI 风格 messages[] + search_source=baidu_search_v2；
 *      结果条目在响应顶级 references[]（title/content/summary/url）。
 */

import {
  type SearchOptions,
  type SearchOutcome,
  type SearchProvider,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_SNIPPET_LEN
} from './provider'

export interface WebResult {
  title: string
  content: string
  source: string
  /** 来源（原样透传，可能为空） */
  website?: string
  /** 时间信息（可能为空） */
  date?: string
}

const BAIdu_SEARCH_ENDPOINT =
  process.env.SSHELPER_SEARCH_ENDPOINT?.trim() ||
  'https://qianfan.baidubce.com/v2/ai_search/web_search'

/** 单个搜索请求超时（内网友好：默认 2.5s，可通过环境变量覆盖 1–5s） */
function resolveTimeout(): number {
  const raw = Number(process.env.SSHELPER_SEARCH_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 5000) return raw
  return DEFAULT_SEARCH_TIMEOUT_MS
}

function stripSnippet(text: string, maxLen: number): string {
  const cleaned = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\[\d+\]/g, '')
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned
}

/** 兼容 qianfan web_search 不同响应形态，提取结构化搜索条目（导出供测试） */
export function extractWebResults(data: unknown): WebResult[] {
  const record = (data ?? {}) as Record<string, unknown>
  const candidates: unknown[] = []

  // 官方标准响应：顶级 references[]（重点）
  if (Array.isArray(record.references)) candidates.push(...record.references)
  // 兼容其它可能形态
  for (const key of ['search_results', 'results', 'items', 'answers']) {
    const list = record[key]
    if (Array.isArray(list)) candidates.push(...list)
  }
  // 兼容 { result: { references: [...] } } / { result: { content: "..." } } 包裹
  const result = record.result as Record<string, unknown> | undefined
  if (result && Array.isArray(result.references)) candidates.push(...result.references)

  const out: WebResult[] = []
  for (const item of candidates) {
    const it = (item ?? {}) as Record<string, unknown>
    const title = (it.title ?? it.headline ?? it.web_anchor ?? '') as string | undefined
    const content = (it.content ?? it.summary ?? it.snippet ?? it.text) as string | undefined
    const source = (it.url ?? it.link ?? it.source) as string | undefined
    if (content && typeof content === 'string' && content.trim()) {
      out.push({
        title: (title && String(title).trim()) || '条目',
        content: String(content),
        source: source && typeof source === 'string' && source.trim() ? source.trim() : '百度',
        website: it.website ? String(it.website).trim() : undefined,
        date: it.date ? String(it.date).trim() : undefined
      })
    }
  }
  return out
}

/** 百度搜索（含密钥）provider */
export class BaiduSearchProvider implements SearchProvider {
  readonly name = 'baidu'

  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: SearchOptions): Promise<SearchOutcome | null> {
    if (!query.trim() || !this.apiKey) return null

    let response: Response
    try {
      response = await fetch(BAIdu_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        // 百度 web_search 可选参数：时新性/类型过滤按需透传，top_k 控制条数
        body: JSON.stringify({
          messages: [{ role: 'user', content: query }],
          search_source: 'baidu_search_v2',
          ...(opts.freshness ? { freshness: opts.freshness } : {}),
          ...(opts.topK ? { top_k: opts.topK } : {})
        }),
        signal: AbortSignal.timeout(resolveTimeout())
      })
    } catch (err) {
      console.warn('[baiduSearch] 搜索请求异常', err instanceof Error ? err.message : err)
      return null
    }

    if (!response.ok) {
      // 限流 / 认证失败 / 参数错误：静默降级。错误体可能含攻击者控制文本或回显 Key，落盘前脱敏限长。
      const detail = await response.text().catch(() => '')
      const safeDetail = detail
        .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~])/g, '')
        .replace(/[\u0000-\u001f\u007f\r]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{8,})\b/gi, '[REDACTED]')
        .trim()
        .slice(0, 200)
      console.warn(`[baiduSearch] 搜索失败 HTTP ${response.status}：${safeDetail}`)
      return null
    }

    let data: unknown
    try {
      data = await response.json()
    } catch {
      return null
    }

    const entries = extractWebResults(data).slice(0, Math.max(1, opts.topK))
    if (!entries.length) return null

    const maxLen = opts.maxSnippetLen || DEFAULT_SNIPPET_LEN
    const lines = entries.map((e, i) => {
      const meta = [e.source ?? '百度', e.date, e.website].filter(Boolean).join(' · ')
      return `${i + 1}. ${e.title}\n   ${stripSnippet(e.content, maxLen)}\n   来源：${meta}`
    })
    const snippet = lines.join('\n')

    return {
      keyword: query,
      snippet: `【在线资料 · 百度搜索】关键词：${query}\n${snippet}`,
      count: entries.length
    }
  }
}

/** 便捷工厂：无密钥时返回一个永不生效的 provider */
export function createBaiduProvider(apiKey: string | undefined): SearchProvider {
  return new BaiduSearchProvider(apiKey || '')
}