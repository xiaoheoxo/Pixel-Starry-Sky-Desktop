// 频道里云端生图发的消息上的小字（docs/ui/channel-image-gen.md §3.1）
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GeneratedLine } from './GeneratedLine'

const g = { group: '生图分组', size: '1024x1024', n: 2, quality: 'medium', estimate: 0.2 }

describe('GeneratedLine', () => {
  it('查到实扣前写估价，查到后写实扣；放不下的张数也写上', () => {
    expect(renderToStaticMarkup(<GeneratedLine generated={g} />)).toContain(
      '云端生图 · 生图分组 · 1024x1024 · 2 张 · 约 $0.20',
    )
    expect(renderToStaticMarkup(<GeneratedLine generated={{ ...g, cost: 0.15 }} />)).toContain('2 张 · $0.15')
    const html = renderToStaticMarkup(<GeneratedLine generated={{ ...g, estimate: null, dropped: 1 }} />)
    expect(html).toContain('2 张 · 1 张太大没放进频道')
  })
})
