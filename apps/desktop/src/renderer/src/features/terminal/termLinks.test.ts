import { Terminal, type IBuffer, type IBufferRange } from '@xterm/xterm'
import { describe, expect, it } from 'vitest'
import { findPathMatches } from '@/features/files/pathMatch'
import { findUrls, terminalText } from './termLinks'
import { enableUnicode11 } from './unicode11'

/** 真的 xterm 缓冲区（不打开界面） */
async function screen(data: string, cols = 80, rows = 10): Promise<{ buffer: IBuffer; cols: number }> {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  // 和真实终端一样的宽度规则（emoji 占两列）
  enableUnicode11(term)
  await new Promise<void>(resolve => term.write(data, resolve))
  return { buffer: term.buffer.active, cols }
}
/** 一个链接范围里实际的字：和屏幕上看到的一致才算对 */
function cells({ buffer, cols }: { buffer: IBuffer; cols: number }, range: IBufferRange): string {
  let text = ''
  for (let y = range.start.y; y <= range.end.y; y++)
    text += buffer
      .getLine(y - 1)!
      .translateToString(false, y === range.start.y ? range.start.x - 1 : 0, y === range.end.y ? range.end.x : cols)
  return text
}
const PATH = 'D:\\PixelSky\\docs\\ui\\omp-subagent-effort-mockup.html'

describe('终端链接的位置（docs/ui/files-search-terminal-pins.md §4.2）', () => {
  it('前面有中文、emoji、组合字符时，范围就是屏幕上那几格', async () => {
    for (const [before, column] of [
      ['', 1],
      ['plain text ', 12],
      ['🎉👍 ', 6],
      ['样稿已改成一打开就是分档，刷新即可：', 37],
      ['e\u0301 ', 3],
    ] as const) {
      const s = await screen(before + PATH + ' 后面', 120)
      const found = terminalText(s.buffer, 0, s.cols)!
      const [m] = findPathMatches(found.text)
      const range = found.range(m.start, m.end)
      expect(range.start).toEqual({ x: column, y: 1 })
      expect(cells(s, range)).toBe(PATH)
    }
    const s = await screen('好了 🎉🎉 见 https://a.com/b 再看 ' + PATH, 120)
    const found = terminalText(s.buffer, 0, s.cols)!
    const [url] = findUrls(found.text)
    expect(cells(s, found.range(url.start, url.end))).toBe('https://a.com/b')
    const m = findPathMatches(found.text).find(x => x.raw === PATH)!
    expect(cells(s, found.range(m.start, m.end))).toBe(PATH)
  })

  it('自动折行的接起来认，从哪一行问都一样；行尾放不下全角字空出的一格不影响位置', async () => {
    const s = await screen('看这个文件：' + PATH + '\r\n下一段 src/a.ts', 30)
    for (const row of [0, 1]) {
      const found = terminalText(s.buffer, row, s.cols)!
      const [m] = findPathMatches(found.text)
      expect(m.raw).toBe(PATH)
      const range = found.range(m.start, m.end)
      expect([range.start, range.end.y]).toEqual([{ x: 13, y: 1 }, 3])
      expect(cells(s, range).trimEnd()).toBe(PATH)
    }
    // 回车换行的不接
    expect(terminalText(s.buffer, 3, s.cols)!.text).toBe('下一段 src/a.ts')
    // 11 列放 5 个全角字，空一格
    const odd = await screen('一二三四五六 a.ts', 11)
    const found = terminalText(odd.buffer, 0, odd.cols)!
    expect(found.text).toBe('一二三四五 六 a.ts')
    const [m] = findPathMatches(found.text)
    expect(found.range(m.start, m.end)).toEqual({ start: { x: 4, y: 2 }, end: { x: 7, y: 2 } })
    expect(terminalText(odd.buffer, 99, 11)).toBeNull()
  })

  it('盖写后留下的折行标记不把两行的字粘起来；窄终端里的长网址不截断', async () => {
    const s = await screen('a'.repeat(30) + '\x1b[1;1H\x1b[0K12345 src/aaaa/a.ts\x1b[2;1Hb.ts next', 20)
    expect(s.buffer.getLine(1)!.isWrapped).toBe(true)
    expect(findPathMatches(terminalText(s.buffer, 0, 20)!.text).map(m => m.raw)).toEqual(['src/aaaa/a.ts', 'b.ts'])
    const long = 'https://a.com/?t=' + 'x'.repeat(1800)
    const narrow = await screen(long, 40, 60)
    for (const row of [0, 20, 45]) {
      const text = terminalText(narrow.buffer, row, 40)!.text
      expect(findUrls(text).map(u => text.slice(u.start, u.end))).toEqual([long])
    }
  })

  it('只给碰到这一行的链接，跨行的每一行都给', async () => {
    const s = await screen('aa.ts bb.ts ccccccccccc.ts dd.ts', 12)
    const names = (row: number): string[] => {
      const found = terminalText(s.buffer, row, s.cols)!
      return found.onRow(findPathMatches(found.text)).map(m => m.raw)
    }
    expect(names(0)).toEqual(['aa.ts', 'bb.ts'])
    expect(names(1)).toEqual(['ccccccccccc.ts'])
    expect(names(2)).toEqual(['ccccccccccc.ts', 'dd.ts'])
  })
})

describe('终端里的网址', () => {
  const urls = (text: string): string[] => findUrls(text).map(u => text.slice(u.start, u.end))
  it('碰到中文和全角标点就停，末尾的标点、没配对的括号不算', () => {
    expect(urls('打开 https://a.com/b。再说')).toEqual(['https://a.com/b'])
    expect(urls('（https://a.com/b?x=1&y=2#z）和http://b.cn:8080/看')).toEqual([
      'https://a.com/b?x=1&y=2#z',
      'http://b.cn:8080/',
    ])
    expect(urls('见https://a.com/b——说明')).toEqual(['https://a.com/b'])
    expect(urls('see https://a.com/b, (https://a.com/c). **https://a.com/d**')).toEqual([
      'https://a.com/b',
      'https://a.com/c',
      'https://a.com/d',
    ])
    expect(urls('https://en.wikipedia.org/wiki/A_(b) `http://localhost:5173/`')).toEqual([
      'https://en.wikipedia.org/wiki/A_(b)',
      'http://localhost:5173/',
    ])
    expect(urls('http://[::1]:3000 https://... https://')).toEqual(['http://[::1]:3000'])
  })
})
