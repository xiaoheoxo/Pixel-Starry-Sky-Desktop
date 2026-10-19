import { describe, expect, it } from 'vitest'
import type { ExtPackInfo, ExtPackSource } from '@pixelsky/protocol'
import { computeLive, packStatus } from '@pixelsky/protocol'
import type { LoadedPack } from '../loader'
import { applyWinners, pickWinners } from './winner'

const KEY: Record<ExtPackSource, string> = { builtin: 'b-x', store: 's-x', folder: 'f-x' }

function info(source: ExtPackSource, over: Partial<ExtPackInfo> = {}, key: string = KEY[source]): ExtPackInfo {
  const base = {
    key,
    id: 'acme.x',
    source,
    path: '/x',
    enabled: true,
    addedAt: 0,
    revision: 1,
    status: 'ok',
    manifest: null,
    inactive: {},
    issues: [],
    options: {},
    skills: [],
    ...over,
  } as ExtPackInfo
  base.live = computeLive(base)
  return base
}
const pack = (i: ExtPackInfo): LoadedPack => ({ info: i, root: i.path, files: new Map() })

describe('pickWinners', () => {
  it('文件夹 > 商店 > 内置', () => {
    const [b, s, f] = [info('builtin'), info('store'), info('folder')]
    expect(pickWinners([b, s, f])).toEqual(
      new Map([
        ['b-x', 'folder'],
        ['s-x', 'folder'],
      ]),
    )
    expect(pickWinners([b, s])).toEqual(new Map([['b-x', 'store']]))
    expect(pickWinners([b, f])).toEqual(new Map([['b-x', 'folder']]))
  })

  it('高优先级的关掉 / 出错 / 被停用时低的顶上', () => {
    const b = info('builtin')
    expect(pickWinners([b, info('folder', { enabled: false })])).toEqual(new Map([['f-x', 'builtin']]))
    expect(pickWinners([b, info('store', { status: 'error' })])).toEqual(new Map([['s-x', 'builtin']]))
    expect(pickWinners([b, info('store', { blocked: { reason: 'r', at: 't' } })])).toEqual(
      new Map([['s-x', 'builtin']]),
    )
    const f = info('folder', { enabled: false })
    expect(pickWinners([b, info('store'), f])).toEqual(
      new Map([
        ['b-x', 'store'],
        ['f-x', 'store'],
      ]),
    )
  })

  it('都关了、都出错了时谁也不标替代', () => {
    expect(pickWinners([info('builtin', { enabled: false }), info('store', { enabled: false })]).size).toBe(0)
    expect(pickWinners([info('builtin', { status: 'error' }), info('folder', { status: 'error' })]).size).toBe(0)
  })

  it('id 不同或没有 id 的互不影响', () => {
    expect(pickWinners([info('builtin'), info('folder', { id: 'acme.y' }, 'f-y')]).size).toBe(0)
    expect(pickWinners([info('builtin', { id: null }), info('folder', { id: null }, 'f-y')]).size).toBe(0)
  })
})

describe('applyWinners', () => {
  it('设 shadowedBy、重算 live；生效的那份关掉后被替代的顶上并清掉标记', () => {
    const b = pack(info('builtin'))
    const f = pack(info('folder'))
    applyWinners([b, f])
    expect(b.info).toMatchObject({ shadowedBy: 'folder', live: false })
    expect(f.info.live).toBe(true)
    f.info.enabled = false
    applyWinners([b, f])
    expect(b.info.shadowedBy).toBeUndefined()
    expect(b.info.live).toBe(true)
    expect(f.info.live).toBe(false)
  })

  it('被替代的那份点启用：enabled 变 true，live 仍是 false，shadowedBy 不变', () => {
    const b = pack(info('builtin', { enabled: false }))
    const s = pack(info('store'))
    applyWinners([b, s])
    expect(b.info.shadowedBy).toBe('store')
    b.info.enabled = true
    applyWinners([b, s])
    expect(b.info).toMatchObject({ enabled: true, live: false, shadowedBy: 'store' })
  })

  it('两个文件夹同 id：后到的仍报 pack.duplicateId；删掉先到的后恢复', () => {
    const a = pack(info('folder', {}, 'f-a'))
    const b = pack(info('folder', {}, 'f-b'))
    applyWinners([a, b])
    expect(a.info.status).toBe('ok')
    expect(b.info.issues.map(i => i.code)).toContain('pack.duplicateId')
    expect(b.info).toMatchObject({ status: 'error', live: false })
    applyWinners([b])
    expect(b.info.issues.map(i => i.code)).not.toContain('pack.duplicateId')
    expect(b.info).toMatchObject({ status: packStatus(b.info.issues), live: true })
  })

  it('出错的重复文件夹不拖累同 id 的内置：内置仍生效', () => {
    const b = pack(info('builtin'))
    const a = pack(info('folder', {}, 'f-a'))
    const c = pack(info('folder', {}, 'f-c'))
    applyWinners([b, a, c])
    expect(c.info.status).toBe('error')
    expect(b.info.shadowedBy).toBe('folder')
  })
})
