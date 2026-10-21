import { describe, expect, it, vi } from 'vitest'
import type { ApprovalDecision, ApprovalRequest } from '@pixelsky/protocol'
import {
  allowAllDecisions,
  allowOnce,
  alwaysForGroup,
  answerInOrder,
  approvalSummary,
  commonScopes,
  denyOnce,
  isSolo,
  keepPending,
  layoutApprovals,
  outsideOf,
  toolLabel,
} from './model'

const ALWAYS: ApprovalRequest['alwaysScopes'] = ['session', 'project', 'user']
const tool = (id: string, toolName: string, input: unknown, extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  requestId: id,
  itemId: `item-${id}`,
  kind: 'tool',
  title: `使用 ${toolName}`,
  toolName,
  input,
  alwaysScopes: ALWAYS,
  ...extra,
})
const grep = (id: string, pattern: string, path: string) =>
  tool(id, 'mcp__fastctx__grep', { pattern, path, output_mode: 'content' }, { description: 'fastctx · grep' })
const command = (id: string, cmd: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  requestId: id,
  itemId: null,
  kind: 'command',
  title: '运行命令',
  command: cmd,
  alwaysScopes: ALWAYS,
  ...extra,
})
const CWD = 'C:/Users/me/Desktop/dsh-usage-statistics-panel'

describe('哪些单独成卡', () => {
  it('提问、计划、要填表单的不进列表；命令、改文件、普通工具进列表', () => {
    expect(isSolo({ ...command('a', 'ls'), kind: 'question' })).toBe(true)
    expect(isSolo({ ...command('a', 'ls'), kind: 'plan' })).toBe(true)
    expect(isSolo(tool('a', 'mcp__x__form', {}, { formSchema: {} }))).toBe(true)
    expect(isSolo(command('a', 'ls'))).toBe(false)
    expect(isSolo(grep('a', 'x', 'y'))).toBe(false)
  })
})

describe('列表的排法', () => {
  it('同一个工具 2 项以上成组，组的位置按组里第一项；其余保持 AI 发出的顺序', () => {
    const pr = tool('pr', 'mcp__github__create_pull_request', { title: 't' })
    const list = [pr, grep('g1', 'a', 'x'), command('c', 'ls'), grep('g2', 'b', 'y'), grep('g3', 'c', 'z')]
    const entries = layoutApprovals(list)
    expect(entries.map(e => (e.kind === 'row' ? e.request.requestId : e.requests.map(r => r.requestId)))).toEqual([
      'pr',
      ['g1', 'g2', 'g3'],
      'c',
    ])
    const group = entries[1]
    expect(group.kind === 'group' && [group.label, group.short]).toEqual(['fastctx · grep', 'grep'])
  })
  it('同一个工具只有一项时不成组；命令不成组', () => {
    expect(
      layoutApprovals([grep('g1', 'a', 'x'), command('c1', 'ls'), command('c2', 'pwd')]).every(e => e.kind === 'row'),
    ).toBe(true)
  })
  it('组上「始终允许」只给组里每项都能选的范围', () => {
    expect(commonScopes([grep('a', 'x', 'y'), { ...grep('b', 'x', 'y'), alwaysScopes: ['session', 'user'] }])).toEqual([
      'session',
      'user',
    ])
    expect(commonScopes([{ ...grep('a', 'x', 'y'), alwaysScopes: [] }, grep('b', 'x', 'y')])).toEqual([])
  })
})

