import { describe, expect, it } from 'vitest'
import { TAB_IDLE_MS, expiredTabs } from './tabExpiry'

describe('右栏没看的标签卸载（docs/memory-tier3.md §2.3）', () => {
  const now = 100 * TAB_IDLE_MS
  const old = now - TAB_IDLE_MS

  it('概况、产物、评论 10 分钟没看就卸；不到 10 分钟、正在看的不卸', () => {
    const visited = new Set(['overview', 'artifacts', 'comments'])
    const seen = new Map([
      ['overview', old],
      ['artifacts', old + 1],
      ['comments', old],
    ])
    expect(expiredTabs(visited, seen, null, now)).toEqual(['overview', 'comments'])
    expect(expiredTabs(visited, seen, 'overview', now)).toEqual(['comments'])
  })

  it('有输入内容的、浏览器不卸；没记过时间的不卸', () => {
    const visited = new Set(['git', 'tasks', 'sandbox', 'copies', 'connectors', 'browser', 'overview'])
    const seen = new Map([...visited].filter(k => k !== 'overview').map(k => [k, 0] as const))
    expect(expiredTabs(visited, seen, null, now)).toEqual([])
  })
})
