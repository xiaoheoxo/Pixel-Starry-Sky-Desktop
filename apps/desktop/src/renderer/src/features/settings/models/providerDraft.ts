// 自定义 API 对话框的草稿：关闭前比较「打开时的快照」和当前内容，有改动才需要确认
import type {
  ProviderAuth,
  ProviderModel,
  ProviderProtocol,
  ProviderTemplate,
} from '../../../../../shared/types/providers'

export interface ProviderDraft {
  template: ProviderTemplate
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  apiKey: string
  auth: ProviderAuth
  models: ProviderModel[]
  smallModel: string | null
  fallback: boolean
  headersText: string
}

/** 模型条目去掉 null / undefined 的字段并按键名排序：{id} 和 {id, contextWindow: null} 是同一个模型 */
const normalizeModels = (models: ProviderModel[]): string =>
  JSON.stringify(
    models.map(m =>
      Object.fromEntries(
        Object.entries(m)
          .filter(([, v]) => v !== null && v !== undefined)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      ),
    ),
  )

/** 关闭前要不要确认：草稿有改动、「新增模型」框里有字、上下文长度有认不出的值或还在输入框里没交出去的字 */
export function shouldConfirmClose(opts: {
  initial: ProviderDraft
  current: ProviderDraft
  newModel: string
  contextInvalid: boolean
  contextDirty: boolean
}): boolean {
  return (
    isProviderDraftDirty(opts.initial, opts.current) ||
    opts.newModel.trim() !== '' ||
    opts.contextInvalid ||
    opts.contextDirty
  )
}

/** 当前草稿和打开时的快照是否不同；Key 只看 trim 后有没有内容（和保存时一致） */
export function isProviderDraftDirty(initial: ProviderDraft, current: ProviderDraft): boolean {
  const { models: a, apiKey: ka, ...restA } = initial
  const { models: b, apiKey: kb, ...restB } = current
  if (ka.trim() !== kb.trim()) return true
  for (const key of Object.keys(restA) as (keyof typeof restA)[]) if (restA[key] !== restB[key]) return true
  return normalizeModels(a) !== normalizeModels(b)
}

/**
 * 保存前合上别处的改动：对话框开着时，同一个接口可能在另一个设置窗口里改过并保存了。
 * 这边没动过的字段换成最新的，动过的照用这边的，免得整份发出去把别处刚存的冲回旧值
 */
export function mergeLatest(initial: ProviderDraft, current: ProviderDraft, latest: ProviderDraft): ProviderDraft {
  const merged = { ...current }
  for (const key of Object.keys(current) as (keyof ProviderDraft)[]) {
    if (key === 'apiKey') continue
    const same =
      key === 'models'
        ? normalizeModels(initial.models) === normalizeModels(current.models)
        : initial[key] === current[key]
    if (same) Object.assign(merged, { [key]: latest[key] })
  }
  return merged
}
