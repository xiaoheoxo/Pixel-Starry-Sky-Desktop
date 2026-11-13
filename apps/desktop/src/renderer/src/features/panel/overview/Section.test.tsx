import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Gauge } from 'lucide-react'
import { overviewPrefs } from './overviewPrefs'
import { Section, StatusGroup, StatusTile, type Tone } from './Section'

const render = (id: string, tone?: Tone): string =>
  renderToStaticMarkup(
    <Section id={id} icon={Gauge} title="标题" summary="摘要" tone={tone}>
      内容
    </Section>,
  )

afterEach(() => overviewPrefs.reset())

describe('Section', () => {
  it('默认展开：有内容，摘要只在折叠时显示', () => {
    const html = render('progress')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('内容')
    expect(html).not.toContain('摘要')
  })
  it('折叠后只留标题行和摘要', () => {
    overviewPrefs.setAllCollapsed(['env'], true)
    const html = render('env')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('摘要')
    expect(html).not.toContain('内容')
  })
  it('折叠着有问题：摘要带上 data-tone，图标上的点靠它亮', () => {
    overviewPrefs.setAllCollapsed(['pr'], true)
    expect(render('pr', 'bad')).toMatch(/data-tone="bad"[^>]*>摘要/)
    expect(render('pr')).not.toMatch(/data-tone="/)
  })
})

describe('StatusGroup', () => {
  const group = (): string =>
    renderToStaticMarkup(
      <StatusGroup>
        <StatusTile id="context" icon={Gauge} title="上下文" value="76%" tone="warn">
          明细
        </StatusTile>
        <StatusTile id="mcp" icon={Gauge} title="MCP" value="5" folded="MCP 5 个已连接">
          服务列表
        </StatusTile>
      </StatusGroup>,
    )
  it('展开：四格大数字，明细默认收着', () => {
    const html = group()
    expect(html).toContain('上下文')
    expect(html).toContain('76%')
    expect(html).not.toContain('明细')
    expect(html).not.toContain('服务列表')
  })
  it('折叠：各格交出「名称 数字」拼进标题行，有问题的带 data-tone', () => {
    overviewPrefs.setAllCollapsed(['status'], true)
    const html = group()
    expect(html).toContain('aria-expanded="false"')
    expect(html).toMatch(/<span data-overview-row="context" data-tone="warn"[^>]*>上下文 76%<\/span>/)
    expect(html).toContain('MCP 5 个已连接')
  })
})
