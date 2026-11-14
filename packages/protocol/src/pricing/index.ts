// 按官方模型定价估算费用（docs/ui/custom-api.md §4.3）：自定义 API 的会话用，实际以接口账单为准
import type { ModelTurnUsage } from '../types'
import { OFFICIAL_PRICES } from './official'

export interface OfficialPrice {
  /** 价格表里的官方模型名 */
  model: string
  vendor: 'anthropic' | 'openai' | 'google'
  /** 美元 / 百万 token */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  contextWindow: number | null
}

const VENDOR_OF: Record<'a' | 'o' | 'g', OfficialPrice['vendor']> = {
  a: 'anthropic',
  o: 'openai',
  g: 'google',
}

/** Antigravity 编排器内部别名映射到对应基础计费模型 */
const MODEL_ALIASES: Record<string, string> = {
  'gemini-pro-orchestrator': 'gemini-4-carbon',
  'gemini-pro-orchestrator-argon': 'gemini-4-argon',
}

const price = (model: string): OfficialPrice | null => {
  const p = Object.prototype.hasOwnProperty.call(OFFICIAL_PRICES, model) ? OFFICIAL_PRICES[model] : undefined
  return p
    ? {
        model,
        vendor: VENDOR_OF[p[0]],
        input: p[1],
        output: p[2],
        cacheRead: p[3],
        cacheWrite: p[4],
        contextWindow: p[5],
      }
    : null
}

/** 去掉常见的前缀和后缀：anthropic/、openai/、google/、us.anthropic. 之类、-20250929 / -2025-08-07 日期、-thinking、[1m]、-latest */
function stripModel(model: string): string {
  let m = model.trim().toLowerCase()
  m = m.replace(/\[[^\]]*\]$/, '')
  m = m.replace(/^.*\//, '')
  m = m.replace(/^(?:[a-z]{2}\.)?(?:anthropic|openai|google|gemini)\./, '')
  m = m.replace(/(?:-v\d+)?(?::\d+)?$/, '')
  m = m.replace(/-thinking$/, '')
  m = m.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '')
  m = m.replace(/-latest$/, '')
  return m
}

/**
 * 去前后缀之后还对不上时再试的写法（规则参照 tern 的 pricing.rs，MIT）：
 * 版本号写成点（claude-sonnet-4.5 → claude-sonnet-4-5）；中转站给别家模型加的 claude- 前缀（claude-gpt-5 → gpt-5）；
 * Google preview / Antigravity 编排器别名
 */
function candidates(model: string): string[] {
  const m = stripModel(model)
  const out = [m, m.replace(/(\d)\.(\d)/g, '$1-$2')]
  const fake = m.match(/^claude-((?:gpt|o\d|chatgpt|codex)\b.*)$/)
  if (fake) out.push(fake[1])
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, m)) out.push(MODEL_ALIASES[m])
  if (m.startsWith('gemini-') && !m.endsWith('-preview')) out.push(`${m}-preview`)
  return out
}

const first = (names: string[]): OfficialPrice | null => {
  for (const m of names) {
    const p = price(m)
    if (p) return p
  }
  return null
}

/**
 * 模型对价格：先精确对、去掉前缀和后缀对，再用计价参照（ref），最后才换几种常见写法猜；都对不上返回 null（只显示 token）。
 */
export function officialPrice(model: string, ref?: string | null): OfficialPrice | null {
  if (!model && !ref) return null
  const name = model ? [model, stripModel(model)] : []
  const reference = ref ? [ref, stripModel(ref)] : []
  // 用户填的计价参照优先于猜出来的写法
  return first([...name, ...reference, ...(model ? candidates(model) : []), ...(ref ? candidates(ref) : [])])
}

/** 这一轮这个模型的估算费用（美元）；对不上价格时为 null */
export function estimateCost(
  usage: Pick<ModelTurnUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>,
  p: OfficialPrice | null,
): number | null {
  if (!p) return null
  const cost =
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheRead * p.cacheRead +
      usage.cacheWrite * p.cacheWrite) /
    1e6
  return Number.isFinite(cost) ? cost : null
}

/** 价格表里的官方模型名（设置页「计价参照」的选项），可按厂商筛 */
export function officialModels(vendor?: OfficialPrice['vendor']): string[] {
  return Object.keys(OFFICIAL_PRICES)
    .filter(m => !vendor || VENDOR_OF[OFFICIAL_PRICES[m][0]] === vendor)
    .filter(m => !/-\d{8}$|-\d{4}-\d{2}-\d{2}$/.test(m))
}
