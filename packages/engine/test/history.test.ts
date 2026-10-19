import { describe, expect, it } from 'vitest'
import type { EngineId, Item } from '@pixelsky/protocol'
import { historyOutline, historyRead, historySearch, historyTurns } from '../src/history'

let n = 0
const id = () => `h${++n}`
const user = (text: string, engine?: EngineId, extra: Partial<Extract<Item, { kind: 'user' }>> = {}): Item => ({
  kind: 'user',
  id: id(),
  text,
  createdAt: 0,
  ...(engine ? { engine } : {}),
  ...extra,
})
const assistant = (text: string): Item => ({ kind: 'assistant', id: id(), text, status: 'completed' })
const reasoning = (text: string): Item => ({ kind: 'reasoning', id: id(), text, status: 'completed' })
const notice = (text: string, detail?: string): Item => ({ kind: 'notice', id: id(), level: 'info', text, detail })
const command = (cmd: string, output: string): Item => ({
  kind: 'command',
  id: id(),
  command: cmd,
  description: null,
  output,
  exitCode: 0,
  status: 'completed',
})
const tool = (name: string, title: string): Item => ({
  kind: 'tool',
  id: id(),
  tool: 'read',
  name,
  title,
  output: 'tool-secret-output',
  status: 'completed',
})
const edit = (path: string): Item => ({
  kind: 'file_change',
  id: id(),
  status: 'completed',
  changes: [{ path, kind: 'update', diff: '', added: 1, removed: 0 }],
})
const turn = (q: string, a: string, engine: EngineId = 'claude'): Item[] => [user(q, engine), assistant(a)]

describe('historyTurns', () => {
  it('按普通用户消息切轮，中途补充不开新的一轮', () => {
    const items = [
      ...turn('一', 'A', 'claude'),
      user('补充', 'claude', { mode: 'guidance' }),
      assistant('B'),
      ...turn('二', 'C', 'codex'),
    ]
    const turns = historyTurns(items)
    expect(turns.map(t => [t.number, t.engine, t.items.length])).toEqual([
      [1, 'claude', 4],
      [2, 'codex', 2],
    ])
  })

  it('第一条用户消息之前有实质内容才有第 0 轮', () => {
    expect(historyTurns([notice('提示'), ...turn('一', 'A')]).map(t => t.number)).toEqual([1])
    const turns = historyTurns([assistant('先有回复'), ...turn('一', 'A')], 'pixel')
    expect(turns.map(t => [t.number, t.engine])).toEqual([
      [0, 'pixel'],
      [1, 'claude'],
    ])
    expect(historyTurns([assistant('只有回复')]).map(t => t.number)).toEqual([0])
    expect(historyTurns([])).toEqual([])
  })

  it('用户消息没有标记时用兜底引擎', () => {
    expect(historyTurns([user('一'), assistant('A')], 'codex')[0].engine).toBe('codex')
    expect(historyTurns([user('一')])[0].engine).toBeNull()
  })
})

describe('historyOutline', () => {
  it('空对话', () => {
    expect(historyOutline([])).toBe('这段对话还没有内容。')
  })

  it('每轮一行：引擎、用户消息、最后一条助手回复，并说明翻页和读取', () => {
    const items = [
      ...turn('帮我修登录', '已修好', 'claude'),
      user('再加测试', 'codex'),
      assistant('先看看'),
      reasoning('不应出现'),
      assistant('测试加好了'),
    ]
    const text = historyOutline(items)
    expect(text).toContain('共 2 轮')
    expect(text).toContain('#1 [Claude Code] 用户：帮我修登录 → 助手：已修好')
    expect(text).toContain('#2 [Codex] 用户：再加测试 → 助手：测试加好了')
    expect(text).not.toContain('不应出现')
    expect(text).toContain('read(turn=N)')
    expect(text).not.toContain('下一页')
  })

  it('长文字截断到 120 字并压成一行；没有回复时说明', () => {
    const long = '很长的一行\n'.repeat(100)
    const text = historyOutline([user(long, 'claude')])
    const line = text.split('\n').find(l => l.startsWith('#1'))!
    expect(line).toContain('…（已截断）')
    expect(line).toContain('助手：（无回复）')
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThan(200)
  })

  it('每页 50 轮，可以翻页，越界给出提示', () => {
    const items = Array.from({ length: 120 }, (_, i) => turn(`问题${i + 1}`, `答${i + 1}`)).flat()
    const first = historyOutline(items)
    expect(first).toContain('共 120 轮')
    expect(first).toContain('第 1/3 页')
    expect(first).toContain('#50 ')
    expect(first).not.toContain('#51 ')
    expect(first).toContain('outline(page=2)')
    const last = historyOutline(items, { page: 3 })
    expect(last).toContain('#120 ')
    expect(last).toContain('#101 ')
    expect(last).not.toContain('#100 ')
    expect(last).not.toContain('下一页')
    expect(historyOutline(items, { page: 4 })).toContain('没有第 4 页')
    expect(historyOutline(items, { page: 0 })).toContain('没有第 0 页')
  })

  it('用户消息没有文字时列出附件名；引擎未知时用兜底', () => {
    const text = historyOutline([user('', undefined, { files: [{ name: 'a.txt', content: 'x' } as never] })], {
      fallbackEngine: 'pixel',
    })
    expect(text).toContain('（附：a.txt）')
    expect(text).toContain('[像素星空')
  })
})

