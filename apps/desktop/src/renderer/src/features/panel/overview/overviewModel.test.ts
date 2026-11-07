import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, ContextWindow, Item, McpReport, ModelTurnUsage } from '@pixelsky/protocol'
import { tr } from '@/i18n/core'
import type { TurnChanges } from '@/features/coding/ai/turnChangesModel'
import { replyStatParts } from '@/features/session/turnStatsData'
import type { QuotaCard, QuotaEntry, QuotaLayout } from '@/features/session/quota/quotaModel'
import type { Connector } from '../connectors/connectorsModel'
import type { CheckCommandResult, CheckRun } from '../../../../../shared/types/checks'
import type { GitFileChange } from '../../../../../shared/types/project-tools'
import { prConflictRequest, type SessionPr } from '../../../../../shared/types/session-status'
import {
  DEFAULT_OVERVIEW_PREFS,
  attentionItems,
  changeRows,
  checkHeadline,
  contextLevel,
  contextRows,
  countsForUsage,
  dockTarget,
  lastTurnDuration,
  mcpActions,
  parseOverviewPrefs,
  prHeadline,
  quotaRows,
  resolvedPrKeys,
  sessionUsage,
  topTools,
} from './overviewModel'

describe('parseOverviewPrefs', () => {
  it('存的不是对象：用默认', () => {
    for (const raw of [null, undefined, 'x', 3, []]) expect(parseOverviewPrefs(raw)).toEqual(DEFAULT_OVERVIEW_PREFS)
  })
  it('字段缺失或类型不对：这一项用默认；数组里只留字符串', () => {
    expect(parseOverviewPrefs({ hidden: ['pr', 1, null], collapsed: 'x' })).toEqual({
      collapsed: DEFAULT_OVERVIEW_PREFS.collapsed,
      hidden: ['pr'],
    })
  })
  it('空数组是用户全展开了，不当成没存', () => {
    expect(parseOverviewPrefs({ collapsed: [], hidden: [] })).toEqual({ collapsed: [], hidden: [] })
  })
})

describe('dockTarget', () => {
  const on = { panelOpen: true, focused: true, tab: 'overview', slot: 'slot' }
  it('右栏开着、当前窗格、选中概况才停靠', () => {
    expect(dockTarget(on)).toBe('slot')
  })
  it.each([
    ['右栏关着', { panelOpen: false }],
    ['别的窗格', { focused: false }],
    ['别的标签', { tab: 'files' }],
    ['全部标签关了', { tab: null }],
    ['概况还没挂载', { slot: null }],
  ])('%s：不停靠', (_, change) => {
    expect(dockTarget({ ...on, ...change })).toBeNull()
  })
})

describe('lastTurnDuration', () => {
  const user = (id: string, reconnect?: true): Item => ({ kind: 'user', id, reconnect }) as unknown as Item
  const stats = (id: string, durationMs?: number): Item =>
    ({ kind: 'turn_stats', id, usage: { durationMs } }) as unknown as Item
  it('只算最近一轮；重连的「继续」算同一轮', () => {
    const items = [user('a'), stats('s1', 500), user('b'), stats('s2', 1000), user('c', true), stats('s3', 2000)]
    expect(lastTurnDuration(items)).toBe(3000)
  })
  it('没有用时：0', () => {
    expect(lastTurnDuration([user('a'), stats('s1')])).toBe(0)
    expect(lastTurnDuration([])).toBe(0)
  })
})

describe('contextLevel', () => {
  it('80 橙，90 红', () => {
    expect([79.9, 80, 89.9, 90].map(contextLevel)).toEqual(['normal', 'warn', 'warn', 'full'])
  })
})

