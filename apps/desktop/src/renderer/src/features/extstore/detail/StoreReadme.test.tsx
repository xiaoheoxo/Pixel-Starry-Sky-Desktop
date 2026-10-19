import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import { I18nProvider } from '@/i18n/I18nProvider'
import { README_MAX, StoreReadme, isWebUrl } from './StoreReadme'

const render = (text: string): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <StoreReadme text={text} />
    </I18nProvider>,
  )

describe('StoreReadme', () => {
  it('按 Markdown 显示：标题、加粗、行内代码、表格（本机扩展详情也用它）', () => {
    const html = render(
      '# Java 支持\n\n## 装上以后\n\n- **代码片段**（`.java` 文件里）\n\n| 前缀 | 作用 |\n| --- | --- |\n| `main` | main 方法 |\n',
    )
    expect(html).toContain('<h1>Java 支持</h1>')
    expect(html).toContain('<h2>装上以后</h2>')
    expect(html).toContain('<strong>代码片段</strong>')
    expect(html).toContain('<code>.java</code>')
    expect(html).toMatch(/<table>[\s\S]*<th>前缀<\/th>[\s\S]*<td><code>main<\/code><\/td>/)
    expect(html).not.toContain('# Java')
    expect(html).not.toContain('| --- |')
  })

  it('图片一律不产生 img，只留替代文字', () => {
    const sources = [
      'C:/Windows/win.ini',
      'pixelsky-ext://store-icon/a.b/1.0.0',
      'file:///C:/x.png',
      'https://x.test/a.png',
      'data:image/png;base64,AAAA',
      'a/b.png',
    ]
    for (const src of sources) {
      const html = render(`![图 x](${src})`)
      expect(html, src).not.toContain('<img')
      expect(html, src).toContain('图 x')
      expect(html, src).not.toContain(src)
    }
  })

  it('本机链接不产生能点的 a', () => {
    const hrefs = [
      'file:///C:/x',
      'C:/Windows/win.ini',
      'C:\\Windows\\win.ini',
      'javascript:alert(1)',
      'pixelsky-ext://x',
      '/etc/passwd',
      'a/b.md',
    ]
    for (const href of hrefs) {
      const html = render(`[点我](${href})`)
      expect(html, href).not.toContain('<a')
      expect(html, href).not.toContain('href=')
      expect(html, href).toContain('点我')
    }
  })

  it('http / https 链接放行，新窗口打开', () => {
    const html = render('[官网](https://example.test/a?b=1)')
    expect(html).toContain('<a href="https://example.test/a?b=1"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(render('[x](http://example.test)')).toContain('href="http://example.test"')
  })

  it('不开 rehype-raw：原始 HTML 不会生效', () => {
    const html = render('<img src="file:///C:/x.png"><script>alert(1)</script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
  })

  it('行内代码不做路径链接', () => {
    expect(render('`src/a.ts`')).not.toContain('data-path')
  })

  it('过长的说明截断并提示', () => {
    expect(render('a'.repeat(README_MAX + 10))).toContain('只显示前面一部分')
  })

  it('isWebUrl', () => {
    expect(isWebUrl('https://a.test')).toBe(true)
    expect(isWebUrl('file:///a')).toBe(false)
    expect(isWebUrl(undefined)).toBe(false)
  })
})
