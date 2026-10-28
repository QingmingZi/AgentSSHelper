import type { AiConfig, AiMetrics } from '@shared/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiStreamHandlers {
  onDelta: (text: string) => void
  /** 首个 token 到达时回调，参数为耗时毫秒 */
  onFirstToken?: (latencyMs: number) => void
  onDone: (fullText: string, metrics: AiMetrics) => void
  onError: (err: Error) => void
}

/**
 * 粗略估算 token 数。
 * 服务端返回 usage 时优先用真实值；不支持 usage 的兼容服务用这个兜底。
 * 经验值：ASCII 约 4 字符/token，中文等非 ASCII 约 1.5 字符/token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let ascii = 0
  let nonAscii = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii++
    else nonAscii++
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5)
}

/** 估算整组消息的 token 数（含每条消息的固定开销） */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0)
}

/** 拼接 base URL，避免用户填了 /v1 又重复拼接 */
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim()
  if (!url) return url
  url = url.replace(/\/+$/, '')
  if (!/\/v\d+$/.test(url) && !/\/chat\/completions$/.test(url)) {
    url += '/v1'
  }
  return url
}

/**
 * 校验 AI 服务端 baseUrl，防止 SSRF / 任意主机外送 API Key。
 *
 * 约束：
 *  - 必须是合法 URL，且协议仅限 http/https（拒绝 file://、data://、ftp:// 等，
 *    否则可能被用于读取本地文件）；
 *  - 解析出的主机若为回环 / 链路本地 / 保留地址（如 169.254.169.254 云元数据、
 *    127.0.0.1、::1、fe80::），仅当显式传入 allowLoopback 时才允许。
 *
 * @returns 校验通过返回规范化前的原始 baseUrl；失败抛 Error。
 */
export function assertSafeBaseUrl(baseUrl: string, opts: { allowLoopback?: boolean; label?: string } = {}): string {
  const raw = (baseUrl ?? '').trim()
  if (!raw) throw new Error(`${opts.label ?? '接口地址'}不能为空`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${opts.label ?? '接口地址'}不是合法的 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${opts.label ?? '接口地址'}仅支持 http/https 协议，不允许 ${parsed.protocol}//`)
  }
  const host = parsed.hostname.toLowerCase()
  // 判断是否回环/链路本地/保留地址（含 IPv6 压缩形式与 127.0.0.0/8）
  const isLoopback =
    host === 'localhost' ||
    host === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    /^0\.0\.0\.0$/.test(host)
  const isLinkLocal =
    /^fe80:/i.test(host) ||
    /^169\.254\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(host)
  if ((isLoopback || isLinkLocal) && !opts.allowLoopback) {
    throw new Error(
      `${opts.label ?? '接口地址'}指向 ${host}（内网/回环地址）。为避免 SSRF 与 API Key 外送至云元数据或内网主机，已拒绝。若确为内网自建服务，请在设置中显式允许并确认。`
    )
  }
  return raw
}

/** 错误响应体脱敏：剔除控制/ANSI 字符、压缩空白、截断、并隐藏疑似密钥文本 */
export function sanitizeErrorBody(text: string, maxLength = 300): string {
  if (!text) return ''
  const cleaned = text
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[()][0-9;]*|\][^\u0007]*\u0007?)/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{8,})\b/gi, '[REDACTED]')
    .trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned
}

/**
 * 从服务端的 /models 响应里提取模型 ID。
 * 兼容 OpenAI 标准的 `{ data: [{ id }] }`，
 * 也兼容 `{ models: [...] }`、裸数组，以及元素直接是字符串的写法。
 */
export function parseModelList(payload: unknown): string[] {
  const pick = (item: unknown): string | undefined => {
    if (typeof item === 'string') return item.trim() || undefined
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      for (const key of ['id', 'name', 'model', 'model_name']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
      }
    }
    return undefined
  }

  let items: unknown[] = []
  if (Array.isArray(payload)) {
    items = payload
  } else if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['data', 'models', 'result', 'items']) {
      const value = record[key]
      if (Array.isArray(value)) {
        items = value
        break
      }
    }
  }

  const models = items.map(pick).filter((m): m is string => Boolean(m))
  return [...new Set(models)].sort((a, b) => a.localeCompare(b))
}

export class AiClient {
  constructor(
    private readonly config: AiConfig,
    private readonly apiKey: string
  ) {
    // 构造时即校验接口地址：拒绝内网/回环/云元数据等危险目标，防 SSRF 与 Key 外送。
    // 回环地址（localhost/127.0.0.1）允许，便于本地自建 LLM（如 Ollama）。
    try {
      assertSafeBaseUrl(config.baseUrl, { allowLoopback: true, label: 'AI 接口地址' })
    } catch (err) {
      // 构造期不失败，由各出站方法在真正发起前校验；这里只提前暴露明显错误。
      this.urlError = err instanceof Error ? err.message : String(err)
    }
  }

  private readonly urlError: string = ''

  private get endpoint(): string {
    const base = normalizeBaseUrl(this.config.baseUrl)
    if (/\/chat\/completions$/.test(base)) return base
    return `${base}/chat/completions`
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    return headers
  }

  /** 候选的模型列表地址：主路径为 {base}/models，必要时回退到不带 /v1 的根路径 */
  private modelEndpoints(): string[] {
    const base = normalizeBaseUrl(this.config.baseUrl)
    const urls: string[] = []
    if (/\/chat\/completions$/.test(base)) {
      urls.push(`${base.replace(/\/chat\/completions$/, '')}/models`)
    } else {
      urls.push(`${base}/models`)
      if (/\/v\d+$/.test(base)) {
        urls.push(`${base.replace(/\/v\d+$/, '')}/models`)
      }
    }
    return [...new Set(urls)]
  }

