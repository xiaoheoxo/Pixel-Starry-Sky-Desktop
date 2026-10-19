import { describe, expect, it } from 'vitest'
import { matchBlocklist, normalizeBlocklist } from './blocklist'

const SITE = 'https://cloud.test'
const file = (items: unknown[]) =>
  normalizeBlocklist({ version: 1, sites: { [SITE]: { fetchedAt: '2026-10-17T00:00:00Z', updatedAt: 'u', items } } })

describe('normalizeBlocklist', () => {
  it('versions 里有不合法的版本号：只去掉那几个，合法的照样停用', () => {
    const f = file([{ id: 'acme.aa', versions: ['1.0.0', 'not a version', 3, '2.0.0'], reason: 'bad' }])
    expect(f.sites[SITE].items).toEqual([{ id: 'acme.aa', versions: ['1.0.0', '2.0.0'], reason: 'bad' }])
    expect(matchBlocklist(f, SITE, 'acme.aa', '1.0.0')).toMatchObject({ reason: 'bad' })
    expect(matchBlocklist(f, SITE, 'acme.aa', '2.0.0')).toMatchObject({ reason: 'bad' })
    expect(matchBlocklist(f, SITE, 'acme.aa', '3.0.0')).toBeNull()
  })

  it('一个合法的版本号都没有：整条丢掉；"*" 和形状不对的照旧', () => {
    const f = file([
      { id: 'acme.bb', versions: ['nope'], reason: 'x' },
      { id: 'acme.cc', versions: [], reason: 'x' },
      { id: 'acme.dd', versions: 'nope', reason: 'x' },
      { id: 'acme.ee', versions: '*', reason: 'all' },
      { id: 'Bad Id', versions: '*', reason: 'x' },
    ])
    expect(f.sites[SITE].items).toEqual([{ id: 'acme.ee', versions: '*', reason: 'all' }])
  })
})
