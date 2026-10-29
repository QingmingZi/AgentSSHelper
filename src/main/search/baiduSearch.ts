/**
 * 百度搜索兼容层 —— 保留原有导出，供存量 import 使用。
 *
 * 核心实现已迁至：
 *  - 检索 Provider 抽象/可用性缓存/退避：`./provider`
 *  - 百度搜索 provider：`./baidu`
 *
 * 本文件保留 `shouldSearch` / `extractSearchKeyword` / `extractWebResults` /
 * `BaiduSearchResult`，并从新模块转发 provider 相关符号，避免破坏既有 import。
 */

export {
  BaiduSearchProvider,
  createBaiduProvider,
  extractWebResults,
  type WebResult
} from './baidu'
export {
  type SearchOptions,
  type SearchOutcome,
  type SearchProvider,
  SearchManager,
  wrapSearchBlock,
  DEFAULT_TOP_K,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_SNIPPET_LEN
} from './provider'

export interface BaiduSearchResult {
  keyword: string
  snippet: string
  count: number
}

/** 指向「当前连接的这台主机」自身状态的问句 → 明确不需要联网搜索。 */
const HOST_SCOPED: RegExp[] = [
  /(本机|这台(主机|服务器|机器)|当前主机|当前系统|当前这台|当前服务器|我们这台|本服务器)/i
]

/** 启发式判断用户问题是否需要联网搜索（命中才去调用，避免白耗配额）。 */
const SEARCH_HINTS: RegExp[] = [
  /cve[- ][0-9]/i,
  /https?:\/\//i,
  /(最新|稳定版|新版|新版本|升级到|更新到|changelog|release ?note)/i,
  /(怎么(配|设|安|写|改|装)|如何|怎样|配置|排错|排查|报错|修复|文档|manual|tutorial)/i,
  /(漏洞|安全通告|advisory|补丁|patch)/i,
  /(是什么|what is|define|含义)/i
]

/** 提炼搜索关键词 */
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