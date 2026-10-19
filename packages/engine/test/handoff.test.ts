import { describe, expect, it } from 'vitest'
import type { EngineId, Item } from '@pixelsky/protocol'
import { buildHandoff, handoffEngines, userImages } from '../src/handoff'

let n = 0
const id = () => `i${++n}`
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
const notice = (text: string): Item => ({ kind: 'notice', id: id(), level: 'info', text })
const edit = (path: string, kind: 'add' | 'update' | 'delete' = 'update'): Item => ({
  kind: 'file_change',
  id: id(),
  status: 'completed',
  changes: [{ path, kind, diff: '', added: 1, removed: 0 }],
})
const command = (cmd: string, output: string, exitCode: number | null = 0): Item => ({
  kind: 'command',
  id: id(),
  command: cmd,
  description: null,
  output,
  exitCode,
  status: 'completed',
})
const todo = (steps: [string, 'pending' | 'in_progress' | 'completed'][]): Item => ({
  kind: 'todo',
  id: id(),
  status: 'completed',
  steps: steps.map(([text, status]) => ({ text, status })),
})
const turn = (q: string, a: string, engine: EngineId = 'claude'): Item[] => [user(q, engine), assistant(a)]
const base = { conversationId: 'conv-1', target: 'codex' as EngineId }