describe('contextRows', () => {
  const base = { input: null, cacheRead: null, cacheWrite: null, output: null, diagnostic: null } as ContextWindow
  it('有诊断：只列真正占用的类，大的在前', () => {
    const diagnostic = {
      categories: [
        { name: 'System tools', tokens: 10, kind: 'used' },
        { name: 'Messages', tokens: 90, kind: 'used' },
        { name: 'Empty', tokens: 0, kind: 'used' },
        { name: 'Free space', tokens: 500, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 400, kind: 'buffer' },
        { name: 'MCP tools (deferred)', tokens: 300, kind: 'deferred' },
      ],
    } as ContextWindow['diagnostic']
    expect(contextRows({ ...base, diagnostic, input: 5 }).map(r => r.tokens)).toEqual([90, 10])
  })
  it('没有诊断：请求计数，没报的和 0 不显示', () => {
    expect(contextRows({ ...base, input: 5, cacheRead: 0, output: 2 }).map(r => r.tokens)).toEqual([5, 2])
    expect(contextRows(base)).toEqual([])
  })
})

describe('quotaRows', () => {
  const card = (over: Partial<QuotaCard>): QuotaCard => ({
    id: 'c',
    type: 'meter',
    name: '本周',
    level: 'normal',
    percent: 38,
    value: '38%',
    unit: '已用',
    note: '周一 08:00 恢复',
    hover: '全写',
    ...over,
  })
  const layout = (o: Partial<QuotaLayout>): QuotaLayout => ({ cards: [], rows: [], alert: null, ...o })
  it('窗口：百分比 · 恢复时间，有条', () => {
    expect(quotaRows(layout({ cards: [card({})] }))[0]).toMatchObject({
      percent: 38,
      value: '38% · 周一 08:00 恢复',
      hover: '全写',
    })
    expect(quotaRows(layout({ cards: [card({ note: '' })] }))[0].value).toBe('38%')
  })
  it('余额、点数：没有条；算不出的不显示', () => {
    const plain = card({ type: 'plain', value: '1,200', unit: '剩余', note: '说明' })
    expect(quotaRows(layout({ cards: [plain] }))[0]).toMatchObject({ percent: null, value: '1,200 剩余' })
    expect(quotaRows(layout({ cards: [card({ type: 'plain', value: '—' })] }))).toEqual([])
  })
  it('卡片在前，小列表在后', () => {
    const row = { id: 'r', name: '本周 · Opus', percent: 90, level: 'warn' as const, value: '90%' }
    expect(quotaRows(layout({ cards: [card({})], rows: [row] })).map(r => r.id)).toEqual(['c', 'r'])
  })
})

describe('sessionUsage', () => {
  const user = (id: string, extra: object = {}): Item => ({ kind: 'user', id, ...extra }) as unknown as Item
  const m = (over: Partial<ModelTurnUsage> = {}): ModelTurnUsage => ({
    input: 1,
    cacheRead: 2,
    cacheWrite: 3,
    output: 4,
    costUsd: 1,
    ...over,
  })
  const stats = (id: string, models: Record<string, ModelTurnUsage>, durationMs = 1000, extra: object = {}): Item =>
    ({ kind: 'turn_stats', id, usage: { models, durationMs, ...extra } }) as unknown as Item
  const costText = (items: Item[]): string | undefined =>
    replyStatParts(sessionUsage(items)!.usage).parts.find(p => p.key === 'cost')?.text
  it('没有一轮结束：null', () => {
    expect(sessionUsage([user('a')])).toBeNull()
    expect(sessionUsage([])).toBeNull()
  })
  it('断线重连的「继续」和引导不算新的一轮', () => {
    const items = [
      user('a'),
      stats('s1', { x: m() }),
      user('b', { reconnect: {} }),
      user('c', { mode: 'guidance' }),
      stats('s2', { x: m() }),
      user('d'),
    ]
    expect(sessionUsage(items)?.turns).toBe(2)
  })
  it('用时和 Token 累加', () => {
    const r = sessionUsage([user('a'), stats('s1', { x: m(), y: m() }, 1000), stats('s2', { x: m() }, 500)])
    expect(r?.usage.durationMs).toBe(1500)
    expect(r?.tokens).toBe(30)
  })
  it('有一轮计数缺失：不显示 Token 合计', () => {
    const broken = m({ cacheWrite: undefined as unknown as number })
    expect(sessionUsage([stats('s1', { x: m() }), stats('s2', { x: broken })])?.tokens).toBeNull()
  })
  it('费用：同一模型某一轮没有费用时显示 ≥，全有时显示 ≈，全没有时不显示', () => {
    expect(costText([stats('s1', { x: m() }), stats('s2', { x: m({ costUsd: null }) })])).toBe('≥ $1.00')
    expect(costText([stats('s1', { x: m() }), stats('s2', { x: m() })])).toBe('≈ $2.00')
    expect(costText([stats('s1', { x: m({ costUsd: null }) })])).toBeUndefined()
  })
  it('结算信息留着：费用按平台口径显示', () => {
    const r = sessionUsage([stats('s1', { x: m() }), stats('s2', { x: m() }, 1000, { settlement: { complete: true } })])
    expect(r?.usage.settlement).toEqual({ complete: true })
  })
  it('判断要不要重算只看 turn_stats 和开启新一轮的 user', () => {
    expect(countsForUsage(user('a'))).toBe(true)
    expect(countsForUsage(user('b', { reconnect: {} }))).toBe(false)
    expect(countsForUsage(stats('s', {}))).toBe(true)
    expect(countsForUsage({ kind: 'assistant', id: 'x' } as unknown as Item)).toBe(false)
  })
})