  /**
   * 拉取服务端可用模型列表（OpenAI 兼容的 GET /models）。
   * 失败不抛异常，返回 ok=false 与错误描述，由界面提示用户手填。
   */
  async listModels(): Promise<{ ok: boolean; models: string[]; message: string }> {
    if (this.urlError) return { ok: false, models: [], message: this.urlError }
    let lastError = ''
    for (const url of this.modelEndpoints()) {
      try {
        const response = await fetch(url, { method: 'GET', headers: this.buildHeaders() })
        const text = await response.text()
        if (!response.ok) {
          lastError = `HTTP ${response.status} ${response.statusText} ${sanitizeErrorBody(text)}`.trim()
          continue
        }
        let payload: unknown
        try {
          payload = JSON.parse(text)
        } catch {
          lastError = '返回内容不是合法 JSON'
          continue
        }
        const models = parseModelList(payload)
        if (!models.length) {
          lastError = '服务返回的响应里没有模型列表'
          continue
        }
        return { ok: true, models, message: `已获取 ${models.length} 个模型` }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return { ok: false, models: [], message: lastError || '获取模型列表失败' }
  }

  /** 发送一次非流式请求（用于连通性测试） */
  async ping(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    if (this.urlError) return { ok: false, message: this.urlError, latencyMs: 0 }
    const started = Date.now()
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 8,
          temperature: 0
        })
      })
      const latencyMs = Date.now() - started
      const text = await response.text()
      if (!response.ok) {
        return { ok: false, message: `HTTP ${response.status} ${response.statusText} ${sanitizeErrorBody(text)}`, latencyMs }
      }
      return { ok: true, message: '连接成功', latencyMs }
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? sanitizeErrorBody(err.message) : String(err),
        latencyMs: Date.now() - started
      }
    }
  }

  /** 流式对话，同时统计首字延迟、输出速度与上下文用量 */
  async chat(messages: ChatMessage[], handlers: AiStreamHandlers, signal?: AbortSignal): Promise<void> {
    if (this.urlError) {
      handlers.onError(new Error(this.urlError))
      return
    }
    const startedAt = Date.now()
    let full = ''
    let firstTokenAt: number | null = null
    let usage: { promptTokens: number; completionTokens: number } | null = null
    let finished = false

    const buildMetrics = (): AiMetrics => {
      const durationMs = Date.now() - startedAt
      const firstTokenMs = firstTokenAt === null ? 0 : firstTokenAt - startedAt
      const promptTokens = usage?.promptTokens || estimateMessagesTokens(messages)
      const outputTokens = usage?.completionTokens || estimateTokens(full)
      const generationMs = durationMs - firstTokenMs
      const tokensPerSecond =
        outputTokens > 0 && generationMs > 0 ? outputTokens / (generationMs / 1000) : 0
      return {
        firstTokenMs,
        durationMs,
        promptTokens,
        outputTokens,
        tokensPerSecond,
        maxContextTokens: this.config.maxContextTokens || 256 * 1024,
        // 服务端没有返回完整的 usage 时，提示用户这是本地估算值
        estimated: !usage?.promptTokens || !usage?.completionTokens
      }
    }

    const finish = (): void => {
      if (finished) return
      finished = true
      handlers.onDone(full, buildMetrics())
    }

    try {
      const body = {
        model: this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: true,
        // 让 OpenAI 兼容服务在流末尾带回 usage，用于精确统计 token
        stream_options: { include_usage: true }
      }

      const send = (withUsage: boolean): Promise<Response> =>
        fetch(this.endpoint, {
          method: 'POST',
          headers: this.buildHeaders(),
          signal,
          body: JSON.stringify(withUsage ? body : { ...body, stream_options: undefined })
        })

      let response = await send(true)
      if (!response.ok && (response.status === 400 || response.status === 422)) {
        const text = await response.text()
        // 部分兼容服务不认识 stream_options，去掉后重试一次
        if (/stream_options|unknown|unrecognized|unsupported|invalid/i.test(text)) {
          response = await send(false)
        } else {
          throw new Error(`HTTP ${response.status} ${response.statusText}: ${sanitizeErrorBody(text)}`)
        }
      }
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${sanitizeErrorBody(text)}`)
      }
      if (!response.body) throw new Error('响应没有可读流')

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          if (payload === '[DONE]') {
            finish()
            return
          }
          let parsed: {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string }; finish_reason?: string | null }>
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
            error?: { message?: string }
          }
          try {
            parsed = JSON.parse(payload)
          } catch {
            continue
          }
          if (parsed.error?.message) throw new Error(sanitizeErrorBody(parsed.error.message))
          if (parsed.usage) {
            usage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0
            }
          }
          const choice = parsed.choices?.[0]
          const delta = choice?.delta?.content ?? choice?.message?.content ?? ''
          if (delta) {
            const isFirst = firstTokenAt === null
            if (isFirst) firstTokenAt = Date.now()
            full += delta
            // 先发 delta 再发首字指标：渲染层先建立流式消息，再挂上延迟数字
            handlers.onDelta(delta)
            if (isFirst) handlers.onFirstToken?.(firstTokenAt! - startedAt)
          }
        }
      }

      finish()
    } catch (err) {
      if (signal?.aborted) {
        finish()
        return
      }
      handlers.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
