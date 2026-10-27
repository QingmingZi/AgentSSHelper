/** 终端输出环形缓冲，供 AI 运维读取上下文 */

const MAX_CHUNKS = 400
const chunks: string[] = []

// 去掉 ANSI 控制序列，避免污染发给 AI 的上下文
const ANSI_PATTERN = new RegExp(
  '\\u001b\\[[0-9;?]*[ -/]*[@-~]' + // CSI
    '|\\u001b\\][^\\u0007]*(?:\\u0007|\\u001b\\\\)' + // OSC
    '|\\u001b[@-Z\\\\-_]', // 其余单字符转义
  'g'
)

export function appendTerminalOutput(chunk: string): void {
  chunks.push(chunk)
  if (chunks.length > MAX_CHUNKS) chunks.shift()
}

export function getTerminalContext(lines = 60): string {
  const raw = chunks.join('')
  const cleaned = raw.replace(ANSI_PATTERN, '')
  const allLines = cleaned.split(/\r?\n/)
  return allLines.slice(-lines).join('\n')
}

export function clearTerminalBuffer(): void {
  chunks.length = 0
}
