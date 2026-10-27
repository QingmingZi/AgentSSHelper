import { memo } from 'react'
import type { ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownProps {
  content: string
}

/**
 * AI 回复里的命令协议块（:::command ... :::）不是 Markdown 语法，
 * 直接渲染会把协议标记原样显示出来。这里统一转成围栏代码块，
 * 既保留命令内容，又能获得等宽字体与横向滚动。
 */
const COMMAND_BLOCK = /:::command\s*\n?([\s\S]*?)\n?\s*:::/g

export function normalizeMarkdown(content: string): string {
  return content.replace(COMMAND_BLOCK, (_match, command: string) => {
    return '```bash\n' + command.trim() + '\n```'
  })
}

/**
 * AI 回复的 Markdown 渲染。
 *
 * 选择 react-markdown 的原因：
 *  - 默认不解析原始 HTML，也不使用 dangerouslySetInnerHTML，XSS 面更小；
 *  - 以 React 组件渲染，链接可以显式交给系统浏览器；
 *  - remark-gfm 补上表格、删除线、任务列表等常用语法；
 *  - 纯渲染层实现，不需要放宽 CSP。
 */
function Markdown({ content }: MarkdownProps): ReactElement {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 外链交给系统浏览器：target=_blank 会走主进程的 setWindowOpenHandler
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          )
        }}
      >
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
