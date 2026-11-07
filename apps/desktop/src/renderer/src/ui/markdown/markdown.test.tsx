import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { Markdown } from './Markdown'
import { hasMath, loadMath, normalizeMath } from './math'
import { shouldFold } from '../code/CodeBlock'
import { MarkdownImageContext } from './MarkdownImage'

const html = (text: string): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <Markdown text={text} />
    </I18nProvider>,
  )

describe('中文加粗', () => {
  const render = (text: string, streaming: boolean): string =>
    renderToStaticMarkup(
      <I18nProvider>
        <Markdown text={text} streaming={streaming} />
      </I18nProvider>,
    )

  it.each([false, true])('中文标点后面紧跟文字也算加粗（流式 %s）', streaming => {
    for (const [text, bold] of [
      ['**提前刷新：**到期前换新令牌', '提前刷新：'],
      ['这是**「重点」**内容', '「重点」'],
      ['结果**很好。**下一步', '很好。'],
    ]) {
      const out = render(text, streaming)
      expect(out).toContain(`<strong>${bold}</strong>`)
      expect(out).not.toContain('**')
    }
  })

  it('普通写法和不该加粗的不受影响', () => {
    expect(html('**abc**def')).toContain('<strong>abc</strong>')
    expect(html('2*3*4 和 a ** b')).toContain('2<em>3</em>4')
    expect(html('a ** b')).toContain('a ** b')
    expect(html('`**不是加粗：**到`')).toContain('**不是加粗：**到')
    expect(html('```\n**代码块：**里\n```')).toContain('**代码块：**里')
  })

  it('单个星号按标准规则：乘法、通配符挨着中文标点不变成斜体', () => {
    for (const text of [
      '5*（3+2）*2',
      '单价*（1-折扣）和数量*（1+税）',
      '支持*.ts和*.js',
      '用*号，*号',
      '注*：见下*',
    ]) {
      expect(html(text)).not.toContain('<em>')
    }
    expect(html('中文*斜体*中文')).toContain('<em>斜体</em>')
    expect(html('foo_bar_baz')).not.toContain('<em>')
    expect(html('***重点：***后')).toContain('<strong>重点：</strong>')
  })
})

describe('提示块', () => {
  it('五种标记画成提示块，标记本身不显示', () => {
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      const out = html(`> [!${kind}]\n> 内容 **加粗**`)
      expect(out).toContain(`data-alert="${kind.toLowerCase()}"`)
      expect(out).not.toContain(`[!${kind}]`)
      expect(out).toContain('<strong>加粗</strong>')
    }
  })

  it('标记大小写不敏感，和正文写在同一行也认', () => {
    expect(html('> [!tip] 直接写在后面')).toContain('data-alert="tip"')
  })

  it('普通引用块、标记不在开头的不变', () => {
    expect(html('> 普通引用')).toContain('<blockquote>')
    const out = html('> 说明 [!NOTE] 不在开头')
    expect(out).toContain('<blockquote>')
    expect(out).not.toContain('data-alert')
  })
})

describe('公式标记', () => {
  it('\\( \\) 换成行内 $$，\\[ \\] 换成独占几行的 $$ 块', () => {
    expect(normalizeMath('面积 \\(\\pi r^2\\) 结束')).toBe('面积 $$\\pi r^2$$ 结束')
    expect(normalizeMath('\\[ E = mc^2 \\]')).toBe('\n$$\nE = mc^2\n$$\n')
  })

  it('代码块和行内代码里的不换', () => {
    const text = '`\\(x\\)` 和\n```\n\\[y\\]\n```\n以及 \\(z\\)'
    expect(normalizeMath(text)).toBe('`\\(x\\)` 和\n```\n\\[y\\]\n```\n以及 $$z$$')
  })

  it('加载后渲染成 KaTeX，写错的公式不报错', async () => {
    await loadMath()
    const out = html('行内 \\(a^2+b^2\\) 和\n\n$$\n\\frac{1}{2}\n$$\n\n错的 $$\\frac{$$')
    expect(out).toContain('class="katex"')
    expect(out).toContain('katex-display')
    expect(out).not.toContain('\\(a^2')
  })

  it('KaTeX 样式和 rehype-katex 渲染用的是同一版（0.19 改了类名，混用时字号、分数线、框线全乱）', () => {
    const require = createRequire(import.meta.url)
    const renderer = createRequire(require.resolve('rehype-katex'))
    expect(require('katex').version).toBe(renderer('katex').version)
  })

  it('单个 $ 不算公式', () => {
    expect(hasMath('价格 $5 和 $10')).toBe(false)
    expect(hasMath('$$x$$')).toBe(true)
    expect(hasMath('\\(x\\)')).toBe(true)
  })
})

