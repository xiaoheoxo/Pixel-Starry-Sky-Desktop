#!/usr/bin/env node
// 生成官方模型价格表 packages/protocol/src/pricing/official.ts（docs/ui/custom-api.md §4.3）。
// 来源是 LiteLLM 格式的价格文件（和 Sub2api 用的同一种），只留 Anthropic、OpenAI 官方的对话 / Responses 模型。
// 用法：node scripts/update-official-pricing.mjs [文件路径或 URL]，默认取 LiteLLM 仓库的最新版。发版前跑一次。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const DEFAULT_SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'packages', 'protocol', 'src', 'pricing', 'official.ts')
const source = process.argv[2] ?? DEFAULT_SOURCE

const raw = /^https?:\/\//.test(source)
  ? await (async () => {
      const res = await fetch(source, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`下载失败：${res.status} ${source}`)
      return res.text()
    })()
  : readFileSync(source, 'utf8')
const data = JSON.parse(raw)

/** 每 token 美元 → 每百万 token 美元，去掉浮点尾巴 */
const perMillion = v =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Number((v * 1e6).toPrecision(6)) : null

const VENDORS = { anthropic: 'a', openai: 'o', gemini: 'g' }

const models = {}
for (const [name, v] of Object.entries(data)) {
  if (!v || typeof v !== 'object' || name === 'sample_spec') continue
  const vendor = VENDORS[v.litellm_provider]
  if (!vendor) continue
  if (v.mode !== 'chat' && v.mode !== 'responses') continue
  // Gemini 官方条目在 LiteLLM 里常带 gemini/ 前缀；去掉之后再挡掉其它带前缀/冒号的别名
  const key = vendor === 'g' && name.startsWith('gemini/') ? name.slice('gemini/'.length) : name
  if (key.includes('/') || key.includes(':')) continue
  const input = perMillion(v.input_cost_per_token),
    output = perMillion(v.output_cost_per_token)
  if (input === null || output === null) continue
  const cacheRead = perMillion(v.cache_read_input_token_cost) ?? input,
    cacheWrite = perMillion(v.cache_creation_input_token_cost) ?? input
  // 跳过官方标价全 0 的实验 / 免费模型（如 gemma、lyria、learnlm、gemini-exp-1114），否则用量会显示 $0 而不是「没有价格」
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) continue
  // 若既有裸名又有 gemini/ 别名，优先保留裸名
  if (key !== name && key in models) continue
  models[key] = [
    vendor,
    input,
    output,
    cacheRead,
    cacheWrite,
    typeof v.max_input_tokens === 'number' ? v.max_input_tokens : null,
  ]
}
const names = Object.keys(models).sort()
if (names.length < 20) throw new Error(`只找到 ${names.length} 个模型，来源文件可能不对：${source}`)

const body = names.map(n => `  ${JSON.stringify(n)}: ${JSON.stringify(models[n])},`).join('\n')
writeFileSync(
  out,
  `// 由 scripts/update-official-pricing.mjs 生成，不要手改。来源：${source}
// 生成日期：${new Date().toISOString().slice(0, 10)}；${names.length} 个模型
// 每项：[厂商 a=Anthropic o=OpenAI g=Google, 输入, 输出, 缓存读, 缓存写（美元 / 百万 token）, 上下文长度]
export const OFFICIAL_PRICES: Record<string, readonly ['a' | 'o' | 'g', number, number, number, number, number | null]> = {
${body}
}
`,
)
execFileSync(process.execPath, [join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs'), '--write', out], {
  stdio: 'ignore',
})
console.log(`已写入 ${out}：${names.length} 个模型`)
