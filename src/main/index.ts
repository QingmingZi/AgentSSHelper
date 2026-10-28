import { app, BrowserWindow, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'

// 允许把用户数据目录重定向到别处（UI 回归/测试用）。
// 默认情况下 electron 的应用数据在 %APPDATA%/<name>，UI 测试预置的模拟配置
// 会直接覆盖真实配置，导致「ai 配置每次测试/更新后丢失」。
// 通过过程.env.SSHELPER_USER_DATA 指向一个隔离目录，即可避免污染真实数据。
// Windows 下必须在 app 事件之前设置，否则 app.getPath('userData') 已经确定。
const testUserData = process.env.SSHELPER_USER_DATA
if (testUserData) {
  app.setPath('userData', path.resolve(testUserData))
}

import { Store } from './core/store'
import { SessionManager } from './ssh/manager'
import { AiOpsService } from './ai/ops'
import { SystemUsageMonitor } from './ssh/monitor'
import { registerIpc } from './ipc'
import { IPC } from '@shared/types'

let mainWindow: BrowserWindow | null = null

/**
 * 安装应用菜单。
 *
 * Electron 默认菜单有两个隐患，这里显式改掉：
 *  1. 「关闭窗口」默认绑定 Ctrl+W、「退出」默认绑定 Ctrl+Q，
 *     误触这些加速键会直接结束整个应用（正在编辑的配置窗口会一并消失）；
 *  2. 「复制 / 剪切」默认绑定 Ctrl+C / Ctrl+X，会抢走页面按键，
 *     终端里的 Ctrl+C（中断信号）就发不出去了。
 *
 * 因此：复制 / 剪切 / 撤销 / 重做 / 全选 / 最小化一律交还给页面（registerAccelerator: false），
 * 会关闭窗口的菜单项不绑定任何加速键。
 * 粘贴保留 Ctrl+V 加速键：原生菜单栏获得焦点时（Alt 或 F10），
 * 只有菜单加速键还能把文本送进输入框，注销后粘贴会失效。
 */
function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [{ label: '退出', role: 'quit', registerAccelerator: false }]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo', registerAccelerator: false },
        { label: '重做', role: 'redo', registerAccelerator: false },
        { type: 'separator' },
        { label: '剪切', role: 'cut', registerAccelerator: false },
        { label: '复制', role: 'copy', registerAccelerator: false },
        // 粘贴保留默认的 Ctrl+V 加速键（菜单栏获得焦点时也要能粘贴）
        { label: '粘贴', role: 'paste' },
        { label: '删除', role: 'delete', registerAccelerator: false },
        { type: 'separator' },
        { label: '全选', role: 'selectAll', registerAccelerator: false }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload', accelerator: 'Ctrl+Shift+R' },
        { label: '开发者工具', role: 'toggleDevTools', accelerator: 'F12' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom', accelerator: 'Ctrl+0' },
        { label: '放大', role: 'zoomIn', accelerator: 'Ctrl+=' },
        { label: '缩小', role: 'zoomOut', accelerator: 'Ctrl+-' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen', accelerator: 'F11' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        // 最小化同样不注册加速键：Ctrl+M 在输入框里应当输入字母 m
        { label: '最小化', role: 'minimize', registerAccelerator: false },
        { label: '关闭窗口', role: 'close', registerAccelerator: false }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0f1116',
    title: 'AgentSSHelper',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // 开启 Electron 沙箱：preload 仅使用 electron 模块，沙箱下完全可用。
      // 关闭沙箱会增加渲染进程被攻破后的本地影响面。
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  const webContents = mainWindow.webContents
  // 仅允许用系统浏览器打开 http/https/mailto 链接，其余协议一律拦截，
  // 防止恶意链接使用 smb://、file://、自定义协议触发系统操作或泄露凭据。
  const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
  webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (!SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) {
        console.warn(`[index] 拦截非白名单协议的外部链接：${parsed.protocol}`)
        return { action: 'deny' }
      }
      void shell.openExternal(url)
    } catch {
      // URL 解析失败也拦截
    }
    return { action: 'deny' }
  })

  // 拦截窗口自身导航到任意远程页面，避免下载 XSS/钓鱼。
  webContents.on('will-navigate', (event, url) => {
    const allowed =
      process.env.ELECTRON_RENDERER_URL != null && url.startsWith(process.env.ELECTRON_RENDERER_URL)
    if (!allowed) event.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void webContents.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void webContents.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  installApplicationMenu()

  const store = new Store()
  const sessions = new SessionManager(store)
  const ai = new AiOpsService(store, sessions)

  registerIpc(store, sessions, ai)

  // 服务器实时资源占用（CPU / 内存）周期采样并广播
  const usageMonitor = new SystemUsageMonitor(sessions, 2_000)
  usageMonitor.on('usage', (usage) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.systemUsage, usage)
    }
  })
  usageMonitor.start()

  // 会话事件 -> 渲染层
  sessions.on('data', (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.sshData, payload)
    }
  })
  sessions.on('status', (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.sshStatus, payload)
    }
  })
  sessions.on('closed', (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.sshExit, payload)
    }
  })
  sessions.on('shell-close', (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.sshExit, { ...payload, reason: 'shell-close' })
    }
  })
  sessions.on('session-error', (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.toast, { level: 'error', message: payload.message })
    }
  })
  sessions.on('notice', (payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.toast, payload)
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // 断开所有会话，避免残留 SSH 进程
})