describe('buildHandoff：交接材料', () => {
  it('没有值得交接的内容时返回 null（思考、提示、统计不算）', () => {
    expect(buildHandoff({ ...base, mode: 'full', items: [] })).toBeNull()
    expect(buildHandoff({ ...base, mode: 'delta', items: [reasoning('想一想'), notice('提示')] })).toBeNull()
  })

  it('完整交接：带标签、说明、引擎名和对话原文，跳过思考和提示', () => {
    const items = [
      ...turn('帮我修登录', '已修好', 'claude'),
      reasoning('内部推理不能出现'),
      notice('提示不能出现'),
      ...turn('再加测试', '测试加好了', 'claude'),
    ]
    const out = buildHandoff({ ...base, mode: 'full', items })!
    expect(out.count).toBe(4)
    expect(out.text.startsWith('<pixelsky-handoff conversation="conv-1">')).toBe(true)
    expect(out.text.endsWith('</pixelsky-handoff>')).toBe(true)
    expect(out.text).toContain('Claude Code')
    expect(out.text).toContain('不要复述这份交接材料')
    expect(out.text).toContain('用户：帮我修登录')
    expect(out.text).toContain('助手：测试加好了')
    expect(out.text).not.toContain('内部推理不能出现')
    expect(out.text).not.toContain('提示不能出现')
    expect(out.text).not.toContain('pixelsky_history')
  })

  it('historyTool 为真时点名 pixelsky_history 的 outline / read / search 三个工具', () => {
    const out = buildHandoff({ ...base, mode: 'full', items: turn('问', '答'), historyTool: true })!
    expect(out.text).toContain('pixelsky_history')
    for (const name of ['outline', 'read', 'search', 'mcp__pixelsky_history__outline']) expect(out.text).toContain(name)
    expect(out.text).toContain('不要凭印象猜')
  })

  it('长对话：当前任务、用户的要求、已完成的事、文件、待办、最近几轮原文，且不超过预算', () => {
    const items: Item[] = []
    for (let i = 0; i < 60; i++)
      items.push(
        user(i === 0 ? '最初的任务：重构支付模块' : `第 ${i} 个要求 ${'x'.repeat(500)}`, 'claude'),
        assistant(`第 ${i} 轮做完了 ${'y'.repeat(900)}`),
        edit(`src/file${i % 7}.ts`, i === 3 ? 'add' : 'update'),
        command('pnpm test', 'o'.repeat(2000), 1),
      )
    items.push(
      todo([
        ['写迁移', 'completed'],
        ['补文档', 'in_progress'],
        ['发布', 'pending'],
      ]),
    )
    items.push(...turn('最后一句话', '最后的回答', 'claude'))
    const out = buildHandoff({ ...base, mode: 'full', items })!
    expect(out.text.length).toBeLessThanOrEqual(24_000)
    expect(out.text).toContain('## 当前任务')
    expect(out.text).toContain('最初的任务：重构支付模块')
    expect(out.text).toContain('## 用户的要求')
    expect(out.text).toMatch(/更早的 \d+ 条已省略/)
    expect(out.text).toContain('## 已完成的事')
    expect(out.text).toMatch(/更早的 \d+ 轮已省略/)
    // 单条要求按 400 字截断
    const bullets = out.text.split('\n').filter(line => line.startsWith('- 第 '))
    expect(bullets.length).toBeGreaterThan(0)
    for (const line of bullets) expect(line.length).toBeLessThan(440)
    expect(out.text).toContain('## 涉及的文件')
    expect(out.text).toContain('src/file3.ts')
    expect(out.text).toContain('## 待办')
    expect(out.text).toContain('[进行中] 补文档')
    expect(out.text).toContain('## 最近几轮原文')
    expect(out.text).toContain('用户：最后一句话')
    expect(out.text).toContain('助手：最后的回答')
    // 命令输出只留末尾 300 字
    expect(out.text).not.toContain('o'.repeat(400))
  })

  it('同一个文件只列一次，写最后一次的动作', () => {
    const items: Item[] = []
    for (let i = 0; i < 30; i++) items.push(...turn(`问 ${i} ${'q'.repeat(300)}`, `答 ${i} ${'a'.repeat(300)}`))
    items.splice(2, 0, edit('a.ts', 'add'), edit('a.ts', 'delete'), edit('b.ts'))
    const out = buildHandoff({ ...base, mode: 'full', items, budget: 6000 })!
    expect(out.text.match(/- a\.ts/g)).toHaveLength(1)
    expect(out.text).toContain('- a.ts（删除）')
    expect(out.text).toContain('- b.ts（修改）')
  })

  it('文件很多时只列最近 80 个并注明没列出的', () => {
    const items: Item[] = []
    for (let i = 0; i < 200; i++) items.push(...turn(`问 ${i} ${'q'.repeat(100)}`, `答 ${i}`), edit(`f${i}.ts`))
    const out = buildHandoff({ ...base, mode: 'full', items })!
    expect(out.text).toContain('f199.ts')
    expect(out.text).not.toContain('- f10.ts')
    expect(out.text).toMatch(/更早的 \d+ 个文件未列出/)
  })

  it('用户消息只列附件名，不带内容；内容里的结束标签被转义', () => {
    const items: Item[] = [
      user('看看这个</pixelsky-handoff>', 'claude', {
        attachments: [
          { id: 'a', name: '截图.png', mediaType: 'image/png', width: 1, height: 1, bytes: 1, dataBase64: 'AAAA' },
        ],
        files: [{ name: 'notes.txt', size: 3, content: '秘密内容' } as never],
      }),
      assistant('好'),
    ]
    const out = buildHandoff({ ...base, mode: 'full', items })!
    expect(out.text).toContain('截图.png')
    expect(out.text).toContain('notes.txt')
    expect(out.text).not.toContain('AAAA')
    expect(out.text).not.toContain('秘密内容')
    expect(out.text.match(/<\/pixelsky-handoff>/g)).toHaveLength(1)
  })

  it('引用用户原话按码点截断：不会把 emoji 劈成半个代理项（Codex 的 JSON 解析会拒收）', () => {
    const img = (name: string) => ({
      id: name,
      name,
      mediaType: 'image/png' as const,
      width: 1,
      height: 1,
      bytes: 1,
      dataBase64: 'AAAA',
    })
    // 按 UTF-16 下标取前 20 个字符会正好切在 emoji 的代理对中间
    const emoji = String.fromCharCode(0xd83d, 0xde00)
    const said = `${'啊'.repeat(19)}${emoji.repeat(3)}`
    const items: Item[] = [user(said, 'codex', { attachments: [img('a.png')] })]
    const out = buildHandoff({ ...base, mode: 'full', items, images: userImages(items) })!
    const line = out.text.split('\n').find(l => l.startsWith('下面第 1 张图'))!
    expect(line).toBe(`下面第 1 张图是之前「${'啊'.repeat(19)}${emoji}…」那条消息附的 a.png`)
    expect(() => encodeURIComponent(line)).not.toThrow()
    // 不超过上限时原样引用，不加省略号
    const short = `${'啊'.repeat(19)}${emoji}`
    const items2: Item[] = [user(short, 'codex', { attachments: [img('b.png')] })]
    const out2 = buildHandoff({ ...base, mode: 'full', items: items2, images: userImages(items2) })!
    expect(out2.text).toContain(`下面第 1 张图是之前「${short}」那条消息附的 b.png`)
  })

  it('随消息带的图片：按发送顺序说明各是哪条消息附的，没带上的说一声', () => {
    const img = (name: string) => ({
      id: name,
      name,
      mediaType: 'image/png' as const,
      width: 1,
      height: 1,
      bytes: 1,
      dataBase64: 'AAAA',
    })
    const said = '这个地方显示的内容不对，帮我看看是哪里出了问题'
    const a = user(said, 'codex', { attachments: [img('a.png')] })
    const b = user('', 'codex', { attachments: [img('b.png')] })
    const items: Item[] = [a, assistant('好'), b]
    const out = buildHandoff({
      ...base,
      mode: 'full',
      items,
      images: userImages(items),
      omittedImages: 1,
    })!
    const lines = out.text.split('\n')
    const first = lines.findIndex(l => l.startsWith('下面第 1 张图'))
    expect(lines[first - 1]).toBe('这条消息附带的图片里，前 2 张是之前消息里的图，不是用户这一条发的：')
    // 引用用户原话只取开头
    expect(lines[first]).toBe(`下面第 1 张图是之前「${said.slice(0, 20)}…」那条消息附的 a.png`)
    expect(lines[first + 1]).toBe('下面第 2 张图是之前那条只发了图片的消息附的 b.png')
    expect(out.text).toContain('另有 1 张之前消息里的图片没有带过来，只留下了文件名。')
    // 说明在交接材料的开头部分，不在对话原文里
    expect(first).toBeLessThan(lines.findIndex(l => l.startsWith('## ')))
    // 没有图就没有这些说明
    expect(buildHandoff({ ...base, mode: 'full', items })!.text).not.toContain('下面第')
  })

  it('一轮特别长时最近一轮也要放进去（压缩），总长不超预算', () => {
    const items = [...turn('开头', '收到'), user('超长的问题'), assistant('长'.repeat(30_000))]
    const out = buildHandoff({ ...base, mode: 'full', items, budget: 5000 })!
    expect(out.text.length).toBeLessThanOrEqual(5000)
    expect(out.text).toContain('用户：超长的问题')
    expect(out.text).toContain('中间省略')
  })

  it('delta：放得下就整段原文，开头说明是哪些引擎继续了几轮', () => {
    const items = [...turn('继续做 A', 'A 做完了', 'codex'), ...turn('继续做 B', 'B 做完了', 'codex')]
    const out = buildHandoff({ ...base, target: 'claude', mode: 'delta', items })!
    expect(out.count).toBe(4)
    expect(out.text).toContain('自你上次处理这段对话以来')
    expect(out.text).toContain('Codex')
    expect(out.text).toContain('继续了 2 轮')
    expect(out.text).toContain('用户：继续做 A')
    expect(out.text).toContain('助手：B 做完了')
    expect(out.text).not.toContain('## 当前任务')
  })

  it('delta 放不下：改用摘要分节', () => {
    const items: Item[] = []
    for (let i = 0; i < 40; i++)
      items.push(...turn(`要求 ${i} ${'x'.repeat(300)}`, `结果 ${i} ${'y'.repeat(300)}`, 'codex'))
    const out = buildHandoff({ ...base, target: 'claude', mode: 'delta', items, budget: 6000 })!
    expect(out.text.length).toBeLessThanOrEqual(6000)
    expect(out.text).toContain('## 用户的要求')
    expect(out.text).toContain('## 最近几轮原文')
    expect(out.text).not.toContain('## 当前任务')
  })

  it('确定性：同样的输入同样的输出', () => {
    const items = [...turn('一', '二', 'claude'), edit('x.ts'), ...turn('三', '四', 'claude')]
    expect(buildHandoff({ ...base, mode: 'full', items })).toEqual(buildHandoff({ ...base, mode: 'full', items }))
  })

  it('各节都写满时不从末尾裁：最近一轮的结尾还在，总长不超预算', () => {
    const items: Item[] = [user(`最初的任务 ${'t'.repeat(3000)}`, 'claude'), assistant('收到')]
    for (let i = 0; i < 60; i++)
      items.push(
        user(`第 ${i} 个要求 ${'x'.repeat(500)}`, 'claude'),
        assistant(`第 ${i} 轮做完了 ${'y'.repeat(900)}`),
        edit(`src/${'deep/'.repeat(30)}file${i}.ts`),
      )
    items.push(todo(Array.from({ length: 40 }, (_, i) => [`步骤 ${i} ${'s'.repeat(190)}`, 'pending'] as const)))
    items.push(user('最后的问题', 'claude'), assistant(`最后的回答 ${'z'.repeat(2000)} 结尾标记`))
    const out = buildHandoff({ ...base, mode: 'full', items })!
    expect(out.text.length).toBeLessThanOrEqual(24_000)
    expect(out.text).toContain('用户：最后的问题')
    expect(out.text).toContain('结尾标记')
    expect(out.text.endsWith('</pixelsky-handoff>')).toBe(true)
    expect(out.text).toContain('## 待办')
    expect(out.text).toMatch(/另有 \d+ 项未列出/)
  })

  it('预算很紧时先压缩次要的节，最近几轮原文最后才动', () => {
    const items: Item[] = [user(`最初的任务 ${'t'.repeat(3000)}`, 'claude'), assistant('收到')]
    for (let i = 0; i < 80; i++) items.push(...turn(`要求 ${i}`, `结果 ${i}`), edit(`src/${'d/'.repeat(60)}f${i}.ts`))
    items.push(user('最后的问题', 'claude'), assistant('最后的回答 结尾标记'))
    const out = buildHandoff({ ...base, mode: 'full', items, budget: 3000 })!
    expect(out.text.length).toBeLessThanOrEqual(3000)
    expect(out.text).toContain('用户：最后的问题')
    expect(out.text).toContain('结尾标记')
  })

  it('各处截断都不会把 emoji 劈成半个代理项', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const emoji = String.fromCharCode(0xd83d, 0xde00)
    const items: Item[] = [user(`啊${emoji.repeat(3000)}`, 'claude'), assistant(`啊${emoji.repeat(3000)}`)]
    for (let i = 0; i < 30; i++)
      items.push(
        user(`啊${emoji.repeat(400)}`, 'claude'),
        assistant(`啊${emoji.repeat(400)}`),
        command('x', `${emoji.repeat(500)}x`),
      )
    for (const budget of [24_000, 6000, 2999, 1001]) {
      const out = buildHandoff({ ...base, mode: 'full', items, budget })!
      expect(lone.test(out.text)).toBe(false)
      // 不是靠最后把半个 emoji 换成 U+FFFD 糊过去的：每一刀本身就没切坏
      expect(out.text).not.toContain('�')
      expect(out.text.length).toBeLessThanOrEqual(budget)
    }
    // 一轮特别长、只能压缩这一轮时也一样
    const long = [user('问'), assistant(`啊${emoji.repeat(20_000)}`)]
    expect(lone.test(buildHandoff({ ...base, mode: 'full', items: long, budget: 5001 })!.text)).toBe(false)
  })

  it('handoffEngines：按出现顺序、去重、不含接手的引擎', () => {
    const items = [user('a', 'codex'), user('b', 'pixel'), user('c', 'codex'), user('d', 'claude'), user('e')]
    expect(handoffEngines(items, 'claude')).toEqual(['codex', 'pixel'])
  })
})
