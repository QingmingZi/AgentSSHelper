import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IPC } from '@shared/types'

type Unsubscribe = () => void

/** 允许订阅的事件通道白名单 */
const ALLOWED_CHANNELS = new Set<string>(Object.values(IPC))

const api = {
  profiles: {
    list: (): Promise<unknown> => ipcRenderer.invoke('profiles:list'),
    create: (input: unknown): Promise<unknown> => ipcRenderer.invoke('profiles:create', input),
    update: (id: string, patch: unknown): Promise<unknown> =>
      ipcRenderer.invoke('profiles:update', id, patch),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke('profiles:remove', id),
    setSecret: (id: string, kind: 'password' | 'passphrase', value?: string): Promise<boolean> =>
      ipcRenderer.invoke('profiles:setSecret', id, kind, value),
    hasSecret: (id: string, kind: 'password' | 'passphrase'): Promise<boolean> =>
      ipcRenderer.invoke('profiles:hasSecret', id, kind),
    pickKeyFile: (): Promise<string | null> => ipcRenderer.invoke('profiles:pickKeyFile')
  },

  ssh: {
    connect: (
      profileId: string,
      credentials?: { password?: string; passphrase?: string; trustNewHost?: boolean }
    ): Promise<unknown> => ipcRenderer.invoke('ssh:connect', profileId, credentials),
    disconnect: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('ssh:disconnect', sessionId),
    sessions: (): Promise<unknown> => ipcRenderer.invoke('ssh:sessions'),
    exec: (
      sessionId: string,
      command: string,
      options?: { sudo?: boolean; timeout?: number }
    ): Promise<unknown> => ipcRenderer.invoke('ssh:exec', sessionId, command, options),
    shellStart: (
      sessionId: string,
      options?: { cols?: number; rows?: number; cwd?: string; autoSudoPassword?: boolean }
    ): Promise<boolean> => ipcRenderer.invoke('ssh:shellStart', sessionId, options),
    shellInput: (sessionId: string, data: string): void =>
      ipcRenderer.send('ssh:shellInput', sessionId, data),
    shellResize: (sessionId: string, cols: number, rows: number): void =>
      ipcRenderer.send('ssh:shellResize', sessionId, cols, rows),
    hostContext: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('ssh:hostContext', sessionId)
  },

  wsl: {
    list: (): Promise<{ available: boolean; distros: Array<{ name: string; isDefault: boolean; state: string; version: string }> }> =>
      ipcRenderer.invoke('wsl:list'),
    connect: (distro: string): Promise<{ sessionId: string; profileId: string }> =>
      ipcRenderer.invoke('wsl:connect', distro),
    disconnect: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('wsl:disconnect', sessionId)
  },

  sftp: {
    list: (sessionId: string, dir: string): Promise<unknown> =>
      ipcRenderer.invoke('sftp:list', sessionId, dir),
    stat: (sessionId: string, target: string): Promise<unknown> =>
      ipcRenderer.invoke('sftp:stat', sessionId, target),
    readText: (sessionId: string, target: string): Promise<{ content: string; size: number }> =>
      ipcRenderer.invoke('sftp:readText', sessionId, target),
    writeText: (sessionId: string, target: string, content: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('sftp:writeText', sessionId, target, content)
  },

  transfer: {
    run: (options: {
      sessionId: string
      direction: 'upload' | 'download'
      source: string
      target: string
      recursive?: boolean
      overwrite?: boolean
      useNativeScp?: boolean
    }): Promise<{ taskId: string; ok: boolean; error?: string }> =>
      ipcRenderer.invoke('transfer:run', options),
    cancel: (taskId: string): Promise<boolean> => ipcRenderer.invoke('transfer:cancel', taskId)
  },

  ai: {
    getConfig: (): Promise<unknown> => ipcRenderer.invoke('ai:getConfig'),
    setConfig: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('ai:setConfig', patch),
    setApiKey: (value?: string): Promise<boolean> => ipcRenderer.invoke('ai:setApiKey', value),
    setBaiduSearchKey: (value?: string): Promise<boolean> =>
      ipcRenderer.invoke('ai:setBaiduSearchKey', value),
    ping: (): Promise<{ ok: boolean; message: string; latencyMs: number }> =>
      ipcRenderer.invoke('ai:ping'),
    /** 拉取服务端可用模型列表；baseUrl / apiKey 可传表单里尚未保存的值 */
    listModels: (
      baseUrl?: string,
      apiKey?: string
    ): Promise<{ ok: boolean; models: string[]; message: string }> =>
      ipcRenderer.invoke('ai:listModels', baseUrl, apiKey),
    chat: (sessionId: string, message: string, context?: string): Promise<unknown> =>
      ipcRenderer.invoke('ai:chat', sessionId, message, context),
    scan: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('ai:scan', sessionId),
    /**
     * 命令审批入口。
     * 渲染层无法直接执行命令，必须经此接口提交人工审批结果，
     * 由主进程校验命令是否处于待确认状态后才执行。
     */
    approveCommand: (commandId: string, approved: boolean): Promise<unknown> =>
      ipcRenderer.invoke('ai:approveCommand', commandId, approved),
    /** 批量审批：勾选多条命令后一次提交 */
    approveCommands: (commandIds: string[], approved: boolean): Promise<unknown> =>
      ipcRenderer.invoke('ai:approveCommands', commandIds, approved),
    continueWithResult: (
      sessionId: string,
      command: string,
      result: unknown
    ): Promise<unknown> => ipcRenderer.invoke('ai:continue', sessionId, command, result),
    /** 新会话：清空该会话在服务端的对话历史与上下文 */
    clearHistory: (sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('ai:clearHistory', sessionId),
    stop: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('ai:stop', sessionId),
    /** 停止正在执行的命令（类似 Ctrl+C） */
    stopCommand: (commandId: string): Promise<boolean> =>
      ipcRenderer.invoke('ai:stopCommand', commandId),
    /** 打开应用后按主机加载已保留的对话与命令历史（3 天内） */
    loadConversation: (profileKey: string): Promise<unknown> =>
      ipcRenderer.invoke('ai:loadConversation', profileKey)
  },

  system: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('system:pickDirectory'),
    pickFile: (): Promise<string | null> => ipcRenderer.invoke('system:pickFile'),
    openPath: (target: string): Promise<boolean> => ipcRenderer.invoke('system:openPath', target),
    revealPath: (target: string): Promise<boolean> => ipcRenderer.invoke('system:revealPath', target),
    info: (): Promise<unknown> => ipcRenderer.invoke('system:info'),
    homeDir: (): Promise<string> => ipcRenderer.invoke('system:homeDir'),
    /** 导出对话日志：主进程弹保存框，返回落盘路径或 null（用户取消） */
    exportConversation: (payload: { content: string; defaultPath: string }): Promise<string | null> =>
      ipcRenderer.invoke('conversation:export', payload)
  },

  /** 系统剪贴板访问（手工运维终端复制/黏贴） */
  clipboard: {
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:writeText', text)
  },

  /** 订阅主进程事件，返回取消订阅函数 */
  on: (channel: string, callback: (payload: unknown) => void): Unsubscribe => {
    if (!ALLOWED_CHANNELS.has(channel)) {
      console.warn(`[preload] 拒绝订阅未授权通道: ${channel}`)
      return () => undefined
    }
    const listener = (_event: IpcRendererEvent, payload: unknown): void => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('sshHelper', api)

export type SshHelperApi = typeof api
