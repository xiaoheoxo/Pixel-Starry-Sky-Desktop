// 输入框里的文本文件标签：截断了、但有本机路径的文本文件标「可按路径读全文」，悬停写路径；没路径的照旧「已截断」
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { FileAttachment } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { FileAttachments } from './FileAttachments'

const log = (patch: Partial<FileAttachment> = {}): FileAttachment => ({
  id: 'f1',
  name: 'latest.log',
  bytes: 457 * 1024,
  lines: 3094,
  encoding: 'utf-8',
  text: 'a\nb\n',
  tail: 'y\nz\n',
  omitted: 3090,
  ...patch,
})

const render = (file: FileAttachment): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <FileAttachments files={[file]} onRemove={() => undefined} />
    </I18nProvider>,
  )

describe('FileAttachments', () => {
  it('截断、没有路径（远程会话、粘贴的）：已截断', () => {
    const html = render(log())
    expect(html).toContain('已截断')
    expect(html).not.toContain('data-file-by-path')
  })
  it('截断、有本机路径：可按路径读全文，悬停写路径，不再标已截断', () => {
    const html = render(log({ path: 'D:\\logs\\latest.log' }))
    expect(html).toContain('data-file-by-path')
    expect(html).toContain('可按路径读全文')
    expect(html).toContain('中间省略的部分智能体可以按路径读完整文件：D:\\logs\\latest.log')
    expect(html).not.toContain('已截断')
  })
  it('没截断、有路径：悬停写路径；文档有路径照旧算截断', () => {
    const whole = render(log({ path: 'D:\\a.log', tail: undefined, omitted: undefined, lines: 2, bytes: 4 }))
    expect(whole).toContain('路径：D:\\a.log')
    expect(whole).not.toContain('已截断')
    const doc = render(log({ path: 'D:\\spec.docx', source: 'docx', tail: '', omitted: 3090 }))
    expect(doc).toContain('已截断')
    expect(doc).not.toContain('data-file-by-path')
  })
})
