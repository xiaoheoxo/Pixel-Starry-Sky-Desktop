import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ packaged: false, appPath: '' }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.packaged
    },
    getAppPath: () => mocks.appPath,
  },
}))

import { bundledPixelCli } from './pixel-cli'

describe('bundledPixelCli', () => {
  let dir: string
  let cliTs: string
  let pixelMjs: string
  const originalResources = (process as { resourcesPath?: string }).resourcesPath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pixel-cli-'))
    mocks.appPath = join(dir, 'apps', 'desktop')
    mkdirSync(mocks.appPath, { recursive: true })
    cliTs = join(dir, 'packages', 'cli', 'src', 'cli.ts')
    pixelMjs = join(dir, 'resources', 'pixel-cli', 'pixel.mjs')
    Object.defineProperty(process, 'resourcesPath', { value: join(dir, 'resources'), configurable: true })
  })

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { value: originalResources, configurable: true })
    rmSync(dir, { recursive: true, force: true })
  })

  function touch(path: string) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '')
  }

  it('打包后：resources/pixel-cli/pixel.mjs 存在就返回它', () => {
    mocks.packaged = true
    touch(pixelMjs)
    expect(bundledPixelCli()).toBe(pixelMjs)
  })

  it('打包后：文件缺失返回 null（即使仓库源码还在）', () => {
    mocks.packaged = true
    touch(cliTs)
    expect(bundledPixelCli()).toBeNull()
  })

  it('开发时：仓库里的 cli.ts 存在就返回它', () => {
    mocks.packaged = false
    touch(cliTs)
    expect(bundledPixelCli()).toBe(join(mocks.appPath, '..', '..', 'packages', 'cli', 'src', 'cli.ts'))
  })

  it('开发时：cli.ts 缺失返回 null', () => {
    mocks.packaged = false
    touch(pixelMjs)
    expect(bundledPixelCli()).toBeNull()
  })
})
