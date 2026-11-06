import { describe, expect, it } from 'vitest'
import { fakePack, fakeState } from '@/features/extpacks/testing'
import { packOfTheme, uninstalledPresets } from './themePacks'

const uiThemes = [{ id: 'nord', label: 'Nord', path: 'themes/nord.json' }]
const nord = (over = {}) =>
  fakePack({ key: 'b-pixelsky.nord', id: 'pixelsky.nord', source: 'builtin', contributes: { uiThemes }, ...over })

describe('主题所在的扩展', () => {
  it('按主题 id 找到生效的扩展；停用的、别的 id 找不到', () => {
    expect(packOfTheme(fakeState(nord()), 'ext:pixelsky.nord/nord')?.key).toBe('b-pixelsky.nord')
    expect(packOfTheme(fakeState(nord()), 'ext:pixelsky.nord/other')).toBeUndefined()
    expect(packOfTheme(fakeState(nord({ enabled: false, live: false })), 'ext:pixelsky.nord/nord')).toBeUndefined()
  })

  it('已卸载的列表只有停用的预装主题', () => {
    const off = { enabled: false, live: false }
    const state = fakeState(
      nord(off),
      nord({ key: 'b-on', id: 'pixelsky.on' }),
      fakePack({ key: 'b-lang', source: 'builtin', contributes: {}, ...off }),
      fakePack({ key: 's-x', id: 'a.x', source: 'store', contributes: { uiThemes }, ...off }),
    )
    expect(uninstalledPresets(state).map(p => p.key)).toEqual(['b-pixelsky.nord'])
  })
})
