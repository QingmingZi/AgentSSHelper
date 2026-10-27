import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { IPC, type AiConfig, type HostProfile } from '@shared/types'
import { Store, BAIDU_SEARCH_DAILY_LIMIT, BAIDU_SEARCH_MONTHLY_LIMIT } from './core/store'
import { SessionManager } from './ssh/manager'
import { AiOpsService } from './ai/ops'
import {
  downloadDirectory,
  downloadFile,
  listRemoteDir,
  readRemoteText,
  runNativeScp,
  statRemote,
  TransferRegistry,
  uploadDirectory,
  uploadFile,
  writeRemoteText
} from './ssh/transfer'

export function registerIpc(store: Store, sessions: SessionManager, ai: AiOpsService): void {
  const transfers = new TransferRegistry()

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }

  // AI 命令审批流：命令清单 -> 审批 -> 执行结果
  ai.on('commands', (records) => {
    broadcast(IPC.aiCommand, { commands: records })
  })

  // 长时命令（如 yum update）的实时进度
  ai.on('command-progress', (progress) => {
    broadcast(IPC.aiCommandProgress, progress)
  })

  ai.on('command-outcome', (outcome) => {
    broadcast(IPC.aiCommandResult, outcome)

    // 「命令结果自动回传」：执行完成后直接把结果交给 AI 继续分析。
    // 不设次数上限，AI 可以连续提出命令并自动分析结果；用户可随时点「停止」终止。
    const config = store.getAiConfig()
    if (!config.autoSubmitCommandResults) return
    if (outcome.rejected || !outcome.result) return
    // 用户点过「停止」：不再自动回传
    if (ai.isStopped(outcome.sessionId)) return
    void continueWithAi(outcome.sessionId, outcome.command, outcome.result)
  })

  // ----------------------------------------------------------- 主机配置

  ipcMain.handle('profiles:list', () => store.listProfiles())

  ipcMain.handle('profiles:create', (_e, input: Partial<HostProfile> & { host: string; username: string }) => {
    const profile = store.createProfile(input)
    return store.getProfile(profile.id)
  })

  ipcMain.handle('profiles:update', (_e, id: string, patch: Partial<HostProfile>) => {
    return store.updateProfile(id, patch)
  })

  ipcMain.handle('profiles:remove', (_e, id: string) => {
    sessions.close(id)
    store.removeProfile(id)
    return true
  })

  ipcMain.handle(
    'profiles:setSecret',
    async (_e, id: string, kind: 'password' | 'passphrase', value: string | undefined) => {
      if (value) {
        await store.setProfileSecret(id, kind, value)
      } else {
        const profile = store.getProfile(id)
        const key = kind === 'password' ? profile?.passwordSecretKey : profile?.passphraseSecretKey
        if (key) store.vault.remove(key)
        store.updateProfile(id, {
          [kind === 'password' ? 'passwordSecretKey' : 'passphraseSecretKey']: undefined
        } as Partial<HostProfile>)
      }
      return true
    }
  )

  ipcMain.handle('profiles:hasSecret', (_e, id: string, kind: 'password' | 'passphrase') => {
    const profile = store.getProfile(id)
    if (!profile) return false
    const key = kind === 'password' ? profile.passwordSecretKey : profile.passphraseSecretKey
    return Boolean(key && store.vault.has(key))
  })

  ipcMain.handle('profiles:pickKeyFile', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 SSH 私钥文件',
      properties: ['openFile'],
      filters: [{ name: '私钥文件', extensions: ['pem', 'key', 'ppk', 'id_rsa', 'id_ed25519', 'id_ecdsa', '*'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  // --------------------------------------------------------------- SSH

  ipcMain.handle('ssh:connect', async (_e, profileId: string, credentials?: { password?: string; passphrase?: string; trustNewHost?: boolean }) => {
    return sessions.connect(profileId, credentials ?? {}, { trustNewHost: credentials?.trustNewHost })
  })

  ipcMain.handle('ssh:disconnect', (_e, sessionId: string) => {
    sessions.close(sessionId)
    ai.clearHistory(sessionId)
    ai.clearPending(sessionId)
    return true
  })

  ipcMain.handle('ssh:sessions', () => sessions.list())

  ipcMain.handle('ssh:exec', (_e, sessionId: string, command: string, options?: { sudo?: boolean; timeout?: number }) => {
    return sessions.get(sessionId).exec(command, options ?? {})
  })

  ipcMain.handle('ssh:shellStart', async (_e, sessionId: string, options?: { cols?: number; rows?: number; cwd?: string; autoSudoPassword?: boolean }) => {
    await sessions.get(sessionId).startShell(options ?? {})
    return true
  })

  ipcMain.on('ssh:shellInput', (_e, sessionId: string, data: string) => {
    try {
      sessions.get(sessionId).write(data)
    } catch {
      /* 会话可能已关闭 */
    }
  })

  ipcMain.on('ssh:shellResize', (_e, sessionId: string, cols: number, rows: number) => {
    try {
      sessions.get(sessionId).resize(cols, rows)
    } catch {
      /* ignore */
    }
  })

  ipcMain.handle('ssh:hostContext', async (_e, sessionId: string) => {
    return ai.collectHostContext(sessionId)
  })

  // ------------------------------------------------------------- SFTP

  ipcMain.handle('sftp:list', async (_e, sessionId: string, dir: string) => {
    const sftp = await sessions.get(sessionId).sftp()
    return listRemoteDir(sftp, dir || '.')
  })

  ipcMain.handle('sftp:stat', async (_e, sessionId: string, target: string) => {
    const sftp = await sessions.get(sessionId).sftp()
    return statRemote(sftp, target)
  })

  // 读取远端文本文件内容（用于在线编辑）
  ipcMain.handle('sftp:readText', async (_e, sessionId: string, target: string) => {
    const sftp = await sessions.get(sessionId).sftp()
    return readRemoteText(sftp, target)
  })

  // 将编辑后的文本写回远端文件
  ipcMain.handle('sftp:writeText', async (_e, sessionId: string, target: string, content: string) => {
    const sftp = await sessions.get(sessionId).sftp()
    await writeRemoteText(sftp, target, content)
    return { ok: true }
  })

  // ----------------------------------------------------------- 文件传输

  ipcMain.handle(
    'transfer:run',
    async (
      _e,
      options: {
        sessionId: string
        direction: 'upload' | 'download'
        source: string
        target: string
        recursive?: boolean
        overwrite?: boolean
        useNativeScp?: boolean
      }
    ) => {
      const taskId = randomUUID()
      const controller = transfers.create(taskId)
      const session = sessions.get(options.sessionId)
      const profile = session.profile

      const onProgress = (p: unknown): void => {
        broadcast(IPC.transferProgress, { taskId, ...(p as object) })
      }

      try {
        if (options.useNativeScp) {
          if (profile.authType !== 'privateKey' || !profile.privateKeyPath) {
            throw new Error('系统 scp 仅支持私钥认证，请先为该主机配置私钥')
          }
          const result = await runNativeScp({
            host: profile.host,
            port: profile.port,
            username: profile.username,
            privateKeyPath: profile.privateKeyPath,
            direction: options.direction,
            source: options.source,
            target: options.target,
            recursive: options.recursive,
            signal: controller.signal,
            onOutput: (chunk) => onProgress({ taskId, sessionId: options.sessionId, direction: options.direction, source: options.source, target: options.target, transferredBytes: 0, totalBytes: 0, currentFile: chunk.trim().slice(0, 200) })
          })
          if (result.code !== 0) throw new Error(result.stderr.trim() || `scp 退出码 ${result.code}`)
        } else {
          const sftp = await session.sftp()
          const overwrite = options.overwrite ?? true
          if (options.direction === 'upload') {
            const isDir = fs.statSync(options.source).isDirectory()
            if (isDir) {
              await uploadDirectory(sftp, options.source, options.target, taskId, options.sessionId, onProgress, controller.signal, overwrite)
            } else {
              await uploadFile(sftp, options.source, options.target, taskId, options.sessionId, onProgress, controller.signal, overwrite)
            }
          } else {
            const stat = await statRemote(sftp, options.source)
            if (stat?.type === 'directory') {
              await downloadDirectory(sftp, options.source, options.target, taskId, options.sessionId, onProgress, controller.signal, overwrite)
            } else {
              await downloadFile(sftp, options.source, options.target, taskId, options.sessionId, onProgress, controller.signal, overwrite)
            }
          }
        }

        broadcast(IPC.transferDone, { taskId, sessionId: options.sessionId, status: 'done' })
        return { taskId, ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const status = controller.signal.aborted ? 'canceled' : 'error'
        broadcast(IPC.transferDone, { taskId, sessionId: options.sessionId, status, error: message })
        return { taskId, ok: false, error: message }
      } finally {
        transfers.release(taskId)
      }
    }
  )

  ipcMain.handle('transfer:cancel', (_e, taskId: string) => transfers.cancel(taskId))

  // --------------------------------------------------------------- AI

  ipcMain.handle('ai:getConfig', async () => {
    const config = store.getAiConfig()
    const { dailyUsed, monthlyUsed } = store.getSearchQuota()
    return {
      ...config,
      hasApiKey: Boolean(await store.getAiApiKey()),
      apiKeyPreview: await store.vault.preview(config.apiKeySecretKey ?? 'ai:apiKey'),
      hasBaiduSearchKey: Boolean(await store.getBaiduSearchKey()),
      baiduSearchKeyPreview: await store.vault.preview(
        config.baiduSearchKeySecretKey ?? 'ai:baiduSearchKey'
      ),
      searchQuota: {
        dailyUsed,
        dailyLimit: BAIDU_SEARCH_DAILY_LIMIT,
        monthlyUsed,
        monthlyLimit: BAIDU_SEARCH_MONTHLY_LIMIT,
        dailyRatio: dailyUsed / BAIDU_SEARCH_DAILY_LIMIT,
        monthlyRatio: monthlyUsed / BAIDU_SEARCH_MONTHLY_LIMIT
      }
    }
  })

  ipcMain.handle('ai:setConfig', (_e, patch: Partial<AiConfig>) => store.setAiConfig(patch))

  ipcMain.handle('ai:setApiKey', async (_e, value: string | undefined) => {
    await store.setAiApiKey(value)
    return true
  })

  ipcMain.handle('ai:setBaiduSearchKey', async (_e, value: string | undefined) => {
    await store.setBaiduSearchKey(value)
    return true
  })

  ipcMain.handle('ai:ping', async () => {
    const config = store.getAiConfig()
    const apiKey = (await store.getAiApiKey()) ?? ''
    const { AiClient } = await import('./ai/client')
    return new AiClient(config, apiKey).ping()
  })

  /**
   * 拉取服务端可用模型列表。
   * 允许渲染层传入表单里尚未保存的接口地址与 API Key，
   * 这样用户不必先保存就能直接取模型列表。
   */
  ipcMain.handle('ai:listModels', async (_e, baseUrl?: string, apiKey?: string) => {
    const stored = store.getAiConfig()
    const config = { ...stored, baseUrl: (baseUrl ?? '').trim() || stored.baseUrl }
    const typedKey = (apiKey ?? '').trim()
    const key = typedKey || ((await store.getAiApiKey()) ?? '')
    const { AiClient } = await import('./ai/client')
    return new AiClient(config, key).listModels()
  })

  /**
   * 把命令执行结果回传给 AI 继续分析。
   * 手动点击「把结果交给 AI」与「结果自动回传」开关走同一条通道。
   */
  const continueWithAi = async (
    sessionId: string,
    command: string,
    result: unknown
  ): Promise<string> => {
    // 已停止的会话不再发起回传，避免界面一直停在「思考中」
    if (ai.isStopped(sessionId)) return ''
    const messageId = randomUUID()
    broadcast(IPC.aiDelta, { sessionId, messageId, delta: '' })
    await ai.continueWithResult(sessionId, command, result as never, {
      onDelta: (delta) => broadcast(IPC.aiDelta, { sessionId, messageId, delta }),
      onFirstToken: (firstTokenMs) =>
        broadcast(IPC.aiMetrics, { sessionId, messageId, firstTokenMs }),
      onCommand: (commands) => {
        void ai.dispatchCommands(sessionId, messageId, commands)
      },
      onDone: (full, metrics) =>
        broadcast(IPC.aiDone, { sessionId, messageId, content: full, metrics }),
      onError: (err) => broadcast(IPC.aiError, { sessionId, messageId, error: err.message })
    })
    return messageId
  }

  ipcMain.handle('ai:chat', async (_e, sessionId: string, message: string, context?: string) => {
    const messageId = randomUUID()
    broadcast(IPC.aiDelta, { sessionId, messageId, delta: '' })
    await ai.chat(sessionId, message, {
      context,
      onDelta: (delta) => broadcast(IPC.aiDelta, { sessionId, messageId, delta }),
      onFirstToken: (firstTokenMs) =>
        broadcast(IPC.aiMetrics, { sessionId, messageId, firstTokenMs }),
      onCommand: (commands) => {
        // 派发到审批流程：主进程按风险等级决定自动执行或等待用户确认
        void ai.dispatchCommands(sessionId, messageId, commands)
      },
      onDone: (full, metrics) =>
        broadcast(IPC.aiDone, { sessionId, messageId, content: full, metrics }),
      onError: (err) => broadcast(IPC.aiError, { sessionId, messageId, error: err.message }),
      onSearched: (keyword) =>
        broadcast(IPC.aiSearchAttached, { sessionId, messageId, keyword })
    })
    return { messageId }
  })

  ipcMain.handle('ai:continue', async (_e, sessionId: string, command: string, result: unknown) => {
    // 手动回传视为用户发起的新一轮，解除之前的「停止」
    ai.resume(sessionId)
    const messageId = await continueWithAi(sessionId, command, result)
    return { messageId }
  })

  // 新会话：清空该会话在服务端的对话历史与上下文，让下一轮从全新上下文开始
  ipcMain.handle('ai:clearHistory', (_e, sessionId: string) => {
    ai.clearHistory(sessionId)
    return { ok: true }
  })

  ipcMain.handle('ai:scan', async (_e, sessionId: string) => {
    const messageId = randomUUID()
    broadcast(IPC.aiDelta, { sessionId, messageId, delta: '' })
    await ai.scan(sessionId, {
      onDelta: (delta) => broadcast(IPC.aiDelta, { sessionId, messageId, delta }),
      onFirstToken: (firstTokenMs) =>
        broadcast(IPC.aiMetrics, { sessionId, messageId, firstTokenMs }),
      onDone: (full, metrics) =>
        broadcast(IPC.aiDone, { sessionId, messageId, content: full, metrics }),
      onError: (err) => broadcast(IPC.aiError, { sessionId, messageId, error: err.message })
    })
    return { messageId }
  })

  ipcMain.handle('ai:approveCommand', async (_e, commandId: string, approved: boolean) => {
    try {
      return await ai.approveCommand(commandId, approved)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      broadcast(IPC.toast, { level: 'error', message })
      throw err
    }
  })

  // 批量审批：勾选多条命令后一次提交，按顺序执行
  ipcMain.handle('ai:approveCommands', async (_e, commandIds: string[], approved: boolean) => {
    return await ai.approveCommands(commandIds, approved)
  })

  ipcMain.handle('ai:stop', (_e, sessionId: string) => {
    ai.stop(sessionId)
    return true
  })

  // 停止正在执行的命令（类似 Ctrl+C）
  ipcMain.handle('ai:stopCommand', (_e, commandId: string) => {
    return ai.stopCommand(commandId)
  })

  // ------------------------------------------------------------ 系统

  // 导出对话日志：渲染层拼好内容，主进程弹保存框落盘
  ipcMain.handle(
    'conversation:export',
    async (_e, payload: { content: string; defaultPath: string }): Promise<string | null> => {
      const { content, defaultPath } = payload ?? {}
      if (typeof content !== 'string' || !content.trim()) throw new Error('无可导出的对话内容')
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const result = await dialog.showSaveDialog(win, {
        title: '导出对话日志',
        defaultPath,
        filters: [
          { name: 'Markdown 文档', extensions: ['md'] },
          { name: '纯文本', extensions: ['txt'] }
        ]
      })
      if (result.canceled || !result.filePath) return null
      await fs.promises.writeFile(result.filePath, content, 'utf8')
      return result.filePath
    }
  )

  ipcMain.handle('system:pickDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('system:pickFile', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('system:openPath', async (_e, target: string) => {
    if (!target) return false
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return true
  })

  ipcMain.handle('system:revealPath', (_e, target: string) => {
    shell.showItemInFolder(target)
    return true
  })

  ipcMain.handle('system:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    dataDir: app.getPath('userData'),
    sshAuthSock: process.env.SSH_AUTH_SOCK ?? '未设置',
    keychain: (await store.vault.backend()) === 'system' ? '系统密钥库' : '本地派生密钥（降级模式）'
  }))

  ipcMain.handle('system:homeDir', () => app.getPath('home'))

  ipcMain.handle('system:sep', () => path.sep)
}
