import type {
  AiConfig,
  AiConfigView,
  CommandOutcome,
  CommandResult,
  HostProfile,
  RemoteFileEntry,
  SshStatus
} from '@shared/types'

export interface SshHelperApi {
  profiles: {
    list(): Promise<HostProfile[]>
    create(input: Partial<HostProfile> & { host: string; username: string }): Promise<HostProfile>
    update(id: string, patch: Partial<HostProfile>): Promise<HostProfile>
    remove(id: string): Promise<boolean>
    setSecret(id: string, kind: 'password' | 'passphrase', value?: string): Promise<boolean>
    hasSecret(id: string, kind: 'password' | 'passphrase'): Promise<boolean>
    pickKeyFile(): Promise<string | null>
  }
  ssh: {
    connect(
      profileId: string,
      credentials?: { password?: string; passphrase?: string; trustNewHost?: boolean }
    ): Promise<{ sessionId: string; profileId: string; fingerprint: string; keyType: string; serverVersion: string }>
    disconnect(sessionId: string): Promise<boolean>
    sessions(): Promise<Array<{ sessionId: string; profileId: string; label: string; host: string }>>
    exec(
      sessionId: string,
      command: string,
      options?: { sudo?: boolean; timeout?: number }
    ): Promise<CommandResult>
    shellStart(
      sessionId: string,
      options?: { cols?: number; rows?: number; cwd?: string; autoSudoPassword?: boolean }
    ): Promise<boolean>
    shellInput(sessionId: string, data: string): void
    shellResize(sessionId: string, cols: number, rows: number): void
    hostContext(sessionId: string): Promise<{
      label: string
      host: string
      port: number
      username: string
      osInfo: string
      workingDir: string
    }>
  }
  sftp: {
    list(sessionId: string, dir: string): Promise<RemoteFileEntry[]>
    stat(sessionId: string, target: string): Promise<RemoteFileEntry | null>
    readText(sessionId: string, target: string): Promise<{ content: string; size: number }>
    writeText(sessionId: string, target: string, content: string): Promise<{ ok: boolean }>
  }
  wsl: {
    list(): Promise<{
      available: boolean
      distros: Array<{ name: string; isDefault: boolean; state: string; version: string }>
    }>
    connect(distro: string): Promise<{ sessionId: string; profileId: string }>
    disconnect(sessionId: string): Promise<boolean>
  }
  transfer: {
    run(options: {
      sessionId: string
      direction: 'upload' | 'download'
      source: string
      target: string
      recursive?: boolean
      overwrite?: boolean
      useNativeScp?: boolean
    }): Promise<{ taskId: string; ok: boolean; error?: string }>
    cancel(taskId: string): Promise<boolean>
  }
  ai: {
    getConfig(): Promise<AiConfigView>
    setConfig(patch: Partial<AiConfig>): Promise<AiConfig>
    setApiKey(value?: string): Promise<boolean>
    setBaiduSearchKey(value?: string): Promise<boolean>
    ping(): Promise<{ ok: boolean; message: string; latencyMs: number }>
    /** 拉取服务端可用模型列表；baseUrl / apiKey 可传表单里尚未保存的值 */
    listModels(
      baseUrl?: string,
      apiKey?: string
    ): Promise<{ ok: boolean; models: string[]; message: string }>
    chat(sessionId: string, message: string, context?: string): Promise<{ messageId: string }>
    scan(sessionId: string): Promise<{ messageId: string }>
    /** 提交命令审批结果；渲染层无法直接执行命令 */
    approveCommand(commandId: string, approved: boolean): Promise<CommandOutcome | undefined>
    /** 批量审批多条待确认命令 */
    approveCommands(commandIds: string[], approved: boolean): Promise<CommandOutcome[]>
    continueWithResult(sessionId: string, command: string, result: CommandResult): Promise<unknown>
    /** 新会话：清空该会话在服务端的对话历史与上下文 */
    clearHistory(sessionId: string): Promise<{ ok: boolean }>
    stop(sessionId: string): Promise<boolean>
    stopCommand(commandId: string): Promise<boolean>
  }
  system: {
    pickDirectory(): Promise<string | null>
    pickFile(): Promise<string | null>
    openPath(target: string): Promise<boolean>
    revealPath(target: string): Promise<boolean>
    info(): Promise<{
      version: string
      electron: string
      node: string
      platform: string
      dataDir: string
      keychain: string
      sshAuthSock: string
    }>
    homeDir(): Promise<string>
    exportConversation(payload: { content: string; defaultPath: string }): Promise<string | null>
  }
  clipboard: {
    readText(): Promise<string>
    writeText(text: string): Promise<boolean>
  }
  on(channel: string, callback: (payload: any) => void): () => void
}

declare global {
  interface Window {
    sshHelper: SshHelperApi
  }
}

export interface SshStatusEvent extends SshStatus {}

export const api = window.sshHelper
