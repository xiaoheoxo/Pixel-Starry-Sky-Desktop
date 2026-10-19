import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { missingPackageMessage, packagesExtension, skipMissingPackages, skippedPackages } from '../src/packages.ts'

const root = mkdtempSync(join(tmpdir(), 'pixel-packages-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('扩展包不自动安装', () => {
  it('Pi 的包管理器：settings.json 里没装的 npm / git 包跳过，不下载安装；同一个来源只记一次', async () => {
    skipMissingPackages(DefaultPackageManager)
    skipMissingPackages(DefaultPackageManager)
    const proto = DefaultPackageManager.prototype as unknown as {
      installParsedSource(...args: unknown[]): Promise<void>
    }
    const install = vi.spyOn(proto, 'installParsedSource')
    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, 'agent'),
      settingsManager: SettingsManager.inMemory({
        packages: ['npm:@pixelsky-test/not-installed@1.0.0', 'git:github.com/pixelsky-test/not-installed@v1'],
      }),
    })
    await manager.resolve()
    await manager.resolve()
    expect(install).not.toHaveBeenCalled()
    expect(skippedPackages()).toEqual([
      'npm:@pixelsky-test/not-installed@1.0.0',
      'git:github.com/pixelsky-test/not-installed@v1',
    ])
    // 调用方自己给了 onMissing（如 pixelsky config）：照它的
    const asked: string[] = []
    await manager.resolve(async source => {
      asked.push(source)
      return 'skip'
    })
    expect(asked).toHaveLength(2)
    install.mockRestore()
  })

  it('会话开始时提示一次；有界面时进通知，没有界面写 stderr', async () => {
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<void>> = []
    packagesExtension({
      on: (_name: string, h: (event: unknown, ctx: unknown) => Promise<void>) => handlers.push(h),
    } as never)
    const notes: string[] = []
    const ctx = { hasUI: true, ui: { notify: (message: string) => notes.push(message) } }
    await handlers[0]({}, ctx)
    await handlers[0]({}, ctx)
    expect(notes).toEqual(skippedPackages().map(missingPackageMessage))
    expect(notes[0]).toContain('不会自动下载安装')
  })
})
