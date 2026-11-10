// 网关设置文件：崩溃后残留的含会话密钥的文件，下次启动清掉
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '', on: () => undefined } }))
vi.mock('../app/data-dir', () => ({ dataRoot: () => '', localRoot: () => '' }))

const { clearGatewaySettings, groupKey } = await import('./platform')

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('1 小时缓存的分组', () => {
  it('只有 Claude Kiro[正价]（71）开', async () => {
    const { LONG_CACHE_GROUPS } = await import('./platform')
    expect([...LONG_CACHE_GROUPS]).toEqual(['71'])
  })
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

describe('分组目录存到磁盘：重启后续接的会话按它选协议', () => {
  it('读上次存的分组：supported_apis 只给 Responses 的线路走 Responses；没读到的先按 Messages；坏文件当没有', async () => {
    const { groupBrief, loadGroupCache, platformPixelApi } = await import('./platform')
    const scratch = resolve('../../scratch')
    mkdirSync(scratch, { recursive: true })
    root = mkdtempSync(join(scratch, 'platform-groups-'))
    const file = join(root, 'platform-groups.json')
    writeFileSync(
      file,
      JSON.stringify({
        '7': { platform: 'openai', name: 'GPT', supported_apis: ['responses'] },
        '8': { platform: 'grok', name: 'Grok', supported_apis: ['responses', 'messages'] },
        '9': { platform: 'kimi', name: 'Kimi', supported_apis: ['messages'] },
        bad: { platform: 'openai' },
        '10': { name: 'no platform' },
      }),
    )
    loadGroupCache(file)
    expect(groupBrief('7')?.name).toBe('GPT')
    expect(groupBrief('10')).toBeNull()
    expect(platformPixelApi('7', 'deepseek-v4-pro')).toBe('openai-responses')
    expect(platformPixelApi('8', 'grok-4.7')).toBe('openai-responses')
    expect(platformPixelApi('9', 'kimi-k3')).toBe('anthropic-messages')
    expect(platformPixelApi('7', 'claude-opus-4-7')).toBe('anthropic-messages')
    expect(platformPixelApi('404', 'kimi-k3')).toBe('anthropic-messages')
    writeFileSync(file, '{not json')
    expect(() => loadGroupCache(file)).not.toThrow()
    expect(() => loadGroupCache(join(root!, 'missing.json'))).not.toThrow()
  })
})

describe('线路当前扣费的 Key', () => {
  it('名字和 own 都对才认，旧云端没有、格式不对都当作没有', () => {
    expect(groupKey({ name: '工作用', own: true })).toEqual({ name: '工作用', own: true })
    expect(groupKey({ name: '像素星空 · GPT Plus · 我的电脑', own: false, extra: 1 })).toEqual({
      name: '像素星空 · GPT Plus · 我的电脑',
      own: false,
    })
    for (const bad of [
      undefined,
      null,
      'x',
      {},
      { name: '', own: true },
      { name: 1, own: true },
      { name: 'a', own: 'yes' },
    ])
      expect(groupKey(bad)).toBeNull()
  })
})
