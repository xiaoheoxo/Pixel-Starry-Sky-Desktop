import type { Item } from '@pixelsky/protocol'

/** Saved events may use either the Codex display form or the Claude/Pixel MCP tool ID. */
export function connectorCall(item: Item): { provider: string | null; tool: string } | null {
  if (item.kind !== 'tool' || item.tool !== 'mcp') return null
  const codex = /^(.+?) \/ (.+)$/.exec(item.name)
  const qualified = codex ?? /^mcp__(.+?)__(.+)$/i.exec(item.name)
  const provider = qualified?.[1]?.trim() || null
  const tool = qualified?.[2]?.trim() || item.name.trim()
  return { provider, tool }
}

export function connectorUsage(items: readonly Item[]): { provider: string; calls: number }[] {
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  for (const item of items) {
    const provider = connectorCall(item)?.provider
    if (!provider || seen.has(item.id)) continue
    seen.add(item.id)
    counts.set(provider, (counts.get(provider) ?? 0) + 1)
  }
  return Array.from(counts, ([provider, calls]) => ({ provider, calls }))
}
