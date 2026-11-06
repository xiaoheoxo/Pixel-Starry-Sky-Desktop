import { EFFORTS, type EngineCatalog, type EngineModel, type Effort } from '@pixelsky/protocol'
import { describeError, logger } from '../log'
import { CodexProcess, array, object, string } from './process'

const log = logger('engine.codex')

export async function codexCatalog(proc: CodexProcess): Promise<EngineCatalog> {
  const models: EngineModel[] = []
  let cursor: string | null = null
  const seen = new Set<string>()
  do {
    const page = await proc.request('model/list', { cursor, limit: 100, includeHidden: false })
    for (const raw of array(page.data)) {
      const model = object(raw),
        id = string(model.model || model.id)
      if (!id) continue
      const efforts = array(model.supportedReasoningEfforts)
        .map(e => string(object(e).reasoningEffort))
        .filter((e): e is Effort => EFFORTS.includes(e as Effort))
      // Fast：新版在 serviceTiers 里列 priority（名字叫 Fast），老版只有 additionalSpeedTiers: ['fast']
      const tiers = array(model.serviceTiers).map(t => string(object(t).id))
      const fastTier = tiers.includes('priority')
        ? 'priority'
        : array(model.additionalSpeedTiers).map(string).includes('fast')
          ? 'fast'
          : undefined
      const defaultEffort = EFFORTS.includes(model.defaultReasoningEffort as Effort)
        ? (model.defaultReasoningEffort as Effort)
        : null
      models.push({
        id,
        label: string(model.displayName) || id,
        efforts,
        defaultEffort,
        inputModalities: array(model.inputModalities ?? ['text', 'image']).map(string),
        isDefault: model.isDefault === true,
        ...(fastTier ? { fastTier } : {}),
        ...(tiers.includes('ultrafast') ? { ultrafast: true } : {}),
      })
    }
    cursor = string(page.nextCursor) || null
    if (cursor && seen.has(cursor)) throw new Error('Codex model pagination repeated')
    if (cursor) seen.add(cursor)
  } while (cursor && seen.size < 20)
  const [auth, config] = await Promise.all([
    // 读账号要连 ChatGPT，网络慢时会超时（workspace routing discovery）；发消息不靠它，不能拖垮启动
    proc.request('account/read', { refreshToken: false }).catch(error => {
      log.warn('读不到 Codex 账号，账号类型暂时未知', { error: describeError(error) })
      return null
    }),
    proc.request('config/read', { includeLayers: false }),
  ])
  // undefined 是没读到，null 是读到了但没登录
  const authType = auth ? string(object(auth.account).type) || null : undefined
  const rateLimits =
    authType === 'chatgpt' ? await proc.request('account/rateLimits/read', {}, 8000).catch(() => null) : null
  return {
    outputStyles: [],
    currentOutputStyle: null,
    models,
    currentModel: string(object(config.config).model) || null,
    currentProvider: string(object(config.config).model_provider) || 'openai',
    authType,
    rateLimits,
  }
}
