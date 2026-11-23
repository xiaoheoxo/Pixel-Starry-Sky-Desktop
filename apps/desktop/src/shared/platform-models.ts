import { ENGINES, type EngineId } from '@pixelsky/protocol'
import { speaksPi } from './provider-protocols'

/** 平台官方模型的请求协议。自定义接口可能做协议转换，不使用这条规则。 */
export function platformModelApi(model: string | null | undefined): 'messages' | 'responses' | null {
  const id = (model ?? '')
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/^(?:anthropic|openai)\./, '')
  if (id.startsWith('claude-')) return 'messages'
  if (/^(?:gpt-|chatgpt-|o\d+(?:-|$))/.test(id)) return 'responses'
  // 没有官方命名约定的模型继续按线路声明判断。
  return null
}

/** 线路支持一个引擎，不代表线路里每个模型都适合该引擎。 */
export function platformModelSupportsEngine(model: string | null | undefined, engine: EngineId): boolean {
  if (ENGINES[engine].wireApi === 'native') return false
  const api = platformModelApi(model)
  return speaksPi(engine) || api === null || api === ENGINES[engine].wireApi
}

/** 引擎自己的目录只保留兼容模型；全量目录仍用于跨引擎选择。 */
export function platformModelsForEngine<T extends { models: string[] }>(groups: T[], engine: EngineId): T[] {
  return groups.map(g => ({ ...g, models: g.models.filter(m => platformModelSupportsEngine(m, engine)) }))
}
