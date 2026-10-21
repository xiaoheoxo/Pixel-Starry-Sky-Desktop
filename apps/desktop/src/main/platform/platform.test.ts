// 网关设置文件：崩溃后残留的含会话密钥的文件，下次启动清掉
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '', on: () => undefined } }))

const { clearGatewaySettings } = await import('./platform')

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('clearGatewaySettings', () => {
  it('只删网关起名的设置文件，别的文件和目录不动；目录不存在不报错', () => {
    const scratch = resolve('../../scratch')
    mkdirSync(scratch, { recursive: true })
    root = mkdtempSync(join(scratch, 'gateway-settings-'))
    const dir = join(root, 'gateway')
    mkdirSync(dir)
    const stale = 'a1b2c3d4e5f6a7b8c9d0e1f2.json'
    writeFileSync(join(dir, stale), '{"env":{}}')
    writeFileSync(join(dir, 'notes.json'), '{}')
    writeFileSync(join(dir, 'a1b2c3d4e5f6a7b8c9d0e1f.json'), '{}')
    mkdirSync(join(dir, 'keep'))
    clearGatewaySettings(dir)
    expect(existsSync(join(dir, stale))).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['a1b2c3d4e5f6a7b8c9d0e1f.json', 'keep', 'notes.json'])
    expect(() => clearGatewaySettings(join(root!, 'missing'))).not.toThrow()
  })
})
