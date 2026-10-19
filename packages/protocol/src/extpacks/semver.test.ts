import { describe, expect, it } from 'vitest'
import { isExtVersion } from './validate'
import { compareExtVersion } from './semver'
import corpus from '../../corpus/extpacks/semver.json'

describe('compareExtVersion（共享用例 corpus/extpacks/semver.json）', () => {
  it('按 semver 2.0 的顺序两两比较', () => {
    const { order } = corpus
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        const want = i < j ? -1 : i > j ? 1 : 0
        expect(compareExtVersion(order[i], order[j]), `${order[i]} vs ${order[j]}`).toBe(want)
      }
    }
  })
  it('合法 / 不合法的版本号：不合法的排在 0.0.1 前面', () => {
    for (const v of corpus.valid) expect(compareExtVersion(v, '0.0.0-0'), v).not.toBe(-1)
    for (const v of corpus.invalid) {
      expect(compareExtVersion(v, '0.0.0'), JSON.stringify(v)).toBe(-1)
      expect(compareExtVersion('0.0.0', v), JSON.stringify(v)).toBe(1)
    }
  })
  it.each(corpus.pairs.map(p => [`${p.a} vs ${p.b}`, p] as const))('%s', (_name, p) => {
    expect(compareExtVersion(p.a, p.b)).toBe(p.result)
  })
  it('合法 / 不合法和 isExtVersion（长度上限之外）一致', () => {
    for (const v of corpus.valid) expect(isExtVersion(v), v).toBe(true)
    for (const v of corpus.invalid) expect(isExtVersion(v), JSON.stringify(v)).toBe(false)
  })
})
