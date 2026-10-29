/**
 * 基于 tree-sitter 的 shell AST 危险分析（只加严，不放松）。
 *
 * 设计原则（对齐三轴改进 v3）：
 *  - AST 只用于「发现更多危险」，绝不用于放行正则原本拒绝的命令；
 *  - 任何加载/解析失败都返回「无信号」，回退到既有正则分级，永不因 AST 失败而放宽；
 *  - 只有当 AST 明确解析成功且命中高危结构时才强制升级。
 *
 * wasm 资源在打包时必须进 `asarUnpack`/`extraResources`，否则生产环境加载失败。
 */

import path from 'node:path'
import fs from 'node:fs'

/**
 * 定位某个 npm 包内的文件（wasm 等）。
 * 优先生产环境 app.asar.unpacked；否则从 __dirname 向上找 node_modules。
 * 避免依赖 require.resolve（esbuild 打包时会把字面量路径内联成构建期绝对路径，打包后失效）。
 */
function locatePackageFile(pkgName: string, file: string): string | null {
  // 生产/打包：Electron 把 asarUnpack 的内容放到 resourcesPath/app.asar.unpacked
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkgName, file)
    if (fs.existsSync(unpacked)) return unpacked
  }
  // 开发/测试：从 __dirname 逐级向上找 node_modules/<pkg>/<file>
  let dir = path.resolve(__dirname)
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'node_modules', pkgName, file)
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 权限等忽略 */
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 是否可用的唯一解析器实例（惰性，首次成功加载后复用） */
interface AstState {
  /** web-tree-sitter 的动态解析器实例（类型不定，避免依赖其 ESM 类型定义） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parse: ((source: string) => any) | null
  /** 解析失败原因（用于诊断，不影响降级） */
  why: string
}

let state: AstState = { parse: null, why: '' }
let initPromise: Promise<void> | null = null

/**
 * 初始化 AST（只在需要时执行一次）。失败不抛，置为「不可用」。
 * 应用启动时应调用一次，确保首个命令分级不引入额外延迟。
 */
export async function initShellAst(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('web-tree-sitter')
      const Parser = mod.Parser
      const Language = mod.Language
      const wtsWasm = locatePackageFile('web-tree-sitter', 'web-tree-sitter.wasm')
      const bashWasm = locatePackageFile('tree-sitter-bash', 'tree-sitter-bash.wasm')
      if (!wtsWasm || !bashWasm) {
        throw new Error(`找不到 wasm：web-tree-sitter=${!!wtsWasm} tree-sitter-bash=${!!bashWasm}`)
      }
      await Parser.init({
        // locateFile 由 Parser.init 内部调用请求 web-tree-sitter.wasm，这里指向已定位的绝对路径
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        locateFile: (_p: string) => wtsWasm!
      })
      const lang = await Language.load(bashWasm!)
      const parser = new Parser()
      parser.setLanguage(lang)
      state = {
        parse: (source: string) => parser.parse(source),
        why: ''
      }
    } catch (err) {
      state = {
        parse: null,
        why: err instanceof Error ? err.message : String(err)
      }
      console.warn('[ast] bash 语法解析不可用，回退到正则分级：', state.why)
    }
  })()
  return initPromise
}

/** AST 是否已成功初始化 */
export function isAstReady(): boolean {
  return state.parse !== null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type TsNode = any

/** 递归收集所有担任「命令名」角色的 word 文本（command_name 子节点 / 顶层命令首词） */
function collectCommandNames(node: TsNode, out: string[]): void {
  if (node.type === 'command_name') {
    const w = node.namedChild(0) ?? node.ghostNode
    const text = (w && w.text) || node.text
    if (text) out.push(String(text).trim().split(/\s+/)[0])
  }
  for (const child of node.namedChildren ?? []) collectCommandNames(child, out)
}

/**
 * 分析一条命令是否存在「写成程序内容/嵌套结构」的危险形态。
 * 返回命中的危险原因；空数组表示无 AST 级信号（不改变既有判定）。
 */
export function analyzeAstDanger(command: string): string[] {
  if (!state.parse) return []
  let tree: TsNode
  try {
    tree = state.parse(command)
  } catch {
    return []
  }
  const root: TsNode = tree && tree.rootNode
  if (!root) return []

  const signals: string[] = []
  const stack: TsNode[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    const type = node.type
    // 写文件重定向（排除丢弃式 /dev/null、/dev/zero）
    if (type === 'file_redirect' || type === 'heredoc_redirect' || type === 'here_doc_redirect') {
      // 取重定向目标：file_redirect 的最后一个 word / heredoc 的 heredoc_body
      const redirectTarget = extractRedirectTarget(node)
      if (redirectTarget && !/^\/dev\/(null|zero|full)$/.test(redirectTarget)) {
        signals.push(`写文件重定向到 ${redirectTarget}`)
      }
    }
    // 命令替换 / 进程替换：内含任意命令
    if (type === 'command_substitution' || type === 'process_substitution') {
      signals.push('命令/进程替换')
    }
    // 命令拼接 / 管道：多条命令在一行（AST 的 list 结构），本身不必然危险，
    // 但若其内任一命令名命中威胁则已由上层处理，这里仅对「命令 + &&/||/; 拼接」标记，
    // 交给调用方结合既有分级决定（此处不主动升级，避免误伤正常管道）。
    for (const child of node.namedChildren ?? []) stack.push(child)
  }

  // 递归收集所有 command_name。仅对「命令名即高危程序」的**窄子集**做升级：
  // sudo / su / eval / source 作为命令名时，无论多嵌套都算高危（regex 只扫表层，
  // AST 能发现位于替换/拼接/循环内的这类命令名）。
  const commandNames: string[] = []
  collectCommandNames(root, commandNames)
  const ALWAYS_DANGEROUS_NAMES = new Set(['sudo', 'su', 'eval', '.', 'source'])
  for (const name of commandNames) {
    const base = name.split('/').pop() || name
    if (ALWAYS_DANGEROUS_NAMES.has(base)) {
      signals.push(`出现危险命令名 ${base}`)
      break
    }
  }

  // 去重
  return [...new Set(signals)]
}

function extractRedirectTarget(node: TsNode): string {
  // 目标通常是重定向节点里的 word / heredoc body 的文本
  const wordNodes: string[] = []
  const collect = (n: TsNode): void => {
    if (n.type === 'word') wordNodes.push(String(n.text || ''))
    if (n.type === 'heredoc_body') wordNodes.push(String(n.text || ''))
    for (const c of n.namedChildren ?? []) collect(c)
  }
  collect(node)
  // file_redirect 形式形如 '>' 或 '2>' + 两个 word-ish；取最后一个 word 作为真正目标
  const meaningful = wordNodes.filter((w) => !/^[\d<>]+$/.test(w))
  return meaningful.length ? meaningful[meaningful.length - 1] : ''
}