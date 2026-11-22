import { object } from './process'

/** Only installed plugin display metadata crosses IPC; do not expose plugin configuration or auth fields. */
export function installedCodexPlugins(raw: unknown) {
  const marketplaces = object(raw).marketplaces
  if (!Array.isArray(marketplaces)) throw new Error('Invalid Codex plugin list')
  const result = new Map<string, { id: string; name: string; description: string; enabled: boolean }>()
  for (const market of marketplaces) {
    const plugins = object(market).plugins
    if (!Array.isArray(plugins)) continue
    for (const value of plugins) {
      const plugin = object(value)
      if (plugin.installed !== true || typeof plugin.id !== 'string' || !plugin.id || result.has(plugin.id)) continue
      const display = object(plugin.interface)
      const short = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
      result.set(plugin.id, {
        id: short(plugin.id, 240),
        name: short(display.displayName, 160) || short(plugin.name, 160) || short(plugin.id, 160),
        description: short(display.shortDescription ?? display.longDescription, 600),
        enabled: plugin.enabled === true,
      })
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
}