describe('每项一行的摘要', () => {
  it('MCP 工具名写成「服务 · 工具」', () => {
    expect(toolLabel('mcp__github__create_pull_request')).toBe('github · create_pull_request')
    expect(toolLabel('WebFetch')).toBe('WebFetch')
    expect(toolLabel(undefined, 'fastctx · grep')).toBe('fastctx · grep')
  })
  it('搜索类：pattern + 路径最后两段；悬停看完整的，展开写完整路径', () => {
    const s = approvalSummary(grep('a', 'providerOf|function providerOf', `${CWD}/src/client/format.ts`), CWD)
    expect([s.label, s.text, s.hint, s.hintShort, s.mono, s.outside]).toEqual([
      'fastctx · grep',
      'providerOf|function providerOf',
      'client/format.ts',
      'format.ts',
      true,
      false,
    ])
    expect(s.where).toBe(`${CWD}/src/client/format.ts`)
  })
  it('项目外的路径标出来（Windows 不分大小写、反斜杠也认）', () => {
    expect(outsideOf('C:\\Users\\me\\Desktop\\Proxy\\app.py', CWD)).toBe(true)
    expect(outsideOf('c:\\users\\ME\\desktop\\dsh-usage-statistics-panel\\src\\wire.ts', CWD)).toBe(false)
    expect(outsideOf('src/wire.ts', CWD)).toBe(false)
    expect(outsideOf('/etc/hosts', '/home/me/proj')).toBe(true)
    expect(outsideOf('/home/me/project2/a', '/home/me/proj')).toBe(true)
    const read = approvalSummary(tool('r', 'Read', { file_path: 'C:/Users/me/.ssh/config' }), CWD)
    expect([read.text, read.outside]).toEqual(['…/.ssh/config', true])
  })
  it('命令：只取第一行，多行加「…」；后面写项目', () => {
    const s = approvalSummary(command('c', 'git push -u origin feat/draft'), CWD)
    expect([s.text, s.hint, s.mono]).toEqual(['git push -u origin feat/draft', 'dsh-usage-statistics-panel', true])
    expect(approvalSummary(command('c', 'set -e\nnpm test'), CWD).text).toBe('set -e …')
  })
  it('Codex 命令带外层：额外参数才标 wrapped；悬停文字带原始整行', () => {
    const wrapper = (extra: string[]) => ({
      line: 'powershell.exe -NoProfile -Command "ls"',
      shell: 'powershell',
      extra,
    })
    const plain = approvalSummary(command('c', 'ls', { wrapper: wrapper([]) }), CWD)
    const extra = approvalSummary(command('c', 'ls', { wrapper: wrapper(['-NoProfile']) }), CWD)
    expect([plain.wrapped, extra.wrapped]).toEqual([false, true])
    expect(extra.full).toBe('ls\npowershell.exe -NoProfile -Command "ls"')
    expect(approvalSummary(command('c', 'ls'), CWD)).toMatchObject({ wrapped: false, full: 'ls' })
  })
  it('改文件：「修改 N 个文件」+ 增删行数 + 前两个文件名「等」', () => {
    const change = (path: string, added: number, removed: number) => ({
      path,
      kind: 'update' as const,
      diff: '',
      added,
      removed,
    })
    const s = approvalSummary(
      {
        requestId: 'f',
        itemId: null,
        kind: 'file_change',
        title: '修改文件',
        changes: [change('src/Composer.tsx', 20, 4), change('src/useDraft.ts', 3, 2), change('src/a.ts', 1, 0)],
        alwaysScopes: ALWAYS,
      },
      CWD,
    )
    expect([s.text, s.hint, s.added, s.removed]).toEqual(['修改 3 个文件', 'Composer.tsx、useDraft.ts 等', 24, 6])
  })
  it('网页：去掉 https://；其他工具：前两个参数 键=值，太长截断', () => {
    expect(approvalSummary(tool('w', 'WebFetch', { url: 'https://docs.anthropic.com/en/docs' }), CWD).text).toBe(
      'docs.anthropic.com/en/docs',
    )
    const s = approvalSummary(
      tool('i', 'mcp__github__search_issues', { repo: 'pixel-web', query2: 'x'.repeat(40), extra: 1 }),
      CWD,
    )
    expect(s.label).toBe('github · search_issues')
    expect(s.text).toBe(`repo=pixel-web, query2=${'x'.repeat(29)}…`)
  })
  it('有标题的工具写标题；开 PR 带上「分支 → 目标分支」', () => {
    const s = approvalSummary(
      tool('pr', 'mcp__github__create_pull_request', {
        owner: 'pixel',
        title: '草稿按会话保存',
        head: 'feat/draft',
        base: 'main',
      }),
      CWD,
    )
    expect([s.label, s.text, s.hint, s.mono]).toEqual([
      'github · create_pull_request',
      '草稿按会话保存',
      'feat/draft → main',
      false,
    ])
  })
  it('有 command 参数的工具按命令写', () => {
    expect(approvalSummary(tool('b', 'Bash', { command: 'pnpm test\n--watch' }), CWD).text).toBe('pnpm test')
  })
})

