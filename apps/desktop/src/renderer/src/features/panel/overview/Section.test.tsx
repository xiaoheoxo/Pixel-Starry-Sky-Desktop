import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { List } from 'lucide-react'
import { Section } from './Section'

const render = (id: string): string =>
  renderToStaticMarkup(
    <Section id={id} icon={List} title="标题" summary="摘要">
      内容
    </Section>,
  )

describe('Section', () => {
  it('默认展开：有内容和摘要', () => {
    const html = render('progress')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('摘要')
    expect(html).toContain('内容')
  })
  it('默认折叠的分组：只留标题行和摘要', () => {
    const html = render('env')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('摘要')
    expect(html).not.toContain('内容')
  })
  it('quietOpen：展开时不重复摘要，折叠时才有', () => {
    const quiet = (id: string): string =>
      renderToStaticMarkup(
        <Section id={id} icon={List} title="标题" summary="摘要" quietOpen>
          内容
        </Section>,
      )
    expect(quiet('context')).not.toContain('摘要')
    expect(quiet('env')).toContain('摘要')
  })
})
