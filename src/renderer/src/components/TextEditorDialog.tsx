import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import Editor from '@monaco-editor/react'
import { monaco } from '../monaco-setup'
import { api } from '../api'
import Modal from './Modal'

interface TextEditorDialogProps {
  sessionId: string
  /** 远端文件绝对路径 */
  remotePath: string
  /** 文件名（用于标题与语言判定） */
  fileName: string
  onClose: () => void
}

/** 依据扩展名粗判 Monaco 语言；返回 undefined 交由 Monaco 自动检测 */
function detectLanguage(name: string): string | undefined {
  const lower = name.toLowerCase()
  // yaml：Monaco 内置实际为 'yaml'；shell 为 'shell'
  const ext = lower.slice(lower.lastIndexOf('.') + 1)
  const map: Record<string, string> = {
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    ini: 'ini',
    conf: 'ini',
    cfg: 'ini',
    properties: 'ini',
    py: 'python',
    pyw: 'python',
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    mts: 'typescript',
    tsx: 'typescript',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    txt: 'plaintext',
    log: 'plaintext',
    csv: 'plaintext',
    env: 'ini',
    sql: 'sql',
    xml: 'xml',
    svg: 'xml',
    ps1: 'powershell',
    bat: 'bat',
    cmd: 'bat',
    dockerfile: 'dockerfile',
    graphql: 'graphql',
    toml: 'ini',
    go: 'go',
    java: 'java',
    'kt': 'kotlin',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    php: 'php',
    rb: 'ruby',
    rs: 'rust',
    swift: 'swift',
    'lua': 'lua',
    pl: 'perl',
    r: 'r'
  }
  return map[ext]
}

interface TextStats {
  chars: number
  lines: number
}

interface SearchState {
  term: string
  /** 当前命中的索引（从 0 开始） */
  index: number
  /** 命中总数 */
  total: number
}

/** 转义正则特殊字符，使搜索按字面匹配 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 收集一段文本中所有匹配的行号与起止位置 */
function findAllMatches(text: string, term: string): Array<{ line: number; start: number; end: number }> {
  const matches: Array<{ line: number; start: number; end: number }> = []
  if (!term) return matches
  const re = new RegExp(escapeRegExp(term), 'g')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0
    let found: RegExpExecArray | null
    while ((found = re.exec(lines[i])) !== null) {
      matches.push({ line: i + 1, start: found.index, end: found.index + found[0].length })
      if (re.lastIndex === found.index) re.lastIndex++
    }
  }
  return matches
}

/** 统计字符串的字数与行数 */
function computeStats(text: string): TextStats {
  return {
    chars: text.length,
    lines: text.length === 0 ? 0 : text.split('\n').length
  }
}