describe('changeRows', () => {
  const file = (path: string, local: string | null = path): GitFileChange => ({
    path,
    origPath: null,
    code: 'M',
    local,
    submodule: false,
  })
  const none = { conflicted: [], staged: [], unstaged: [], untracked: [] }
  const turn = (...paths: string[]): TurnChanges => ({
    turnKey: 'u1',
    revision: 'r',
    running: false,
    added: 0,
    removed: 0,
    files: paths.map(path => ({ path, name: path, dir: '', kind: 'update', added: 2, removed: 1, diffs: [] })),
  })
  it('这一轮改的排前面，其余保持原来的顺序；放不下的只算个数', () => {
    const { rows, more } = changeRows({ ...none, unstaged: [file('a'), file('b'), file('c'), file('d')] }, turn('c'))
    expect(rows.map(r => r.path)).toEqual(['c', 'a', 'b'])
    expect(rows.map(r => !!r.turn)).toEqual([true, false, false])
    expect(more).toBe(1)
  })
  it('又暂存又没暂存的文件只算一行', () => {
    const { rows, more } = changeRows({ ...none, staged: [file('a')], unstaged: [file('a')] }, null)
    expect(rows.map(r => r.path)).toEqual(['a'])
    expect(more).toBe(0)
  })
  it('显示和对这一轮都用相对工作区的路径，跳转用相对仓库根的；大小写不同也算同一个文件', () => {
    const { rows } = changeRows({ ...none, unstaged: [file('app/src/A.ts', 'src/A.ts')] }, turn('src/a.ts'))
    expect(rows[0]).toMatchObject({ path: 'app/src/A.ts', label: 'src/A.ts' })
    expect(rows[0].turn?.added).toBe(2)
  })
  it('工作区之外的文件显示仓库路径', () => {
    expect(changeRows({ ...none, unstaged: [file('other/x.ts', null)] }, null).rows[0].label).toBe('other/x.ts')
  })
})