describe('historyRead', () => {
  const items = [
    ...turn('第一问', '第一答', 'claude'),
    user('第二问', 'codex'),
    command('ls', 'file-a\nfile-b'),
    tool('Read', 'src/a.ts'),
    edit('src/a.ts'),
    reasoning('内部推理不能出现'),
    notice('已把之前的对话交接给 Codex（2 条）', '<pixelsky-handoff conversation="c">…</pixelsky-handoff>'),
    notice('普通提示'),
    assistant('第二答'),
    ...turn('第三问', '第三答', 'claude'),
  ]

  it('读一轮原文：用户、助手、命令、工具、文件改动都在，思考和交接提示不在', () => {
    const text = historyRead(items, { turn: 2 })
    expect(text).toContain('===== 第 2 轮 [Codex] =====')
    expect(text).toContain('用户：第二问')
    expect(text).toContain('$ ls（退出码 0）\nfile-a\nfile-b')
    expect(text).toContain('· Read：src/a.ts')
    expect(text).toContain('改动文件：src/a.ts（修改）')
    expect(text).toContain('助手：第二答')
    expect(text).toContain('（提示）普通提示')
    expect(text).not.toContain('内部推理')
    expect(text).not.toContain('交接给 Codex')
    expect(text).not.toContain('tool-secret-output')
    expect(text).not.toContain('第一问')
    expect(text).toContain('read(turn=3)')
  })

  it('count 读连续几轮，最多 5 轮，超出末尾时截到最后', () => {
    const text = historyRead(items, { turn: 2, count: 5 })
    expect(text).toContain('第 2 轮')
    expect(text).toContain('第 3 轮')
    expect(text).not.toContain('后面还有')
    const many = Array.from({ length: 10 }, (_, i) => turn(`问${i + 1}`, `答${i + 1}`)).flat()
    const six = historyRead(many, { turn: 1, count: 99 })
    expect(six.match(/===== 第 \d+ 轮/g)).toHaveLength(5)
    expect(six).toContain('后面还有第 6–10 轮')
  })

  it('用户和助手的话不截断，命令输出只留末尾 2000 字', () => {
    const long = 'x'.repeat(5000)
    const text = historyRead([user(long, 'claude'), assistant(long), command('cat big', `${'a'.repeat(3000)}END`)], {
      turn: 1,
    })
    expect(text).toContain(`用户：${long}`)
    expect(text).toContain(`助手：${long}`)
    expect(text).toContain(`…${'a'.repeat(1997)}END`)
    expect(text).not.toContain('a'.repeat(1998))
  })

  it('总长超过 20000 字时截断并说明', () => {
    const big = Array.from({ length: 5 }, (_, i) => turn(`问${i}`, 'y'.repeat(9000))).flat()
    const text = historyRead(big, { turn: 1, count: 5 })
    expect(text).toContain('已截断')
    expect(text.length).toBeLessThan(20_500)
  })

  it('轮次越界给出明确的错误，非法 count 当 1', () => {
    expect(historyRead(items, { turn: 9 })).toContain('没有第 9 轮')
    expect(historyRead(items, { turn: 9 })).toContain('#1–#3')
    expect(historyRead(items, { turn: 0 })).toContain('没有第 0 轮')
    expect(historyRead(items, { turn: 1.5 })).toContain('没有第 1.5 轮')
    expect(historyRead([], { turn: 1 })).toBe('这段对话还没有内容。')
    expect(historyRead(items, { turn: 1, count: 0 }).match(/===== 第/g)).toHaveLength(1)
  })

  it('第 0 轮可读', () => {
    const text = historyRead([assistant('开头'), ...turn('问', '答')], { turn: 0 })
    expect(text).toContain('===== 第 0 轮')
    expect(text).toContain('助手：开头')
  })

  it('同样的输入同样的输出', () => {
    expect(historyRead(items, { turn: 1, count: 3 })).toBe(historyRead(items, { turn: 1, count: 3 }))
  })
})

