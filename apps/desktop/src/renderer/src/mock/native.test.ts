// 演示数据：每个引擎一份会话列表
import { describe, expect, it } from 'vitest'
import { demoNativeSessions } from './native'

describe('demoNativeSessions', () => {
  it('Codex 6 行覆盖各种状态：普通、子文件夹、已在像素星空里、终端里正开着、可能还开着、其他程序', () => {
    const rows = demoNativeSessions.list('demo', 'codex')
    expect(rows).toHaveLength(6)
    expect(rows.filter(r => r.ownerId)).toHaveLength(1)
    expect(rows.map(r => r.live).filter(Boolean)).toEqual(['terminal', 'maybe'])
    expect(rows.some(r => r.subdir)).toBe(true)
    expect(rows.some(r => r.source === 'other')).toBe(true)
    expect(rows.some(r => !r.ownerId && !r.live && !r.subdir && r.source === 'terminal')).toBe(true)
  })
  it('不带引擎还是 Claude 的 7 行；两个引擎的 id、模型互不串', () => {
    expect(demoNativeSessions.list('demo')).toHaveLength(7)
    const [codex] = demoNativeSessions.list('demo', 'codex')
    expect(demoNativeSessions.details([codex.id], 'codex')[0].model).toMatch(/gpt/)
    expect(demoNativeSessions.details([codex.id], 'claude')).toEqual([])
  })
  it('导入：占用的跳过去，正开着的原地导入返回 live，复制出新对话', () => {
    const rows = demoNativeSessions.list('demo', 'codex')
    const owned = rows.find(r => r.ownerId)!
    const live = rows.find(r => r.live === 'terminal')!
    expect(demoNativeSessions.import(owned.id, 'inplace', 'codex')).toEqual({ ownerId: owned.ownerId })
    expect(demoNativeSessions.import(live.id, 'inplace', 'codex')).toEqual({ live: 'terminal' })
    expect(demoNativeSessions.import(live.id, 'copy', 'codex')).toMatchObject({ sessionId: expect.any(String) })
  })
})
