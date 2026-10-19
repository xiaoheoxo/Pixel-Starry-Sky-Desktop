import { describe, expect, it } from 'vitest'
import { followDraft } from './useFollowedDraft'

describe('followDraft：没动过的草稿跟着原值走', () => {
  it('草稿等于旧原值：换成新原值（成员加载完、别处改了团队名）', () => {
    expect(followDraft('', '', '小明')).toBe('小明')
    expect(followDraft('旧团队', '旧团队', '新团队')).toBe('新团队')
  })
  it('用户改过：留着用户写的', () => {
    expect(followDraft('我改的', '旧团队', '新团队')).toBe('我改的')
  })
})