describe('historySearch', () => {
  const items = [
    ...turn('部署到 Staging 环境', '好的，已部署', 'claude'),
    user('看下日志', 'codex'),
    command('tail -n 20 app.log', 'ERROR: Connection refused to db'),
    tool('Read', 'config/staging.yml'),
    edit('src/deploy/staging.ts'),
    reasoning('staging 内部推理不应命中'),
    assistant('日志里有连接被拒绝'),
  ]

  it('不分大小写，按轮次给出类型和片段', () => {
    const text = historySearch(items, { query: 'staging' })
    expect(text).toContain('找到 3 处')
    expect(text).toContain('#1 [用户] 部署到 Staging 环境')
    expect(text).toContain('#2 [工具] Read config/staging.yml')
    expect(text).toContain('#2 [文件] src/deploy/staging.ts')
    expect(text).not.toContain('内部推理')
  })

  it('命令输出里的内容能搜到，片段两侧各留 80 字', () => {
    const long = `${'前'.repeat(300)}NEEDLE${'后'.repeat(300)}`
    const text = historySearch([user('x', 'claude'), command('run', long)], { query: 'needle' })
    expect(text).toContain(`#1 [命令] …${'前'.repeat(80)}NEEDLE${'后'.repeat(80)}…`)
  })

  it('搜「用户」「助手」这类前缀词不会全中', () => {
    expect(historySearch(items, { query: '助手' })).toContain('没有找到')
  })

  it('没有命中、空关键词、特殊字符', () => {
    expect(historySearch(items, { query: 'zzz' })).toBe('没有找到包含「zzz」的内容。')
    expect(historySearch(items, { query: '  ' })).toContain('请给出')
    expect(historySearch(items, { query: 'a'.repeat(300) })).toContain('太长')
    expect(historySearch([user('价格 (a+b)* [x]', 'claude')], { query: '(a+b)* [x]' })).toContain('#1 [用户]')
  })

  it('limit 默认 20、最多 50，并说明总数', () => {
    const many = Array.from({ length: 60 }, (_, i) => turn(`关键词 ${i}`, '好')).flat()
    const dflt = historySearch(many, { query: '关键词' })
    expect(dflt).toContain('找到 60 处')
    expect(dflt).toContain('显示前 20 处')
    expect(dflt.match(/^#\d+ /gm)).toHaveLength(20)
    expect(historySearch(many, { query: '关键词', limit: 500 }).match(/^#\d+ /gm)).toHaveLength(50)
    expect(historySearch(many, { query: '关键词', limit: 2 }).match(/^#\d+ /gm)).toHaveLength(2)
  })

  it('命中交接前后的内容都按原轮次编号', () => {
    const text = historySearch(items, { query: '连接被拒绝' })
    expect(text).toContain('#2 [助手]')
  })
})

describe('emoji 和落单的代理项', () => {
  const emoji = String.fromCharCode(0xd83d, 0xde00)
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  it('read 超长截断、search 片段：不劈开 emoji', () => {
    const items = [
      user(`问${emoji.repeat(15_000)}`, 'claude'),
      assistant(`答${emoji.repeat(15_000)}关键词${emoji.repeat(100)}`),
    ]
    const read = historyRead(items, { turn: 1 })
    expect(read).toContain('已截断')
    expect(lone.test(read)).toBe(false)
    expect(read).not.toContain('�')
    const found = historySearch(items, { query: '关键词' })
    expect(lone.test(found)).toBe(false)
    expect(found).not.toContain('�')
  })

  it('上游原文里本来就有的半个代理项：三个工具的输出都换成 U+FFFD', () => {
    const half = String.fromCharCode(0xd83d)
    const items = [user(`坏${half}字 关键词`, 'claude'), assistant(`回复${half}`)]
    for (const out of [
      historyOutline(items),
      historyRead(items, { turn: 1 }),
      historySearch(items, { query: '关键词' }),
    ]) {
      expect(lone.test(out)).toBe(false)
      expect(out).toContain('�')
    }
  })
})
