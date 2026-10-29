/**
 * 污点分析（taint analysis）：source → sink 追踪，供分级器与执行闸门使用。
 *
 * 本工具的命令提取只发生在「模型输出」上；不可信输入（远端命令输出、检索摘要、
 * 用户粘贴内容）在注入上下文前已由 sanitizeUntrusted 剥离命令协议标记。本模块把
 * 这套「不可信输入不可直接命令化」的约束显式化，并提供测试可覆盖的判定函数。
 *
 * 关键不变量：
 *  1. 注入上下文的不可信文本，凡含 :::command、heredoc EOF/EOT、不可信块标签
 *     等「命令外观」标记，即视为注入残留；经 sanitizeUntrusted 剥离或由本模块
 *     判为需确认，永远不会被当作可自动执行的命令。
 *  2. 命令执行汇（EXEC）上，任何依旧残留命令块协议标记 / 不可信块标签的命令，
 *     都视为模型回显了不可信内容 → 强制「需确认」（永不自动执行）。
 *  3. LLM 出站（把内容再发给模型）前，不可信文本必须「干净」（sanitize + redact）。
 */

/** 不可信输入来源类别 */
export type TaintSource = 'untrusted' | 'search' | 'user_paste' | 'model'

/** 不可信文本里「命令块/heredoc」外观标记：命中即视为提示注入残留 */
const COMMAND_BLOCK_MARKERS = [
  /:::\s*command\b/i,
  /:::/,
  /(^|\n)[ \t]*(?:EOF|EOT)[ \t]*($|\r?\n)/i,
  /<search_results[\s>]/i,
  /<untrusted[\s>]/i
]

/**
 * 判断一段不可信文本是否残留「本可当作命令」的协议标记。
 * 若为 true，说明它没有被正确剥离，必须阻止其进入命令提取通道。
 */
export function hasCommandBlockRemnants(text: string): boolean {
  if (!text) return false
  return COMMAND_BLOCK_MARKERS.some((re) => re.test(text))
}

/**
 * 执行汇污点判定：给定即将交给 exec 的命令文本，若其中残留命令块协议标记
 * （如模型把 <search_results> 或远端输出里的 :::command 原样回显成命令），
 * 视为不可信源流入执行汇 → 应强制「需确认」，永不自动执行。
 */
export function taintRequiresConfirmation(command: string): boolean {
  if (!command) return false
  // 命令块外壳本身（:::command ... :::）不应出现在「将被执行的命令」文本里；
  // 一旦出现，几乎必然是未剥离的注入残留。
  if (/:::\s*command\b/i.test(command)) return true
  // 命令文本引用不可信块标签，说明命令可能取材自检索/远端内容
  if (/<(?:search_results|untrusted)\b/i.test(command)) return true
  // 独立的 EOF/EOT 行出现在命令内容里，也是 heredoc 注入残留
  if (/\n[ \t]*(?:EOF|EOT)[ \t]*($|\n)/i.test(command)) return true
  return false
}

/**
 * LLM 出站污点闸门：不可信文本在回灌模型前必须是「干净」的。
 * 与 existing sanitizeUntrusted + redactSecrets 组合使用；此处只是把
 * 「是否还需要进一步清洗」的判定独立出来便于测试。
 */
export function isCleanForLlm(text: string): boolean {
  if (!text) return true
  return !hasCommandBlockRemnants(text)
}

/** 把某段来源标记映射为中文（供诊断/调试输出，不影响判定） */
export function taintSourceLabel(source: TaintSource): string {
  switch (source) {
    case 'untrusted':
      return '远端/终端不可信输出'
    case 'search':
      return '联网检索摘要'
    case 'user_paste':
      return '用户粘贴内容'
    case 'model':
      return '模型输出'
  }
}