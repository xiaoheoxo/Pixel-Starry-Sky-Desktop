import { describe, expect, it } from 'vitest'
import {
  errorQuote,
  exitCodeIn,
  failedTail,
  isErrorLine,
  promptCommand,
  quoteCard,
  quoteTitle,
  selectionQuote,
  type Rows,
} from './errorLines'

/** 测试用的缓冲区：以 \u21b5 开头的行是上一行折下来的 */
const rows = (lines: string[]): Rows => ({
  length: lines.length,
  text: i => lines[i].replace(/^\u21b5/, ''),
  wrapped: i => lines[i].startsWith('\u21b5'),
})

describe('isErrorLine', () => {
  it.each([
    'error during build:',
    'src/a.ts(3,1): error TS2304: Cannot find name',
    'TypeError: x is not a function',
    'npm ERR! code ELIFECYCLE',
    ' FAIL  src/a.test.ts > adds',
    'Traceback (most recent call last):',
    'panic: runtime error: index out of range',
    'Exception in thread "main" java.lang.NullPointerException',
    ' ELIFECYCLE  Command failed with exit code 1.',
    'exit status 2',
  ])('认得 %s', line => expect(isErrorLine(line)).toBe(true))
  it.each(['Found 0 errors.', '    0 Error(s)', '2 tests failed', 'exited with code 0', 'build ok', ''])(
    '不认 %s',
    line => expect(isErrorLine(line)).toBe(false),
  )
})

it('exitCodeIn', () => {
  expect(exitCodeIn('Command failed with exit code 1.')).toBe(1)
  expect(exitCodeIn('Process exited with code -1')).toBe(-1)
  expect(exitCodeIn('exit status 2')).toBe(2)
  expect(exitCodeIn('error: nope')).toBeNull()
})

it('promptCommand', () => {
  expect(promptCommand('PS D:\\PixelSky> pnpm build')).toBe('pnpm build')
  expect(promptCommand('PS D:\\PixelSky>')).toBe('')
  expect(promptCommand('C:\\work>npm test')).toBe('npm test')
  expect(promptCommand('me@box:~/proj$ make all')).toBe('make all')
  expect(promptCommand('me@box proj % go test ./...')).toBe('go test ./...')
  expect(promptCommand('$ cargo run')).toBe('cargo run')
  expect(promptCommand('> vite build')).toBeNull()
  expect(promptCommand('# comment')).toBeNull()
  expect(promptCommand('error during build:')).toBeNull()
})

describe('errorQuote', () => {
  const buffer = rows([
    'PS D:\\app> pnpm lint',
    'lint ok',
    'PS D:\\app> pnpm build',
    'vite v6 building...',
    'error during build:',
    '[vite]: Rollup failed to resolve import',
    '\u21b5 "@/machines/stroe"',
    ' ELIFECYCLE  Command failed with exit code 1.',
    'PS D:\\app>',
  ])
  it('不越过本条命令的提示符，折行接回去，带命令和输出里写的退出码', () => {
    const quote = errorQuote(buffer, 4)
    expect(quote).toEqual({
      start: 2,
      end: 7,
      text: 'PS D:\\app> pnpm build\nvite v6 building...\nerror during build:\n[vite]: Rollup failed to resolve import "@/machines/stroe"\n ELIFECYCLE  Command failed with exit code 1.',
      command: 'pnpm build',
      exitCode: 1,
    })
  })
  it('前 20 行、后 5 行', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`)
    lines[30] = 'Error: boom'
    const quote = errorQuote(rows(lines), 30)
    expect([quote.start, quote.end, quote.command, quote.exitCode]).toEqual([10, 35, null, null])
  })
  it('超过 4 KB 从前面去掉', () => {
    const lines = Array.from({ length: 30 }, () => 'x'.repeat(400))
    lines[25] = 'error here'
    const quote = errorQuote(rows(lines), 25)
    expect(quote.text.length).toBeLessThanOrEqual(4096)
    expect(quote.text.split('\n').at(-5)).toBe('error here')
    expect(quote.end).toBe(29)
  })
  it('输出里没写退出码时用 shell 集成报的（只对最近结束的那条命令）', () => {
    const plain = rows(['PS D:\\app> node a.js', 'TypeError: x', 'PS D:\\app> node b.js', 'Error: y', 'PS D:\\app>'])
    expect(errorQuote(plain, 3, { row: 4, code: 3 }).exitCode).toBe(3)
    expect(errorQuote(plain, 1, { row: 4, code: 3 }).exitCode).toBeNull()
  })
})

it('failedTail：非 0 退出时最近一条命令的最后一行输出', () => {
  const buffer = rows(['PS D:\\app> node a.js', 'something went sideways', '', 'PS D:\\app>'])
  expect(failedTail(buffer, { row: 3, code: 1 })).toBe(1)
  expect(failedTail(buffer, { row: 3, code: 0 })).toBeNull()
  expect(failedTail(buffer, null)).toBeNull()
  expect(failedTail(rows(['PS D:\\app> cls', 'PS D:\\app>']), { row: 1, code: 1 })).toBeNull()
})

it('两行提示符（Git Bash）：提示符的头不算输出', () => {
  const silent = rows(['$ node -e "process.exit(1)"', '', 'me@BOX MINGW64 ~/proj (main)', '$'])
  expect(failedTail(silent, { row: 3, code: 1 })).toBeNull()
  const loud = rows(['$ node a.js', 'boom', '', 'me@BOX MINGW64 ~/proj (main)', '$'])
  expect(failedTail(loud, { row: 4, code: 1 })).toBe(1)
  expect(errorQuote(loud, 1).text).toBe('$ node a.js\nboom')
})

it('errorQuote：报错行折得很长时从后面截到约 4 KB', () => {
  const long = rows([
    'PS D:\\app> node a.js',
    'Error: bad response {"a":"' + 'x'.repeat(170),
    ...Array<string>(200).fill('\u21b5' + 'x'.repeat(200)),
    'PS D:\\app>',
  ])
  const quote = errorQuote(long, 1)
  expect(quote.text.length).toBeLessThanOrEqual(4097)
  // 先从前面去掉了提示符那行，再从后面截
  expect(quote.text.startsWith('Error: bad response')).toBe(true)
  expect(quote.command).toBe('node a.js')
})

it('selectionQuote 按选区所在的命令找命令和退出码', () => {
  const buffer = rows(['$ cargo build', 'error[E0425]: cannot find value', 'exit status 101', '$'])
  expect(selectionQuote(buffer, 1, 1, 'error[E0425]: cannot find value  \n')).toEqual({
    start: 1,
    end: 1,
    text: 'error[E0425]: cannot find value',
    command: 'cargo build',
    exitCode: 101,
  })
})

describe('卡片', () => {
  it('不知道行号时标题不写行号', () => {
    expect(quoteTitle({ start: -1, end: -1, text: '', command: 'pnpm build', exitCode: 1 })).not.toMatch(/行|line/)
  })
  it('标题：不知道的部分不写', () => {
    expect(quoteTitle({ start: 2, end: 6, text: '', command: 'pnpm build', exitCode: 1 })).toBe(
      '终端 · pnpm build · 退出码 1 · 第 3–7 行',
    )
    expect(quoteTitle({ start: 0, end: 0, text: '', command: null, exitCode: null })).toBe('终端 · 第 1 行')
  })
  it('代码块围栏比原文里的反引号长', () => {
    expect(quoteCard({ start: 0, end: 0, text: 'a ``` b', command: null, exitCode: null })).toBe(
      '终端 · 第 1 行\n````\na ``` b\n````',
    )
  })
})