describe('长代码块折叠', () => {
  it('超过 30 行才折叠', () => {
    expect(shouldFold(30)).toBe(false)
    expect(shouldFold(31)).toBe(true)
  })

  it('折叠时有展开按钮，复制的仍是全部代码', () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
    const out = html('```\n' + code + '\n```')
    expect(out).toContain('aria-expanded="false"')
    expect(out).toContain('line 40')
  })
})

describe('链接地址', () => {
  it('本地路径的链接保留地址（原来被当成 D: 协议清空、点了没反应）；不是项目里的文件时只显示文字', () => {
    const out = html(String.raw`[截图](D:\PixelSky\docs\a.png) 和 [文件](file:///D:/x/a.ts)`)
    expect(out).toContain(String.raw`title="D:\PixelSky\docs\a.png"`)
    expect(out).toContain('title="file:///D:/x/a.ts"')
    expect(out).not.toContain('<a')
  })

  it('网址照常是链接，危险的协议仍被清掉', () => {
    expect(html('[站点](https://example.com)')).toContain('href="https://example.com"')
    expect(html('[坏](javascript:alert(1))')).not.toContain('javascript:')
  })
})

describe('正文图片', () => {
  it('本地路径不直接交给 Windows 浏览器加载，无会话时显示可读提示', () => {
    const out = html('![最新提示框](/home/me/repo/screen.png)')
    expect(out).not.toContain('<img')
    expect(out).toContain('data-markdown-image="unavailable"')
    expect(out).toContain('最新提示框')
  })

  it('流式正文也保留图片读取上下文，等待对应会话的图片数据', () => {
    for (const streaming of [false, true]) {
      const out = renderToStaticMarkup(
        <I18nProvider>
          <MarkdownImageContext.Provider value={async () => null}>
            <Markdown text="![截图](file:///home/me/repo/screen.png)" streaming={streaming} />
          </MarkdownImageContext.Provider>
        </I18nProvider>,
      )
      expect(out).toContain('data-markdown-image="loading"')
      expect(out).not.toContain('<img')
    }
  })
})

describe('Codex 文件引用', () => {
  it('换成链接，文字是文件名；路径里的 \\ _ % # 原样留在地址里', () => {
    const path = 'D:\\学习资料\\论文\\修改稿\\03_数值算例_修改稿06_润色 %1 #2.docx'
    const out = html(`原文件未修改。\n\n:codex-file-citation{path="${path}" purpose="output"}`)
    expect(out).not.toContain('codex-file-citation')
    // 没有路径上下文（测试里）时本地路径只显示文字，悬停提示是完整路径
    expect(out).toContain(`<span title="${path}">03_数值算例_修改稿06_润色 %1 #2.docx</span>`)
  })

  it('文件名里的 [ ] $ 不会在公式插件加载后变成公式，路径里的 & 不被当成字符引用', async () => {
    await loadMath()
    const path = 'D:\\a\\论文[终稿] $$x$$ R&copy;.docx'
    const out = html(`:codex-file-citation{path="${path}"}`)
    expect(out).not.toContain('katex')
    expect(out).toContain(`<span title="${path.replace('&', '&amp;')}">论文[终稿] $$x$$ R&amp;copy;.docx</span>`)
  })

  it('表格单元格里、文件名带 | 的引用不会把单元格切开', () => {
    const out = html('| 文件 |\n|---|\n| :codex-file-citation{path="/tmp/a|b.docx"} |')
    expect(out).toContain('<td><span title="/tmp/a|b.docx">a|b.docx</span></td>')
  })

  it('预览 .md 文件时按原文', () => {
    const out = renderToStaticMarkup(
      <I18nProvider>
        <Markdown document text=':codex-file-citation{path="a.md"}' />
      </I18nProvider>,
    )
    expect(out).toContain('codex-file-citation')
  })
})
