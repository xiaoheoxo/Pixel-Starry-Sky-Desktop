import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, WebContentsView: class {}, dialog: {}, session: {}, shell: {} }))
vi.mock('../ipc/guard', () => ({ handle: vi.fn() }))

const { browserUrl, pageUrl } = await import('./browser')

describe('网页标签能打开的地址', () => {
  const root = join(process.cwd(), 'fixture-project')
  const inside = pathToFileURL(join(root, 'docs', 'mock.html')).href

  it('http / https 照旧，补全协议', () => {
    expect(pageUrl('example.com', root)).toBe('https://example.com/')
    expect(pageUrl('localhost:5173', null)).toBe('http://localhost:5173/')
  })

  it('本机项目目录里的 HTML 可以用 file:// 打开', () => {
    expect(pageUrl(inside, root)).toBe(inside)
    expect(pageUrl(inside + '#part', root)).toBe(inside + '#part')
  })

  it('项目外面的文件、远程机器（没有根目录）、根目录本身都不放行', () => {
    expect(() => pageUrl(pathToFileURL(join(root, '..', 'secret.html')).href, root)).toThrow()
    expect(() => pageUrl(inside, null)).toThrow()
    expect(() => pageUrl(pathToFileURL(root).href, root)).toThrow()
  })

  it('只输端口号：本机这个端口', () => {
    expect(browserUrl('5173')).toBe('http://localhost:5173/')
    expect(browserUrl(':8080')).toBe('http://localhost:8080/')
    expect(browserUrl('5173/settings?tab=1')).toBe('http://localhost:5173/settings?tab=1')
    expect(() => browserUrl('99999')).toThrow()
  })

  it('其余协议照旧拒绝', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com'])
      expect(() => pageUrl(url, root)).toThrow()
  })
})
