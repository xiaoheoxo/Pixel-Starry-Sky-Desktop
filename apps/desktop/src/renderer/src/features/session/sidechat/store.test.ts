import { describe, expect, it } from 'vitest'
import { tr } from '@/i18n/core'
import { askSide, sideRefusal } from './store'

describe('sideRefusal', () => {
  it('还不能问时返回原因：会话没发过消息、上一个问题还在答；答完就能问', async () => {
    expect(sideRefusal('s1', '先发一条')).toBe('先发一条')
    expect(sideRefusal('s1', null)).toBeNull()
    let answer!: (text: string) => void
    const asking = askSide('s1', '问题', () => new Promise<string>(resolve => (answer = resolve)))
    expect(sideRefusal('s1', null)).toBe(tr('side.busy'))
    expect(sideRefusal('s2', null)).toBeNull()
    answer('回答')
    await asking
    expect(sideRefusal('s1', null)).toBeNull()
  })
})
