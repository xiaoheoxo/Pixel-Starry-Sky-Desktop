import { describe, expect, it } from 'vitest'
import { installedCodexPlugins } from './plugins'

describe('installed Codex plugins', () => {
  it('shows only installed plugins and publishes no config, source path or credentials', () => {
    const installed = {
      id: 'github@openai-curated',
      name: 'github',
      installed: true,
      enabled: true,
      source: { path: '/private/plugin', credentials: 'secret' },
      interface: { displayName: 'GitHub', shortDescription: 'PR tools' },
    }
    expect(
      installedCodexPlugins({
        marketplaces: [
          { plugins: [installed, { id: 'not-installed', enabled: true, installed: false }] },
          { plugins: [installed, { id: 'review@local', installed: true, enabled: false }] },
        ],
      }),
    ).toEqual([
      { id: 'github@openai-curated', name: 'GitHub', description: 'PR tools', enabled: true },
      { id: 'review@local', name: 'review@local', description: '', enabled: false },
    ])
  })
})
