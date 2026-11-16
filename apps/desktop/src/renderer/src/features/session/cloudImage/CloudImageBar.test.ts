// 云端生图的选项栏（docs/ui/image-gen.md §6）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformGroup } from '@/features/account/platform'
import { costCheck, imageGroups, initialOptions, saveOptions } from './CloudImageBar'

const group = (over: Partial<PlatformGroup>): PlatformGroup =>
  ({
    id: '41',
    name: '生图分组',
    description: '',
    platform: 'openai',
    rate_multiplier: 1,
    billing_source: 'balance_only',
    models: [],
    modelsError: null,
    supported_apis: ['images'],
    image_prices: { '1k': 0.1, '2k': 0.15, '4k': 0.2 },
    ...over,
  }) as PlatformGroup

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  })
})

describe('能生图的分组', () => {
  it('只要云端给了 images 接口的', () => {
    const list = [
      group({}),
      group({ id: '35', supported_apis: ['responses'] }),
      group({ id: '9', supported_apis: undefined }),
    ]
    expect(imageGroups(list).map(g => g.id)).toEqual(['41'])
  })
})

describe('选项', () => {
  it('第一次：第一个分组、1K 方图、一张、标准', () => {
    expect(initialOptions([group({})])).toEqual({ groupId: '41', size: '1024x1024', n: 1, quality: 'medium' })
    expect(initialOptions([])).toBeNull()
  })
  it('记住上次的；分组不在了换成第一个，存坏的值不用', () => {
    saveOptions({ groupId: '99', size: '2048x1152', n: 4, quality: 'high' })
    expect(initialOptions([group({})])).toEqual({ groupId: '41', size: '2048x1152', n: 4, quality: 'high' })
    localStorage.setItem('pixelsky.cloudImage.options.v1', '{"size":"1x1","n":3}')
    expect(initialOptions([group({})])).toMatchObject({ size: '1024x1024', n: 1 })
  })
})

describe('估价和余额', () => {
  const opts = { groupId: '41', size: '2048x2048', n: 4, quality: 'medium' } as const
  it('张数 × 档位单价 × 倍率；余额不够时标出来', () => {
    expect(costCheck(group({ rate_multiplier: 0.5 }), opts, 0, 10, 'USD')).toEqual({ cost: 0.3, short: false })
    expect(costCheck(group({}), opts, 0, 0.5, 'USD')).toMatchObject({ short: true })
  })
  it('有参考图按一张算；订阅额度的分组不看余额；不是美元的余额不比', () => {
    expect(costCheck(group({}), opts, 1, 10, 'USD').cost).toBeCloseTo(0.15)
    expect(costCheck(group({ billing_source: 'plan_only' }), opts, 0, 0, 'USD').short).toBe(false)
    expect(costCheck(group({}), opts, 0, 0, 'CNY').short).toBe(false)
  })
  it('这一档没配单价：估不出来，也不拦', () => {
    expect(costCheck(group({ image_prices: { '1k': 0, '2k': 0, '4k': 0 } }), opts, 0, 0, 'USD')).toEqual({
      cost: null,
      short: false,
    })
  })
})
