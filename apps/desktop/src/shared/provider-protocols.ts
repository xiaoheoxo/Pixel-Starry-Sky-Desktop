// 引擎能用哪些协议的自定义接口（docs/ui/custom-api.md §12、§15）：主进程、设置页、模型菜单、手机网关共用这一份
import type { ProviderProtocol } from './types/providers'

/**
 * Claude Code ↔ Anthropic Messages，Codex ↔ OpenAI Responses，像素星空三种都行（Chat Completions 只有它能用），
 * Antigravity ↔ Gemini；不认识的引擎一个都不给
 */
export function engineProviderProtocols(engine: string): ProviderProtocol[] {
  switch (engine) {
    case 'claude':
      return ['anthropic']
    case 'codex':
      return ['responses']
    case 'pixel':
      return ['anthropic', 'responses', 'chat']
    case 'antigravity':
      return ['gemini']
    default:
      return []
  }
}
