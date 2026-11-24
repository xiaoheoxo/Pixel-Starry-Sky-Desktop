// 经本机网关用平台线路时给 omp 的扩展（-e 加载，docs/omp-engine.md §4）：从环境变量注册提供方，不改用户的 models.yml
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVIDERS_ENV } from '../pixel/session'

/**
 * 扩展源码。配置结构同 pixelModelsConfig（models.json 的 providers）；omp 的 apiKey 写环境变量名（不带 $），
 * 密钥只在环境变量里。模型缺的字段按 Pi 读 models.json 时的默认值补（同 packages/cli/src/extensions/gateway.ts modelDefaults）。
 * Claude 的思考档位照 omp 内置的同名模型写明：不写时 omp 按「不认识的 Anthropic 接口」给 minimal～xhigh，
 * Max 会被降档，Opus 4.6 这类没有 xhigh 的还会发出不支持的档（docs/omp-engine.md §16）
 */
export const OMP_GATEWAY_SOURCE = `// 像素星空写的文件，每次启动会覆盖。经本机网关用平台线路时注册 "pixelsky" 提供方
let builtin
try {
  builtin = (await import('@oh-my-pi/pi-catalog/models')).getBundledModel
} catch {
  // 拿不到内置目录：档位由 omp 自己推断
}
const thinkingOf = (api, id) => {
  if (api !== 'anthropic-messages') return undefined
  try {
    const thinking = builtin?.('anthropic', String(id).replace(/\\[1m\\]$/i, ''))?.thinking
    return thinking && { thinking }
  } catch {
    return undefined
  }
}
export default function pixelskyGateway(pi) {
  let providers
  try {
    providers = JSON.parse(process.env.${PROVIDERS_ENV} || '{}')
  } catch {
    console.error('${PROVIDERS_ENV} is not valid JSON; ignored')
    return
  }
  for (const [name, raw] of Object.entries(providers && typeof providers === 'object' ? providers : {})) {
    if (!raw || typeof raw !== 'object') continue
    const config = { ...raw }
    if (typeof config.apiKey === 'string') config.apiKey = config.apiKey.replace(/^\\$/, '')
    if (Array.isArray(config.models))
      config.models = config.models.map(m => ({
        name: m.id,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        ...thinkingOf(m.api ?? config.api, m.id),
        ...m,
      }))
    pi.registerProvider(name, config)
  }
}
`

/** 写到 dir 下（内容一样就不写），返回文件路径 */
export function writeOmpGateway(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'pixelsky-gateway.mjs')
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // 还没有
  }
  if (current !== OMP_GATEWAY_SOURCE) writeFileSync(file, OMP_GATEWAY_SOURCE)
  return file
}
