// 设置 › 模型通道 › 菜单里显示的模型（docs/ui/menu-models.md 方案 A）：按厂商分组、旧版判断、显示名、默认窗口、新模型。纯函数
import { officialPrice } from '@pixelsky/protocol'

/** 分组顺序；图片模型（只在云端生图里用）放最后、默认折叠 */
export const VENDORS = ['claude', 'gpt', 'gemini', 'deepseek', 'other', 'image'] as const
export type Vendor = (typeof VENDORS)[number]

/** 模型属于哪一组：名字里有 image 的是图片模型；其余按前缀，认不出的按官方价格表的厂商 */
export function vendorOf(model: string): Vendor {
  const id = model.toLowerCase().replace(/^.*\//, '')
  if (/(^|-)image(-|$)/.test(id)) return 'image'
  if (id.startsWith('claude-')) return 'claude'
  if (/^(gpt-|chatgpt-|codex-|o\d+(-|$))/.test(id)) return 'gpt'
  if (id.startsWith('gemini-')) return 'gemini'
  if (id.startsWith('deepseek-')) return 'deepseek'
  const vendor = officialPrice(id)?.vendor
  return vendor === 'anthropic' ? 'claude' : vendor === 'openai' ? 'gpt' : vendor === 'google' ? 'gemini' : 'other'
}

/** 按组分好，组内保持原来的顺序；空组不出现 */
export function groupByVendor(models: readonly string[]): Array<{ vendor: Vendor; models: string[] }> {
  return VENDORS.map(vendor => ({ vendor, models: models.filter(m => vendorOf(m) === vendor) })).filter(
    g => g.models.length > 0,
  )
}

const DATE = /^\d{8}$/
const NUMBER = /^\d+(\.\d+)?$/

/** id → 产品线（去掉数字和日期，如 claude-opus、gpt-sol）和主版本号；没有数字的没有版本 */
function lineOf(model: string): { line: string; major: number | null } {
  const parts = model.toLowerCase().split('-')
  const words = parts.filter(p => !NUMBER.test(p) && !DATE.test(p))
  const numbers = parts.filter(p => NUMBER.test(p) && !DATE.test(p))
  return { line: words.join('-'), major: numbers.length ? Math.floor(Number(numbers[0])) : null }
}

/**
 * 旧版：同一条产品线里有更高主版本号的（claude-opus-4-8 有 claude-opus-5，gpt-5.6-sol 有 gpt-6-sol）。
 * 带日期但没有更新主版本的不算；没有版本号的（codex-auto-review）不算
 */
export function oldModels(models: readonly string[]): Set<string> {
  const top = new Map<string, number>()
  for (const m of models) {
    const { line, major } = lineOf(m)
    if (major !== null && major > (top.get(line) ?? -1)) top.set(line, major)
  }
  return new Set(
    models.filter(m => {
      const { line, major } = lineOf(m)
      return major !== null && major < (top.get(line) ?? major)
    }),
  )
}

const BRAND: Record<string, string> = {
  gpt: 'GPT',
  claude: 'Claude',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  codex: 'Codex',
  glm: 'GLM',
  kimi: 'Kimi',
  grok: 'Grok',
}

/**
 * 显示名（尽力而为）：claude-opus-4-5-20251101 → Claude Opus 4.5，gpt-6.1-sol → GPT-6.1 Sol，
 * gemini-4-carbon → Gemini 4 Carbon。去掉日期，相邻的数字用点连起来，单词首字母大写；GPT 和版本号连字符相连
 */
export function prettyModelName(model: string): string {
  const parts = model.split('-').filter(p => !DATE.test(p))
  const out: string[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    if (NUMBER.test(p) && prev !== undefined && /^\d+$/.test(prev)) out[out.length - 1] = `${prev}.${p}`
    else if (NUMBER.test(p) && prev === 'GPT') out[out.length - 1] = `GPT-${p}`
    else out.push(BRAND[p.toLowerCase()] ?? (/^[a-z]/.test(p) ? p[0]!.toUpperCase() + p.slice(1) : p))
  }
  return out.join(' ')
}

/** 官方价格表标的窗口（留空时灰字显示，仅供参考：引擎实际用自己知道的大小）；表里没有为 null */
export function defaultWindow(model: string): number | null {
  return officialPrice(model)?.contextWindow ?? null
}

/** 「新」标记：上次打开这一页时没见过的。从没记过（第一次打开）时一个都不算新，免得一片「新」 */
export function freshModels(models: readonly string[], seen: readonly string[] | null): Set<string> {
  if (seen === null) return new Set()
  const known = new Set(seen)
  return new Set(models.filter(m => !known.has(m)))
}

/** 组开关的状态：全显示 / 全隐藏 / 部分 */
export function groupState(models: readonly string[], hidden: readonly string[]): 'on' | 'off' | 'mixed' {
  const off = models.filter(m => hidden.includes(m)).length
  return off === 0 ? 'on' : off === models.length ? 'off' : 'mixed'
}
