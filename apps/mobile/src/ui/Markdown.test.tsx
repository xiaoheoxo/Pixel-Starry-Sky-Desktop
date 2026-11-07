import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownText } from './Markdown'

const html = (text: string): string => renderToStaticMarkup(<MarkdownText text={text} />)

// 和桌面端 ui/markdown/markdown.test.tsx 的「中文加粗」一致
describe('中文加粗', () => {
  it('中文标点挨着 ** 也算加粗', () => {
    expect(html('**提前刷新：**到期前')).toContain('<strong>提前刷新：</strong>到期前')
    expect(html('结果**很好。**下一步')).toContain('<strong>很好。</strong>')
  })

  it('单个星号按标准规则：乘法、通配符不变成斜体', () => {
    for (const text of ['5*（3+2）*2', '支持*.ts和*.js', '用*号，*号']) expect(html(text)).not.toContain('<em>')
    expect(html('中文*斜体*中文')).toContain('<em>斜体</em>')
  })
})
