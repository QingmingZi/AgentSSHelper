/**
 * 百度搜索增强代理
 *
 * 面向国内用户：直接访问的 Wikipedia / DuckDuckGo 均不可直连，而百度 AI 搜索
 * （千帆 ModelBuilder / AppBuilder 的 `web_search`）国内可达、返回结构化摘要，
 * 是「AI 联网搜索增强」最稳妥的来源。
 *
 * 端点：POST https://qianfan.baidubce.com/v2/ai_search/web_search
 * 认证：Authorization: Bearer <API Key>
 * 免费额度：约每日 50 次、每月 1500 次（超出按量付费），由调用方按 Store 配额计数。
 */

export interface BaiduSearchResult {
  /** 搜索用的关键词 */
  keyword: string
  /** 拼接后的搜索摘要（标题 + 摘要 + 来源链接），用于注入 AI 上下文 */
  snippet: string
  /** 命中的条目数 */
  count: number
}

const BAIdu_SEARCH_ENDPOINT =
  process.env.SSHELPER_SEARCH_ENDPOINT?.trim() ||
  'https://qianfan.baidubce.com/v2/ai_search/web_search'

/** 请求超时：搜索失败不应阻塞 AI 回答 */
const SEARCH_TIMEOUT_MS = 8000

/** 单条搜索结果里摘要的最大字符数 */
const MAX_SNIPPET_LEN = 600

/**
 * 指向「当前连接的这台主机」自身状态的问句 → 明确不需要联网搜索。
 * 例如「目前系统版本」「这台主机的内核版本」回答走主机上下文即可。
 * 放在正向信号之前优先排除，避免裸检索词误触发、白耗配额。
 */
const HOST_SCOPED: RegExp[] = [
  /(本机|这台(主机|服务器|机器)|当前主机|当前系统|当前这台|当前服务器|我们这台|本服务器)/i
]

/**
 * 启发式判断用户问题是否需要联网搜索。
 * 命中这些信号才去调用百度搜索，避免每轮都白耗配额（50/日、1500/月）。
 * 注意：刻意不用裸「版本」，否则「目前系统版本」这类本机查询也会被误触发。
 */
const SEARCH_HINTS: RegExp[] = [
  /cve[- ][0-9]/i,
  /https?:\/\//i,
  /(最新|稳定版|新版|新版本|升级到|更新到|changelog|release ?note)/i,
  /(怎么(配|设|安|写|改|装)|如何|怎样|配置|排错|排查|报错|修复|文档|manual|tutorial)/i,
  /(漏洞|安全通告|advisory|补丁|patch)/i,
  /(是什么|what is|define|含义)/i
]

/** 提炼搜索关键词：去掉问句话术、取主体词句，并截断保持精简 */
export function extractSearchKeyword(message: string): string {
  const cleaned = message
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?？。！!，,；;：:]+$/g, '')
    .slice(0, 80)
  return cleaned
}

/** 命中任一搜索信号则返回 true；已明确限定的本机问句一律不搜 */
export function shouldSearch(message: string): boolean {
  if (HOST_SCOPED.some((re) => re.test(message))) return false
  return SEARCH_HINTS.some((re) => re.test(message))
}

function stripSnippet(text: string): string {
  const cleaned = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\[\d+\]/g, '')
  return cleaned.length > MAX_SNIPPET_LEN
    ? `${cleaned.slice(0, MAX_SNIPPET_LEN)}…`
    : cleaned
}

/**
 * 调用百度 AI 搜索接口并整理成可直接注入上下文的摘要块。
 * 返回 null 表示无需搜索（未命中启发式）或搜索失败（静默降级，不阻塞 AI 回答）。
 * 调用方在成功返回非 null 时按配额计数（recordSearchUsage）。
 */
/**
 * 调用百度 AI 搜索接口并整理成可直接注入上下文的摘要块。
 * 返回 null 表示无需搜索（未命中启发式）或搜索失败（静默降级，不阻塞 AI 回答）。
 * 调用方在成功返回非 null 时按配额计数（recordSearchUsage）。
 *
 * 百度 `web_search` 协议（千帆 qianfan-api）：
 *  - 请求体：必须用 OpenAI 风格的 `messages[]`，而非长字段；`search_source=baidu_search_v2`。
 *  - 响应：结果条目集中在顶级 `references[]`，每条含 `title` / `content`(摘要) / `url`。
 *  - 计费：每月免费额度 1500 次（按天发放），约合每日 50 次。
 */
export async function baiduWebSearch(
  query: string,
  apiKey: string
): Promise<BaiduSearchResult | null> {
  if (!query.trim() || !apiKey) return null

  let response: Response
  try {
    response = await fetch(BAIdu_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: query }],
        search_source: 'baidu_search_v2'
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
    })
  } catch (err) {
    console.warn('[baiduSearch] 搜索请求异常', err instanceof Error ? err.message : err)
    return null
  }

  if (!response.ok) {
    // 限流 / 认证失败 / 参数错误：静默降级，不阻塞 AI 回答
    // 错误响应体可能含攻击者控制的文本或回显的 Key，落盘前脱敏、限长、剔除控制字符。
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

  const entries = extractWebResults(data)
  if (!entries.length) return null

  const lines = entries
    .map((e, i) => `${i + 1}. ${e.title}\n   ${stripSnippet(e.content)}\n   来源：${e.source}`)
  const snippet = lines.join('\n')

  return {
    keyword: query,
    snippet: `【在线资料 · 百度搜索】关键词：${query}\n${snippet}`,
    count: entries.length
  }
}

export interface WebResult {
  title: string
  content: string
  source: string
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
        source: source && typeof source === 'string' && source.trim() ? source.trim() : '百度'
      })
    }
    if (out.length >= 5) break
  }
  return out
}