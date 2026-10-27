/**
 * Monaco Editor 本地化加载与 Worker 配置。
 *
 * @monaco-editor/react 默认从 CDN 加载 Monaco，在 CSP `default-src 'self'` 与
 * Electron 离线 / 打包环境下不可用。这里通过 loader.config 强制使用本地构建产物，
 * 并用 Vite 的 `?worker` 导入创建 Worker，避免 Monaco 内置的跨域 / blob worker 加载
 * 被 CSP 拦截。
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
// 通过相对路径引用 worker 文件，绕过 monaco-editor 的 package exports 映射，
// 让 Vite/Rolldown 能识别 `?worker` 查询参数（直接按包名导入会被 exports 解析拒绝）。
import EditorWorker from '../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker'

// 覆盖 Monaco 环境，全部语言统一使用基础 Editor Worker。
// （JSON / TS / CSS / HTML 专用 worker 需要额外注册，运维文本编辑以配置文件为主，
// 基础 worker 已覆盖语法高亮与基础编辑能力，省去多 worker 打包体积。）
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker()
  }
}

// 使用本地安装的 monaco-editor，关闭 @monaco-editor/react 的 CDN 加载
loader.config({ monaco })

export { monaco }