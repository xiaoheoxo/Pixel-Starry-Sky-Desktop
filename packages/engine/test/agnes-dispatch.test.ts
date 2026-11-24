import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { registerBundledDispatch, trustedDispatchHook } from '../src/codex/agnes-dispatch'
import type { run } from '../src/exec'

const pluginId = 'pixelsky-agnes-dispatch@pixelsky-agnes-builtin'
const bundle = realpathSync(fileURLToPath(new URL('../assets/agnes-dispatch/', import.meta.url)))
const trusted = {
  source: 'plugin',
  pluginId,
  eventName: 'preToolUse',
  matcher: '^(collaboration[.:])?(spawn_agent|Agent)$',
  enabled: true,
  trustStatus: 'trusted',
}
const hooks = (hook: Record<string, unknown>) => ({ data: [{ hooks: [hook] }] })
describe('Agnes native dispatch trust', () => {
  it('requires the exact bundled, enabled, trusted plugin on the loaded thread', () => {
    expect(trustedDispatchHook(hooks(trusted))).toBe(true)
    for (const change of [
      { trustStatus: 'untrusted' },
      { trustStatus: 'modified' },
      { enabled: false },
      { source: 'user' },
      { pluginId: 'pixelsky-agnes-dispatch@unrelated' },
      { matcher: 'Bash' },
    ]) {
      expect(trustedDispatchHook(hooks({ ...trusted, ...change }))).toBe(false)
    }
  })
})
describe('Agnes built-in registration', () => {
  const launcher = { command: 'codex', args: [] }
  const env = { CODEX_HOME: '/test/codex-home' }
  const result = (data: unknown) => ({ ok: true, started: true, stdout: JSON.stringify(data), stderr: '', error: null })
  const recognized = { name: 'pixelsky-agnes-builtin', root: bundle, marketplaceSource: { sourceType: 'local' } }

  it('sets up only the bundled files through Codex, once for concurrent opens', async () => {
    const cmd = vi
      .fn<typeof run>()
      .mockResolvedValueOnce(result({ marketplaces: [] }))
      .mockResolvedValueOnce(result({ marketplaceName: 'pixelsky-agnes-builtin' }))
      .mockResolvedValueOnce(result({ installed: [] }))
      .mockResolvedValueOnce(result({ pluginId, version: '0.1.1' }))
    await Promise.all([
      registerBundledDispatch(launcher, env, bundle, cmd),
      registerBundledDispatch(launcher, env, bundle, cmd),
    ])
    expect(cmd.mock.calls.map(([, args]) => args)).toEqual([
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'add', bundle, '--json'],
      ['plugin', 'list', '--json'],
      ['plugin', 'add', pluginId, '--json'],
    ])
    expect(cmd.mock.calls.every(call => call[2] === env)).toBe(true)
  })

  it('updates an enabled stale copy through native add', async () => {
    const cmd = vi
      .fn<typeof run>()
      .mockResolvedValueOnce(result({ marketplaces: [recognized] }))
      .mockResolvedValueOnce(result({ installed: [{ pluginId, enabled: true, version: '0.1.0' }] }))
      .mockResolvedValueOnce(result({ pluginId, version: '0.1.1' }))
    await registerBundledDispatch(launcher, env, bundle, cmd)
    expect(cmd.mock.calls[2][1]).toEqual(['plugin', 'add', pluginId, '--json'])
  })

  it('accepts the bundled path when Codex omits marketplaceSource', async () => {
    const cmd = vi
      .fn<typeof run>()
      .mockResolvedValueOnce(result({ marketplaces: [{ name: recognized.name, root: bundle }] }))
      .mockResolvedValueOnce(result({ installed: [{ pluginId, enabled: true, version: '0.1.1' }] }))
    await registerBundledDispatch(launcher, env, bundle, cmd)
    expect(cmd.mock.calls.map(([, args]) => args)).toEqual([
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'list', '--json'],
    ])
  })

  it.each([
    { name: recognized.name, root: dirname(bundle) },
    { ...recognized, marketplaceSource: { sourceType: 'git' } },
  ])('rejects a foreign marketplace ($root)', async marketplace => {
    const cmd = vi.fn<typeof run>().mockResolvedValue(result({ marketplaces: [marketplace] }))
    await expect(registerBundledDispatch(launcher, env, bundle, cmd)).rejects.toThrow('指向另一位置')
    expect(cmd).toHaveBeenCalledOnce()
  })

  it('never overwrites foreign registrations or reenables a disabled plugin', async () => {
    const foreign = vi.fn<typeof run>().mockResolvedValue(result({ marketplaces: [{ ...recognized, root: '/other' }] }))
    await expect(registerBundledDispatch(launcher, env, bundle, foreign)).rejects.toThrow('指向另一位置')
    expect(foreign).toHaveBeenCalledOnce()
    const disabled = vi
      .fn<typeof run>()
      .mockResolvedValueOnce(result({ marketplaces: [recognized] }))
      .mockResolvedValueOnce(result({ installed: [{ pluginId, enabled: false }] }))
    await expect(registerBundledDispatch(launcher, env, bundle, disabled)).rejects.toThrow('已停用')
    expect(disabled).toHaveBeenCalledTimes(2)
  })
})