describe('批量', () => {
  const grep3 = [grep('g1', 'a', 'x'), grep('g2', 'b', 'y'), grep('g3', 'c', 'z')]
  it('全部允许一次：按顺序逐项发；只能拒绝的跳过', async () => {
    const sent: string[] = []
    const list = [...grep3, { ...command('c', 'rm -rf /'), canAllow: false }]
    const result = await answerInOrder(list, allowOnce, r => void sent.push(r.requestId))
    expect(sent).toEqual(['g1', 'g2', 'g3'])
    expect(result.skipped).toEqual(['c'])
  })
  it('全部拒绝：不能拒绝的跳过', async () => {
    const result = await answerInOrder(
      [grep('a', 'x', 'y'), { ...grep('b', 'x', 'y'), canDeny: false }],
      denyOnce,
      () => undefined,
    )
    expect([result.sent, result.skipped]).toEqual([['a'], ['b']])
  })
  it('一项失败不影响后面的；失败的记下原因和当时的决定，可以重试', async () => {
    const steps: string[] = []
    const result = await answerInOrder(
      grep3,
      allowOnce,
      r => {
        if (r.requestId === 'g2') throw new Error('会话已断开')
      },
      (id, state) => steps.push(`${id}:${state}`),
    )
    expect(result.sent).toEqual(['g1', 'g3'])
    expect(result.failed).toEqual([{ requestId: 'g2', message: '会话已断开', decision: { type: 'allow' } }])
    expect(steps).toEqual(['g1:sending', 'g1:sent', 'g2:sending', 'g2:failed', 'g3:sending', 'g3:sent'])
  })
  it('等上一项发完再发下一项', async () => {
    let inFlight = 0
    let most = 0
    const send = vi.fn(async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise(r => setTimeout(r, 1))
      inFlight--
    })
    await answerInOrder(grep3, allowOnce, send)
    expect([send.mock.calls.length, most]).toEqual([3, 1])
  })
  it('组上「始终允许」：第一项带范围，其余允许一次', async () => {
    const decisions: ApprovalDecision[] = []
    await answerInOrder(grep3, alwaysForGroup('project'), (_r, d) => void decisions.push(d))
    expect(decisions).toEqual([{ type: 'allow_always', scope: 'project' }, { type: 'allow' }, { type: 'allow' }])
  })
  it('本会话后续不再询问：第一项能切完全放行的发 allow_all，其余允许一次，只能拒绝的不发', () => {
    const list = [
      grep('a', 'x', 'y'),
      { ...grep('b', 'x', 'y'), canAllowAll: true },
      grep('c', 'x', 'y'),
      { ...grep('d', 'x', 'y'), canAllow: false },
    ]
    expect([...allowAllDecisions(list)]).toEqual([
      ['a', { type: 'allow' }],
      ['b', { type: 'allow_all' }],
      ['c', { type: 'allow' }],
    ])
  })
})

describe('keepPending', () => {
  it('发送失败后在别处处理掉的请求从失败记录里删掉；没有要删的返回原来那个', () => {
    const failed = new Map([
      ['a', 'x'],
      ['b', 'y'],
    ])
    expect([...keepPending(failed, id => id === 'b')]).toEqual([['b', 'y']])
    expect(keepPending(failed, () => true)).toBe(failed)
  })
})
