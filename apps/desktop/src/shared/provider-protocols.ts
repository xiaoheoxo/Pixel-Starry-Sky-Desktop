// 引擎能用哪些协议的自定义接口（docs/ui/custom-api.md §12、§15）：主进程、设置页、模型菜单、手机网关共用这一份
import type { ProviderProtocol } from './types/providers'

/**
 * Claude Code ↔ Anthropic Messages，Codex ↔ OpenAI Responses，像素星空三种都行（Chat Completions 只有它能用），
 * Antigravity ↔ Gemini；不认识的引擎一个都不给
 */
export function engineProviderProtocols(engine: string): ProviderProtocol[] {
  if (speaksPi(engine)) return ['anthropic', 'responses', 'chat']
  switch (engine) {
    case 'claude':
      return ['anthropic']
    case 'codex':
      return ['responses']
    case 'antigravity':
      return ['gemini']
    default:
      return []
  }
}

/**
 * 协议和 Pi 同源的引擎（像素星空、oh-my-pi，docs/omp-engine.md §4）：Messages / Responses / Chat Completions 都会说，
 * 平台线路里写了 claude 或 codex 的分组也能用，网关按 Pi 的习惯处理（余额不足、413、长上下文后缀）
 */
export function speaksPi(engine: string): boolean {
  return engine === 'pixel' || engine === 'omp'
}