/** 大数字缩写：>= 1000 用 K，>= 1000000 用 M，保留 1 位小数 */
function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export default function TextEditorDialog({
  sessionId,
  remotePath,
  fileName,
  onClose
}: TextEditorDialogProps): ReactElement {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [stats, setStats] = useState<TextStats>({ chars: 0, lines: 0 })
  const [search, setSearch] = useState<SearchState>({ term: '', index: 0, total: 0 })
  const [searchOpen, setSearchOpen] = useState(false)
  const editorRef = useRef<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
  const decorIdsRef = useRef<string[]>([])
  const matchPositionsRef = useRef<Array<{ line: number; start: number; end: number }>>([])
  const savingRef = useRef(false)

  // 关闭搜索：清空高亮与命中（提前定义，供 Ctrl+S/Ctrl+F 快捷键 effect 引用）
  const handleSearchClose = useCallback((): void => {
    setSearchOpen(false)
    setSearch({ term: '', index: 0, total: 0 })
    matchPositionsRef.current = []
    editorRef.current?.deltaDecorations(decorIdsRef.current, [])
    editorRef.current?.focus()
  }, [])

  const language = useMemo(() => detectLanguage(fileName), [fileName])

  // 读取远端文件
  useEffect(() => {
    let alive = true
    setError('')
    setStatus('正在从远程加载…')
    void api.sftp
      .readText(sessionId, remotePath)
      .then((res) => {
        if (!alive) return
        setContent(res.content)
        setStats(computeStats(res.content))
        setLoaded(true)
        setStatus('已加载')
      })
      .catch((err) => {
        if (!alive) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('加载失败')
      })
    return () => {
      alive = false
    }
  }, [sessionId, remotePath])

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && key === 's') {
        e.preventDefault()
        e.stopPropagation()
        void save()
      } else if ((e.ctrlKey || e.metaKey) && key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen(true)
      } else if (e.key === 'Escape' && searchOpen) {
        handleSearchClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, sessionId, remotePath, searchOpen, handleSearchClose])

  const save = useCallback(async (): Promise<void> => {
    if (savingRef.current || !dirty) {
      setStatus('没有需要保存的修改')
      return
    }
    savingRef.current = true
    setSaving(true)
    setStatus('保存中…')
    setError('')
    try {
      await api.sftp.writeText(sessionId, remotePath, editorRef.current?.getValue() ?? content)
      setDirty(false)
      setStatus('已保存到远端')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('保存失败')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [sessionId, remotePath, content, dirty])

  const handleEditorChange = useCallback((value: string | undefined): void => {
    const next = value ?? ''
    setDirty(true)
    setContent(next)
    setStats(computeStats(next))
  }, [])

  // 应用装饰器高亮：baseIdx 指向当前命中（用「当前命中」样式），其余用「普通命中」样式
  const renderHighlights = useCallback(
    (marks: Array<{ line: number; start: number; end: number }>, active: number): void => {
      const editor = editorRef.current
      if (!editor) return
      const decos = marks.map((m, i) => ({
        range: new monaco.Range(m.line, m.start + 1, m.line, m.end + 1),
        options: i === active ? { className: 'editor-search-current' } : { inlineClassName: 'editor-search-match' }
      }))
      editor.deltaDecorations(decorIdsRef.current, decos)
    },
    []
  )

  // 跳到第 target 个命中并居中显示
  const jumpTo = useCallback(
    (marks: Array<{ line: number; start: number; end: number }>, target: number): void => {
      const editor = editorRef.current
      if (!editor || marks.length === 0) return
      const m = marks[target]
      if (!m) return
      const range = new monaco.Range(m.line, m.start + 1, m.line, m.end + 1)
      renderHighlights(marks, target)
      editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth)
      editor.setSelection(range)
    },
    [renderHighlights]
  )

  // 输入搜索词：重新扫描匹配，更新计数并跳到第一处
  const handleSearchInput = useCallback(
    (termRaw: string): void => {
      const term = termRaw
      if (!term.trim()) {
        setSearch({ term: '', index: 0, total: 0 })
        matchPositionsRef.current = []
        editorRef.current?.deltaDecorations(decorIdsRef.current, [])
        return
      }
      const marks = findAllMatches(editorRef.current?.getValue() ?? '', term)
      matchPositionsRef.current = marks
      const total = marks.length
      setSearch({ term, index: 0, total })
      if (total > 0) jumpTo(marks, 0)
    },
    [jumpTo]
  )

  const handleSearchNext = useCallback((): void => {
    const marks = matchPositionsRef.current
    if (marks.length === 0) return
    const next = (search.index + 1) % marks.length
    setSearch({ ...search, index: next })
    jumpTo(marks, next)
  }, [search, jumpTo])

  const handleSearchPrev = useCallback((): void => {
    const marks = matchPositionsRef.current
    if (marks.length === 0) return
    const prev = (search.index - 1 + marks.length) % marks.length
    setSearch({ ...search, index: prev })
    jumpTo(marks, prev)
  }, [search, jumpTo])

  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor): void => {
    editorRef.current = editor
    ;(window as unknown as { __sshHelperEditor?: typeof editor }).__sshHelperEditor = editor
    editor.focus()
  }, [])

  // 有未保存修改时关闭需确认
  const handleClose = (): void => {
    if (dirty) {
      const ok = window.confirm('当前文件有未保存的修改，确定关闭吗？未保存的修改将丢失。')
      if (!ok) return
    }
    onClose()
  }

  const dirtyDot = dirty ? '● ' : ''

  return (
    <Modal className="editor-modal" onClose={handleClose}>
      <div className="editor-dialog">
        <div className="editor-toolbar">
          <span className="pane-title">
            {dirtyDot}编辑：{fileName}
          </span>
          <span className="editor-path" title={remotePath}>
            {remotePath}
          </span>
          {loaded && (
            <span className="editor-stats">
              {formatCount(stats.lines)} 行 · {formatCount(stats.chars)} 字
            </span>
          )}
          <div className="spacer" />
          {searchOpen ? (
            <div className="editor-search">
              <input
                className="editor-search-input"
                value={search.term}
                onChange={(e) => handleSearchInput(e.target.value)}
                placeholder="搜索…"
                autoFocus
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.shiftKey ? handleSearchPrev() : handleSearchNext())
                  else if (e.key === 'Escape') handleSearchClose()
                }}
              />
              <span className="editor-search-count">
                {search.total > 0 ? `${search.index + 1}/${search.total}` : search.term ? '0' : ''}
              </span>
              <button className="btn very-small ghost" title="上一处 (Shift+Enter)" onClick={handleSearchPrev} disabled={search.total === 0}>
                ↑
              </button>
              <button className="btn very-small ghost" title="下一处 (Enter)" onClick={handleSearchNext} disabled={search.total === 0}>
                ↓
              </button>
              <button className="btn very-small ghost" title="关闭 (Esc)" onClick={handleSearchClose}>
                ×
              </button>
            </div>
          ) : (
            <button className="btn small ghost" title="搜索 (Ctrl+F)" onClick={() => setSearchOpen(true)}>
              搜索
            </button>
          )}
          <span className={`editor-status ${error ? 'error' : ''}`}>
            {error || status}
          </span>
          <button className="btn small" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? '保存中…' : '保存 (Ctrl+S)'}
          </button>
          <button className="btn small ghost" onClick={handleClose}>
            关闭
          </button>
        </div>
        {loaded ? (
          <div className="editor-body">
            <Editor
              height="100%"
              defaultLanguage={language}
              language={language}
              theme="vs-dark"
              value={content}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              options={{
                fontSize: 13,
                minimap: { enabled: true },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: 'on',
                renderWhitespace: 'selection',
                smoothScrolling: true,
                padding: { top: 8, bottom: 8 },
                domReadOnly: saving
              }}
            />
          </div>
        ) : error ? (
          <div className="editor-body empty">
            <div className="inline-error">{error}</div>
            <button className="btn small" onClick={onClose}>
              关闭
            </button>
          </div>
        ) : (
          <div className="editor-body empty">正在从远程加载…</div>
        )}
      </div>
    </Modal>
  )
}