describe('checkHeadline', () => {
  const command = (label: string, status: CheckCommandResult['status']): CheckCommandResult => ({
    kind: 'command',
    label,
    command: label,
    status,
    exitCode: null,
    ms: 1,
    output: '',
  })
  const run = (status: CheckRun['status'], items: CheckRun['items']): CheckRun => ({ id: 'r', at: 0, status, items })
  it('跑着', () => {
    expect(checkHeadline(run('running', []))).toEqual({ text: tr('checks.running'), bad: false })
  })
  it('没过：列出没过的命令和页面，红字', () => {
    const page = {
      kind: 'page',
      url: 'http://localhost:1',
      status: 'fail',
      ms: 1,
      shot: null,
      errors: ['x'],
      requests: [],
      reason: null,
      detail: null,
    } as unknown as CheckRun['items'][number]
    const out = checkHeadline(run('done', [command('test', 'fail'), command('lint', 'pass'), page]))
    expect(out.bad).toBe(true)
    expect(out.text).toContain('test')
    expect(out.text).toContain(tr('checks.page'))
    expect(out.text).not.toContain('lint')
  })
  it('全过；什么都没跑不能说全部通过', () => {
    expect(checkHeadline(run('done', [command('test', 'pass')])).text).toBe(tr('overview.checksPassed'))
    const skipped = { kind: 'text', status: 'skipped', findings: [] } as unknown as CheckRun['items'][number]
    expect(checkHeadline(run('done', [skipped])).text).toBe(tr('checks.nothing'))
  })
})

describe('prHeadline', () => {
  const pr = (over: Partial<SessionPr>): SessionPr => ({
    repo: 'o/r',
    number: 1,
    url: 'u',
    title: 't',
    state: 'open',
    ci: null,
    ciFailed: 0,
    conflict: false,
    additions: 0,
    deletions: 0,
    head: 'h',
    base: 'b',
    closedAt: null,
    ...over,
  })
  it('查不到状态：没有摘要', () => {
    expect(prHeadline(pr({ unknown: true }))).toBeNull()
  })
  it('开着的冲突、检查没过是红字，冲突优先', () => {
    expect(prHeadline(pr({ conflict: true, ci: 'fail' }))).toEqual({
      text: tr('sidebar.status.pr.conflict'),
      bad: true,
    })
    expect(prHeadline(pr({ ci: 'fail' }))?.bad).toBe(true)
  })
  it('合并了就不再提冲突和检查', () => {
    expect(prHeadline(pr({ state: 'merged', conflict: true, ci: 'fail' }))).toEqual({
      text: tr('sidebar.status.pr.merged'),
      bad: false,
    })
  })
  it('开着：状态加检查', () => {
    expect(prHeadline(pr({ ci: 'pending' }))?.text).toBe(
      `${tr('sidebar.status.pr.open')} · ${tr('sidebar.status.pr.ciPending')}`,
    )
    expect(prHeadline(pr({}))?.text).toBe(tr('sidebar.status.pr.open'))
  })
})

describe('mcpActions', () => {
  const report = (live: boolean, ...ops: ('reconnect' | 'toggle' | 'login')[]) => ({ servers: [], at: 0, live, ops })
  const none = { login: false, reconnect: false, toggle: false }
  it('进程没在跑或还没有报告：什么操作都不给（点了会报错）', () => {
    expect(mcpActions('auth', report(false, 'login', 'reconnect', 'toggle'))).toEqual(none)
    expect(mcpActions('idle', null)).toEqual(none)
  })
  it('引擎不支持的不给（Codex 没有启停）', () => {
    expect(mcpActions('connected', report(true, 'reconnect', 'login'))).toEqual({ ...none, reconnect: true })
  })
  it('要登录给登录；引擎不能在这里登录时退回重连', () => {
    expect(mcpActions('auth', report(true, 'login', 'reconnect'))).toEqual({ ...none, login: true })
    expect(mcpActions('auth', report(true, 'reconnect'))).toEqual({ ...none, reconnect: true })
  })
  it('连接中、已停用不给重连，启停还在', () => {
    for (const status of ['pending', 'disabled'] as const)
      expect(mcpActions(status, report(true, 'reconnect', 'toggle'))).toEqual({ ...none, toggle: true })
  })
})

describe('topTools', () => {
  const tools = ['a', 'b', 'c'].map(name => ({ name })) as never
  it('调用多的在前，没调用过的保持报告的顺序', () => {
    expect(topTools({ tools, toolCalls: { c: 2 } }).tools.map(t => t.name)).toEqual(['c', 'a', 'b'])
  })
  it('放不下的只报个数', () => {
    const out = topTools({ tools, toolCalls: {} }, 2)
    expect(out.tools.map(t => t.name)).toEqual(['a', 'b'])
    expect(out.more).toBe(1)
  })
})

