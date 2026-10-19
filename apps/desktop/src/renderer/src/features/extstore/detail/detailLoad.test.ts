import { describe, expect, it } from 'vitest'
import type { ExtStoreDetail } from '@pixelsky/protocol'
import { fakePack } from '@/features/extpacks/testing'
import { failedResult, localLoadKey } from './detailLoad'

const pack = (over: Parameters<typeof fakePack>[0] = {}) =>
  fakePack({
    key: 'store-1',
    id: 'pixelsky.swift',
    source: 'store',
    store: { version: '1.0.0', installedAt: 1, sha256: 'x', keyId: 'k', site: 's' },
    ...over,
  })

describe('localLoadKey', () => {
  it('本机没有：空串', () => {
    expect(localLoadKey(null)).toBe('')
  })

  it('停用名单解除（blocked 没了）时变，详情页会重新取', () => {
    const blocked = pack({ enabled: false, blocked: { reason: '含恶意内容', at: '2026-10-16' } })
    const cleared = pack({ enabled: false })
    expect(localLoadKey(blocked)).not.toBe(localLoadKey(cleared))
  })

  it('启停、版本变了也变；什么都没变时不变', () => {
    expect(localLoadKey(pack({ enabled: true }))).not.toBe(localLoadKey(pack({ enabled: false })))
    expect(localLoadKey(pack())).not.toBe(
      localLoadKey(pack({ store: { version: '1.1.0', installedAt: 1, sha256: 'x', keyId: 'k', site: 's' } })),
    )
    expect(localLoadKey(pack())).toBe(localLoadKey(pack()))
  })
})

describe('failedResult', () => {
  it('第一次就失败：没有详情，记下错误（不是下架的 null + 无错误）', () => {
    expect(failedResult(null, '云端暂时不可用')).toEqual({ detail: null, error: '云端暂时不可用' })
  })

  it('重新取时失败：留着上一次的详情', () => {
    const detail = { extension: { id: 'pixelsky.swift' } } as ExtStoreDetail
    expect(failedResult({ detail, error: null }, '连不上扩展商店')).toEqual({ detail, error: '连不上扩展商店' })
  })
})
