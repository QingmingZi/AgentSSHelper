import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { api } from '../api'
import type { AiConfigView } from '@shared/types'
import Modal from './Modal'

interface SettingsDialogProps {
  onClose: () => void
  /** 配置保存成功后回调，用于通知其它面板刷新 */
  onSaved?: () => void
}

interface SysInfo {
  version: string
  electron: string
  node: string
  platform: string
  dataDir: string
  keychain: string
}

export default function SettingsDialog({ onClose, onSaved }: SettingsDialogProps): ReactElement {
  const [config, setConfig] = useState<AiConfigView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [baiduKey, setBaiduKey] = useState('')
  const [baiduKeyTouched, setBaiduKeyTouched] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [info, setInfo] = useState<SysInfo | null>(null)
  const [saved, setSaved] = useState(false)
  /** 服务端返回的模型列表 */
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelHint, setModelHint] = useState<{ ok: boolean; text: string } | null>(null)
  /** 取列表的请求序号：地址变更后让在途请求的结果作废 */
  const modelRequestId = useRef(0)

  useEffect(() => {
    void api.ai.getConfig().then(setConfig)
    void api.system.info().then(setInfo)
  }, [])

  const update = <K extends keyof AiConfigView>(key: K, value: AiConfigView[K]): void => {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  /** 把当前表单内容写入主进程配置 */
  const persist = async (): Promise<void> => {
    if (!config) return
    await api.ai.setConfig({
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      autoApproveSafeCommands: config.autoApproveSafeCommands,
      autoApproveModifyCommands: config.autoApproveModifyCommands,
      autoSubmitCommandResults: config.autoSubmitCommandResults,
      contextLines: config.contextLines,
      maxContextTokens: config.maxContextTokens,
      systemPrompt: config.systemPrompt,
      searchEnabled: config.searchEnabled
    })
    if (keyTouched) await api.ai.setApiKey(apiKey.trim() ? apiKey.trim() : undefined)
    if (baiduKeyTouched)
      await api.ai.setBaiduSearchKey(baiduKey.trim() ? baiduKey.trim() : undefined)
  }

  const save = async (): Promise<void> => {
    await persist()
    setSaved(true)
    onSaved?.()
    setTimeout(() => setSaved(false), 2000)
  }

  /**
   * 拉取服务端可用模型列表。
   * 用表单里当前的接口地址与 API Key（未填则回落到已保存的值），
   * 这样不必先保存就能取列表；失败时保留手填能力。
   */
  const loadModels = async (): Promise<void> => {
    if (!config) return
    const requestId = ++modelRequestId.current
    setLoadingModels(true)
    setModelHint(null)
    try {
      const typedKey = keyTouched ? apiKey.trim() : ''
      const result = await api.ai.listModels(config.baseUrl, typedKey || undefined)
      if (requestId !== modelRequestId.current) return
      if (result.ok) {
        setModelOptions(result.models)
        setModelHint({ ok: true, text: result.message })
        // 当前填写的模型若就在列表里，默认选中它
        setSelectedModel(result.models.includes(config.model) ? config.model : '')
      } else {
        setModelOptions([])
        setModelHint({
          ok: false,
          text: `获取模型列表失败：${result.message}。该服务可能不支持 /models 接口，可继续手动填写模型名称。`
        })
      }
    } catch (err) {
      if (requestId !== modelRequestId.current) return
      setModelOptions([])
      setModelHint({
        ok: false,
        text: `获取模型列表失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      if (requestId === modelRequestId.current) setLoadingModels(false)
    }
  }

  /**
   * 测试连接。
   * 先把表单里的当前值写入配置再测试，
   * 否则测的是上一次保存的旧配置，会出现「地址填对了却报
   * Failed to parse URL from /chat/completions」这种误导性结果。
   */
  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult('')
    try {
      await persist()
      const result = await api.ai.ping()
      setTestResult(
        result.ok
          ? `连接成功（${result.latencyMs} ms）`
          : `连接失败：${result.message}`
      )
    } catch (err) {
      setTestResult(`连接失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  return (
    <Modal onClose={onClose} wide>
      <h3>设置</h3>

        <h4 className="section-title">AI 运维</h4>
        {config && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => update('enabled', e.target.checked)}
              />
              <span>启用 AI 运维</span>
            </label>

            <label className="field">
              <span>接口地址（OpenAI 兼容）</span>
              <input
                value={config.baseUrl}
                onChange={(e) => {
                  update('baseUrl', e.target.value)
                  // 换了服务，之前拉到的模型列表就不再适用
                  modelRequestId.current += 1
                  setModelOptions([])
                  setSelectedModel('')
                  setModelHint(null)
                }}
                placeholder="https://api.openai.com/v1"
              />
              <small className="hint">
                支持 OpenAI、DeepSeek、Kimi、Qwen、通义等兼容 Chat Completions 的服务；未以 /v1 结尾会自动补全。
              </small>
            </label>

            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value)
                  setKeyTouched(true)
                }}
                placeholder={
                  config.hasApiKey
                    ? `已保存（${config.apiKeyPreview || '••••'}），留空表示不修改`
                    : 'sk-...'
                }
              />
              <small className="hint">API Key 使用系统密钥库加密后落盘，不会以明文保存。</small>
            </label>

            <div className="grid-2">
              <label className="field">
                <span>模型名称</span>
                <div className="inline-row">
                  <input
                    value={config.model}
                    onChange={(e) => {
                      const value = e.target.value
                      update('model', value)
                      setSelectedModel(modelOptions.includes(value) ? value : '')
                    }}
                    placeholder="gpt-4o-mini"
                  />
                  <button
                    className="btn ghost"
                    onClick={() => void loadModels()}
                    disabled={loadingModels}
                    title="从服务端拉取可用模型列表"
                  >
                    {loadingModels ? '获取中…' : '获取模型列表'}
                  </button>
                </div>
                {modelOptions.length > 0 && (
                  <div className="inline-row">
                    <select
                      className="model-select"
                      value={selectedModel}
                      onChange={(e) => {
                        setSelectedModel(e.target.value)
                        if (e.target.value) update('model', e.target.value)
                      }}
                    >
                      <option value="">从列表中选择…</option>
                      {modelOptions.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                    <span className="hint">共 {modelOptions.length} 个</span>
                  </div>
                )}
                {modelHint && (
                  <small className={modelHint.ok ? 'hint' : 'hint error-text'}>
                    {modelHint.text}
                  </small>
                )}
              </label>
              <label className="field">
                <span>最大输出 token</span>
                <input
                  type="number"
                  value={config.maxTokens}
                  onChange={(e) => update('maxTokens', Number(e.target.value) || 2048)}
                  min={128}
                  max={32768}
                />
              </label>
              <label className="field">
                <span>温度</span>
                <input
                  type="number"
                  step="0.1"
                  value={config.temperature}
                  onChange={(e) => update('temperature', Number(e.target.value))}
                  min={0}
                  max={2}
                />
              </label>
              <label className="field">
                <span>终端上下文行数</span>
                <input
                  type="number"
                  value={config.contextLines}
                  onChange={(e) => update('contextLines', Number(e.target.value) || 60)}
                  min={0}
                  max={500}
                />
              </label>
              <label className="field">
                <span>最大上下文 token</span>
                <input
                  type="number"
                  value={config.maxContextTokens}
                  onChange={(e) =>
                    update('maxContextTokens', Number(e.target.value) || 256 * 1024)
                  }
                  min={1024}
                  max={4_000_000}
                  step={1024}
                />
                <small className="hint">
                  默认 262144（256k）。用于请求前裁剪历史与展示上下文占用，不会作为参数发给服务端。
                </small>
              </label>
            </div>

            <label className="field">
              <span>自定义系统提示词（留空使用内置运维提示词）</span>
              <textarea
                rows={4}
                value={config.systemPrompt ?? ''}
                onChange={(e) => update('systemPrompt', e.target.value)}
                placeholder="例如：只关注 Java 服务与数据库，不要改动 nginx 配置"
              />
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.searchEnabled}
                onChange={(e) => update('searchEnabled', e.target.checked)}
              />
              <span>
                启用联网搜索增强（百度搜索）
                <small className="hint">
                  开启后，当提问需要检索最新资料（版本、漏洞、配置、文档等）时，会自动调用百度搜索获取摘要注入上下文，再生成回答；命中检索的回复会标记「已联网检索」。
                </small>
              </span>
            </label>

            {config.searchEnabled && (
              <div className="search-quota-box">
                <label className="field">
                  <span>百度搜索 API Key</span>
                  <input
                    type="password"
                    value={baiduKey}
                    onChange={(e) => {
                      setBaiduKey(e.target.value)
                      setBaiduKeyTouched(true)
                    }}
                    placeholder={
                      config.hasBaiduSearchKey
                        ? `已保存（${config.baiduSearchKeyPreview || '••••'}），留空表示不修改`
                        : '百度智能云千帆 / AppBuilder API Key'
                    }
                  />
                  <small className="hint">
                    用于调用百度 AI 搜索（qianfan.baidubce.com）。免费额度约每月 1500 次。使用系统密钥库加密存储。
                  </small>
                </label>
                <div className="quota-grid">
                  <div className="quota-item">
                    <span>今日用量</span>
                    <strong>
                      {config.searchQuota.dailyUsed} / {config.searchQuota.dailyLimit}
                    </strong>
                    <div className="quota-bar">
                      <i
                        style={{
                          width: `${Math.min(100, Math.round(config.searchQuota.dailyRatio * 100))}%`
                        }}
                      />
                    </div>
                  </div>
                  <div className="quota-item">
                    <span>本月用量</span>
                    <strong>
                      {config.searchQuota.monthlyUsed} / {config.searchQuota.monthlyLimit}
                    </strong>
                    <div className="quota-bar">
                      <i
                        style={{
                          width: `${Math.min(100, Math.round(config.searchQuota.monthlyRatio * 100))}%`
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.autoApproveModifyCommands}
                onChange={(e) => update('autoApproveModifyCommands', e.target.checked)}
              />
              <span>
                修改 / 删除类命令免确认自动执行
                <small className="hint">
                  默认关闭：修改与删除类命令一律需要人工确认。开启后不再询问，请自行评估风险。
                </small>
              </span>
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={config.autoSubmitCommandResults}
                onChange={(e) => update('autoSubmitCommandResults', e.target.checked)}
              />
              <span>
                命令执行结果自动回传给 AI
                <small className="hint">
                  开启后命令执行完会自动把结果交给 AI 继续分析，不用手动点「把结果交给 AI」。
                  默认关闭；自动回传会连续消耗 token，单轮最多自动回传 3 次以防循环。
                </small>
              </span>
            </label>

            <div className="inline-row">
              <button className="btn ghost" onClick={() => void test()} disabled={testing}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              {testResult && <span className={testResult.startsWith('连接成功') ? 'success-text' : 'error-text'}>{testResult}</span>}
              <small className="hint">测试连接会先保存当前填写的内容，再按保存后的配置发起请求。</small>
            </div>
          </>
        )}

        <h4 className="section-title">关于</h4>
        {info && (
          <ul className="about-list">
            <li>
              <span>版本</span>
              <code>
                {info.version} · Electron {info.electron} · Node {info.node}
              </code>
            </li>
            <li>
              <span>凭据加密后端</span>
              <code>{info.keychain}</code>
            </li>
            <li>
              <span>配置目录</span>
              <code>{info.dataDir}</code>
            </li>
          </ul>
        )}
        {info?.keychain.includes('降级') && (
          <div className="security-warning" role="alert">
            ⚠ 安全提示：当前环境缺少系统密钥库（Windows DPAPI / macOS Keychain / Linux keyring），
            API Key 与 SSH 口令使用本地派生密钥加密，强度弱于系统密钥库。请优先在装有系统密钥环的桌面环境使用。
            <span className="detail">{info.keychain}</span>
          </div>
        )}

        <div className="modal-actions">
          {saved && <span className="success-text">已保存</span>}
          <div className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={() => void save()}>
            保存
          </button>
        </div>
    </Modal>
  )
}