describe('attentionItems', () => {
  const base = {
    pending: [],
    cwd: null,
    connectors: [],
    report: null,
    check: null,
    prs: [],
    context: null,
    quota: null,
    now: 1_000,
    dismissed: new Set<string>(),
  }
  const approval = (requestId: string, command: string): ApprovalRequest => ({
    requestId,
    itemId: null,
    kind: 'command',
    title: '运行命令',
    command,
    alwaysScopes: [],
  })
  const connector = (name: string, status: Connector['status'], error: string | null = null): Connector => ({
    name,
    status,
    error,
    tools: [],
    calls: 0,
    toolCalls: {},
    source: 'user',
    sourceDetail: null,
    version: null,
    config: null,
  })
  const report = (live: boolean, ops: McpReport['ops'] = ['login', 'reconnect']): McpReport => ({
    servers: [],
    ops,
    at: 0,
    live,
  })
  const run = (status: 'pass' | 'fail'): CheckRun => ({
    id: 'r1',
    at: 0,
    status: 'done',
    items: [{ kind: 'command', label: 'test', command: 'pnpm test', status, exitCode: 0, ms: 1, output: '' }],
  })
  const pr = (over: Partial<SessionPr>): SessionPr => ({
    repo: 'o/r',
    number: 7,
    url: 'https://x/7',
    title: 't',
    state: 'open',
    ci: null,
    ciFailed: 0,
    conflict: false,
    additions: 0,
    deletions: 0,
    head: 'feat',
    base: 'main',
    closedAt: null,
    ...over,
  })
  const context = (used: number, compacting = false): ContextWindow =>
    ({ used, window: 100, compacting }) as unknown as ContextWindow
  const quota = (percent: number, resetsAt: number | null = 61_000): QuotaEntry =>
    ({ label: '本周', percent, resetsAt }) as unknown as QuotaEntry
  const keys = (o: Partial<Parameters<typeof attentionItems>[0]>): string[] =>
    attentionItems({ ...base, ...o }).map(i => i.key)

  it('什么事都没有：空的', () => {
    expect(attentionItems(base)).toEqual([])
  })

  it('顺序：审批、MCP、检查、PR、上下文、额度', () => {
    expect(
      keys({
        quota: quota(95),
        context: context(95),
        prs: [pr({ conflict: true })],
        check: run('fail'),
        connectors: [connector('a', 'auth')],
        report: report(true),
        pending: [approval('q1', 'pnpm publish')],
      }),
    ).toEqual(['approval:q1', 'mcp:a', 'check:r1', 'pr-conflict:https://x/7', 'context', 'quota'])
  })

  it('一项审批写明要做什么；几项合成一行，跳到第一项', () => {
    const [one] = attentionItems({ ...base, pending: [approval('q1', 'pnpm publish')] })
    expect(one!.text).toContain('pnpm publish')
    expect(one!.action).toEqual({ kind: 'approval', requestId: 'q1' })
    const many = attentionItems({ ...base, pending: [approval('q1', 'a'), approval('q2', 'b')] })
    expect(many).toHaveLength(1)
    expect(many[0]!.sub).toBe('a')
    expect(many[0]!.action).toEqual({ kind: 'approval', requestId: 'q1' })
  })

  it('提问和计划用标题，不用摘要拼的参数', () => {
    const question: ApprovalRequest = {
      ...approval('q1', ''),
      kind: 'question',
      title: 'Claude 想问你',
      command: undefined,
    }
    expect(attentionItems({ ...base, pending: [question] })[0]!.text).toContain('Claude 想问你')
  })

  it('MCP：引擎进程没在跑不提；要登录给登录，连不上给重连，错误只取第一行', () => {
    const connectors = [connector('a', 'auth'), connector('b', 'failed', '超时\n  at x'), connector('c', 'connected')]
    expect(keys({ connectors, report: report(false) })).toEqual([])
    expect(keys({ connectors, report: null })).toEqual([])
    const items = attentionItems({ ...base, connectors, report: report(true) })
    expect(items.map(i => i.action)).toEqual([
      { kind: 'mcp-login', name: 'a' },
      { kind: 'mcp-reconnect', name: 'b' },
    ])
    expect(items[1]!.sub).toBe('超时')
  })

  it('MCP：引擎不支持这些操作时还提，只是没有按钮', () => {
    const items = attentionItems({ ...base, connectors: [connector('b', 'failed')], report: report(true, []) })
    expect(items).toHaveLength(1)
    expect(items[0]!.action).toBeNull()
  })

  it('检查：没过才提，通过、还在跑的不提', () => {
    expect(keys({ check: run('fail') })).toEqual(['check:r1'])
    expect(keys({ check: run('pass') })).toEqual([])
    expect(keys({ check: { ...run('fail'), status: 'running' } })).toEqual([])
  })

  it('PR：有冲突发消息，检查没过去打开；同一个 PR 只一条，冲突优先；草稿、查不到状态的不提', () => {
    expect(attentionItems({ ...base, prs: [pr({ conflict: true, ci: 'fail' })] }).map(i => i.action?.kind)).toEqual([
      'pr-conflict',
    ])
    expect(attentionItems({ ...base, prs: [pr({ ci: 'fail' })] }).map(i => i.action?.kind)).toEqual(['pr-ci'])
    expect(keys({ prs: [pr({ conflict: true, state: 'draft' }), pr({ ci: 'fail', unknown: true })] })).toEqual([])
  })

  it('上下文：90% 才提，正在压缩时不提', () => {
    expect(keys({ context: context(89) })).toEqual([])
    expect(keys({ context: context(90) })).toEqual(['context'])
    expect(keys({ context: context(95, true) })).toEqual([])
  })

  it('额度：90% 才提，没有操作，知道恢复时间才写', () => {
    expect(keys({ quota: quota(89) })).toEqual([])
    const [item] = attentionItems({ ...base, quota: quota(94) })
    expect(item!.action).toBeNull()
    expect(item!.sub).toBeTruthy()
    expect(attentionItems({ ...base, quota: quota(94, null) })[0]!.sub).toBeUndefined()
  })

  it('点过的不再提；检查和 PR 的键互不影响', () => {
    const all = { check: run('fail'), prs: [pr({ conflict: true })] }
    expect(keys({ ...all, dismissed: new Set(['check:r1']) })).toEqual(['pr-conflict:https://x/7'])
    expect(keys({ ...all, dismissed: new Set(['pr-conflict:https://x/7']) })).toEqual(['check:r1'])
  })
})

describe('resolvedPrKeys', () => {
  const pr = (over: Partial<SessionPr>): SessionPr => ({ url: 'u', conflict: false, ci: null, ...over }) as SessionPr
  it('没这个问题了的键要忘掉，还有问题的留着', () => {
    expect(resolvedPrKeys([pr({ conflict: true, ci: 'fail' })])).toEqual([])
    expect(resolvedPrKeys([pr({ ci: 'pending' })])).toEqual(['pr-conflict:u', 'pr-ci:u'])
    expect(resolvedPrKeys([pr({ conflict: true })])).toEqual(['pr-ci:u'])
  })
  it('查不到状态不算解决了', () => {
    expect(resolvedPrKeys([pr({ unknown: true })])).toEqual([])
  })
})

describe('prConflictRequest', () => {
  it('写明 PR、两个分支；是普通文字，不会被当成斜杠命令', () => {
    const text = prConflictRequest({ url: 'https://x/7', head: 'feat/a', base: 'main' })
    for (const part of ['https://x/7', 'feat/a', 'main']) expect(text).toContain(part)
    expect(text.startsWith('/')).toBe(false)
  })
})
