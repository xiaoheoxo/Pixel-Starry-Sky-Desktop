// 失败原因的建议给谁看（docs/multica-learn.md §2）
import { describe, expect, it } from 'vitest'
import { reasonText } from './runText'

describe('reasonText', () => {
  it('引擎的问题只有主人看到建议', () => {
    expect(reasonText('engine.quota', true)).toBe('额度用完 · 去充值或换通道')
    expect(reasonText('engine.quota', false)).toBe('额度用完')
  })
  it('主人电脑离线：建议只给别人；排队过期谁都给；认不出的不写', () => {
    expect(reasonText('machine_offline', false)).toBe('主人的电脑离线太久 · 等对方上线后重试')
    expect(reasonText('machine_offline', true)).toBe('主人的电脑离线太久')
    expect(reasonText('queue_expired', false)).toBe('排队太久没开始 · 可以重新派活')
    expect(reasonText('other', true)).toBeNull()
    expect(reasonText(null, true)).toBeNull()
  })
})
