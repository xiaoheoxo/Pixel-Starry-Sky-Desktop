import { describe, expect, it } from 'vitest'
import type { NativeSessionDetail, NativeSessionSummary } from '@pixelsky/protocol'
import type { PlatformGroup } from '@/features/account/platform'
import {
  canCopyImported,
  filterRows,
  groupRows,
  isResumeLiveError,
  mergeRows,
  moveSelection,
  needsChoice,
  loadingImportedEngine,
  parseResumeCommand,
  resumeModel,
  rowAction,
  unreadableText,
  type ResumeRow,
} from './model'

const ID = '3f1c2a10-6d7e-4b88-9a31-0c5d8e7a1001'
const summary = (id: string, extra: Partial<NativeSessionSummary> = {}): NativeSessionSummary => ({
  id,
  title: id,
  firstPrompt: '',
  lastPrompt: null,
  branch: null,
  subdir: null,
  updatedAt: 1000,
  size: 1,
  model: null,
  source: 'terminal',
  ownerId: null,
  live: null,
  ...extra,
})
const rows = (...list: Array<Partial<NativeSessionSummary> & { id: string }>): ResumeRow[] =>
  mergeRows(
    list.map(r => summary(r.id, r)),
    new Map(),
  )
const detail = (id: string, extra: Partial<NativeSessionDetail> = {}): NativeSessionDetail => ({
  id,
  lastPrompt: null,
  title: id,
  lastActive: null,
  model: null,
  branch: null,
  superseded: false,
  skipped: false,
  ...extra,
})

describe('mergeRows', () => {
  it('第二步补上最后一句、标题和模型，排序用的 updatedAt 不变', () => {
    const merged = mergeRows(
      [summary('a', { title: '第一句', updatedAt: 5 })],
      new Map([
        ['a', detail('a', { title: 'AI 标题', lastPrompt: '最后一句', model: 'claude-opus-4-1', lastActive: 99 })],
      ]),
    )
    expect(merged[0]).toMatchObject({
      title: 'AI 标题',
      lastPrompt: '最后一句',
      model: 'claude-opus-4-1',
      updatedAt: 5,
      activeAt: 99,
    })
  })
  it('已经接到别的会话里的不显示；预算用完的行保持第一步的内容', () => {
    const merged = mergeRows(
      [summary('a'), summary('b', { title: '原标题' })],
      new Map([
        ['a', detail('a', { superseded: true })],
        ['b', detail('b', { skipped: true, title: '不该用' })],
      ]),
    )
    expect(merged.map(r => r.id)).toEqual(['b'])
    expect(merged[0].title).toBe('原标题')
  })
})

describe('filterRows', () => {
  const list = rows(
    { id: 'aaaa1111-0000-4000-8000-000000000001', title: '修复 Caddy 超时', firstPrompt: '上传会 499' },
    { id: 'bbbb2222-0000-4000-8000-000000000002', title: '重构', lastPrompt: '跑一下 Extpacks 检查' },
    { id: 'cccc3333-0000-4000-8000-000000000003', title: '手机端', subdir: 'apps/mobile' },
  )
  it('标题、最后一句、第一句、子文件夹、id 前缀，不区分大小写', () => {
    expect(filterRows(list, 'caddy').map(r => r.title)).toEqual(['修复 Caddy 超时'])
    expect(filterRows(list, 'EXTPACKS').map(r => r.title)).toEqual(['重构'])
    expect(filterRows(list, '499').map(r => r.title)).toEqual(['修复 Caddy 超时'])
    expect(filterRows(list, 'apps/mobile').map(r => r.title)).toEqual(['手机端'])
    expect(filterRows(list, 'BBBB2').map(r => r.title)).toEqual(['重构'])
  })
  it('空关键词全留；多个词要同时命中；id 只认前缀', () => {
    expect(filterRows(list, '  ')).toHaveLength(3)
    expect(filterRows(list, 'caddy 499')).toHaveLength(1)
    expect(filterRows(list, 'caddy 手机')).toHaveLength(0)
    expect(filterRows(list, '2222')).toHaveLength(0)
  })
})

describe('groupRows', () => {
  it('已被占用的收到底部，两组都从新到旧，默认选中的第一行是最近一个能接的', () => {
    const g = groupRows(
      rows(
        { id: 'old', updatedAt: 1 },
        { id: 'owned-new', updatedAt: 9, ownerId: 'conv' },
        { id: 'new', updatedAt: 5 },
        { id: 'owned-old', updatedAt: 2, ownerId: 'conv2' },
      ),
    )
    expect(g.free.map(r => r.id)).toEqual(['new', 'old'])
    expect(g.owned.map(r => r.id)).toEqual(['owned-new', 'owned-old'])
    expect(g.all.map(r => r.id)).toEqual(['new', 'old', 'owned-new', 'owned-old'])
  })
})

describe('rowAction / needsChoice', () => {
  it('占用 → 跳过去；终端 / 别的程序正开着 → 复制；可能还开着和没开着 → 原地', () => {
    expect(rowAction({ ownerId: 'x', live: 'terminal' })).toBe('open')
    expect(rowAction({ ownerId: null, live: 'terminal' })).toBe('copy')
    expect(rowAction({ ownerId: null, live: 'other' })).toBe('copy')
    expect(rowAction({ ownerId: null, live: 'maybe' })).toBe('inplace')
    expect(rowAction({ ownerId: null, live: null })).toBe('inplace')
  })
  it('正开着和可能还开着的行选中时展开选择', () => {
    expect(needsChoice({ ownerId: null, live: 'maybe' })).toBe(true)
    expect(needsChoice({ ownerId: null, live: null })).toBe(false)
    expect(needsChoice({ ownerId: 'x', live: 'terminal' })).toBe(false)
  })
})

describe('moveSelection', () => {
  it('上下循环，翻页和首尾不循环', () => {
    expect(moveSelection(0, 'ArrowUp', 5)).toBe(4)
    expect(moveSelection(4, 'ArrowDown', 5)).toBe(0)
    expect(moveSelection(1, 'PageDown', 20)).toBe(9)
    expect(moveSelection(18, 'PageDown', 20)).toBe(19)
    expect(moveSelection(3, 'PageUp', 20)).toBe(0)
    expect(moveSelection(7, 'Home', 20)).toBe(0)
    expect(moveSelection(7, 'End', 20)).toBe(19)
    expect(moveSelection(0, 'ArrowDown', 0)).toBe(0)
  })
})

describe('parseResumeCommand', () => {
  it('/resume 打开列表；带关键词预过滤；完整 uuid 直接打开', () => {
    expect(parseResumeCommand('/resume')).toEqual({ id: null, query: '' })
    expect(parseResumeCommand('  /resume  caddy 超时 ')).toEqual({ id: null, query: 'caddy 超时' })
    expect(parseResumeCommand(`/resume ${ID.toUpperCase()}`)).toEqual({ id: ID, query: '' })
    expect(parseResumeCommand('/resume 3f1c2a10')).toEqual({ id: null, query: '3f1c2a10' })
  })
  it('别的文字不拦', () => {
    expect(parseResumeCommand('/resumed')).toBeNull()
    expect(parseResumeCommand('请 /resume')).toBeNull()
    expect(parseResumeCommand('/btw hi')).toBeNull()
  })
})

const group = (id: string, models: string[], rate = 1): PlatformGroup =>
  ({ id, name: id, models, rate_multiplier: rate }) as unknown as PlatformGroup

describe('resumeModel（用会话最后用的模型，当前通道跑不了就用输入框的）', () => {
  const base = {
    model: 'composer-model',
    groupId: 'g1',
    groups: [group('g1', ['m-a']), group('g2', ['m-b'], 0.5)],
    selfModels: [null, 'opus'],
  }
  it('平台：有线路带这个模型就用它；当前线路有就不换线路，否则换倍率最低的', () => {
    expect(resumeModel({ ...base, source: 'platform', sessionModel: 'm-a' })).toEqual({ model: 'm-a', groupId: 'g1' })
    expect(resumeModel({ ...base, source: 'platform', sessionModel: 'm-b' })).toEqual({ model: 'm-b', groupId: 'g2' })
    expect(resumeModel({ ...base, source: 'platform', sessionModel: 'm-zzz' })).toEqual({
      model: 'composer-model',
      groupId: 'g1',
    })
  })
  it('自有额度：在模型菜单里才用；自定义接口一律用输入框的', () => {
    expect(resumeModel({ ...base, source: 'self', sessionModel: 'opus' })).toEqual({ model: 'opus', groupId: null })
    expect(resumeModel({ ...base, source: 'self', sessionModel: 'claude-x' })).toEqual({
      model: 'composer-model',
      groupId: 'g1',
    })
    expect(resumeModel({ ...base, source: 'custom', sessionModel: 'opus' })).toEqual({
      model: 'composer-model',
      groupId: 'g1',
    })
  })
  it('Codex：会话的模型（Thread.model）和 Claude 走同一套规则', () => {
    const codex = {
      ...base,
      groups: [group('g1', ['m-a']), group('g2', ['gpt-5-codex'], 0.5)],
      selfModels: ['gpt-5-codex'],
    }
    expect(resumeModel({ ...codex, source: 'platform', sessionModel: 'gpt-5-codex' })).toEqual({
      model: 'gpt-5-codex',
      groupId: 'g2',
    })
    expect(resumeModel({ ...codex, source: 'self', sessionModel: 'gpt-5-codex' })).toEqual({
      model: 'gpt-5-codex',
      groupId: null,
    })
    expect(resumeModel({ ...codex, source: 'self', sessionModel: 'o3-old' }).model).toBe('composer-model')
  })
  it('没有模型和 <synthetic> 都用输入框的', () => {
    expect(resumeModel({ ...base, source: 'self', sessionModel: null }).model).toBe('composer-model')
    expect(resumeModel({ ...base, source: 'platform', sessionModel: '<synthetic>' }).model).toBe('composer-model')
  })
})

describe('canCopyImported（队列里「复制一份接着聊」的条件）', () => {
  const X = '0199c2a1-7b3e-7c40-8a1d-5e2f9b0c3001'
  const record = (
    over: {
      engine?: string
      engineSessionId?: string | null
      imported?: { engine: string; sessionId: string; forked?: boolean } | null
    } = {},
  ): Parameters<typeof canCopyImported>[0] => ({
    engine: 'codex',
    engineSessionId: X,
    imported: { engine: 'codex', sessionId: X },
    ...over,
  })
  it('原地导入、执行者没换、线程 id 还是导入的那个才给', () => {
    expect(canCopyImported(record())).toBe(true)
    expect(canCopyImported(record({ imported: { engine: 'codex', sessionId: X, forked: false } }))).toBe(true)
  })
  it('没导入过、已经是复制出来的不给', () => {
    expect(canCopyImported(record({ imported: null }))).toBe(false)
    expect(canCopyImported(record({ imported: undefined }))).toBe(false)
    expect(canCopyImported(record({ imported: { engine: 'codex', sessionId: X, forked: true } }))).toBe(false)
    expect(canCopyImported(null)).toBe(false)
    expect(canCopyImported(undefined)).toBe(false)
  })
  it('换过执行者（导入的是 Claude，现在是 Codex）不给', () => {
    expect(canCopyImported(record({ imported: { engine: 'claude', sessionId: X } }))).toBe(false)
  })
  it('线程 id 不再是导入的会话（回退后改开了新线程，或还没有）不给', () => {
    expect(canCopyImported(record({ engineSessionId: 'other-thread' }))).toBe(false)
    expect(canCopyImported(record({ engineSessionId: null }))).toBe(false)
  })
})

describe('loadingImportedEngine（「正在加载 X 会话」用哪个引擎）', () => {
  const X = '0199c2a1-7b3e-7c40-8a1d-5e2f9b0c3001'
  it('执行者还是导入的引擎、还接着导入的会话：用执行者的名字', () => {
    expect(
      loadingImportedEngine({ engine: 'codex', engineSessionId: X, imported: { engine: 'codex', sessionId: X } }),
    ).toBe('codex')
  })
  it('复制出来、还没启动过（pendingFork 指向导入的会话）也算第一次启动', () => {
    expect(
      loadingImportedEngine({
        engine: 'codex',
        engineSessionId: null,
        pendingFork: { from: X },
        imported: { engine: 'codex', sessionId: X, forked: true },
      }),
    ).toBe('codex')
  })
  it('换了执行者、线程已经换掉、没导入过：用普通的启动文字（null）', () => {
    expect(
      loadingImportedEngine({ engine: 'claude', engineSessionId: X, imported: { engine: 'codex', sessionId: X } }),
    ).toBeNull()
    expect(
      loadingImportedEngine({ engine: 'codex', engineSessionId: 'new', imported: { engine: 'codex', sessionId: X } }),
    ).toBeNull()
    expect(loadingImportedEngine({ engine: 'codex', engineSessionId: X })).toBeNull()
    expect(loadingImportedEngine(null)).toBeNull()
  })
})

describe('unreadableText（读不到会话的文字）', () => {
  // 引擎真实抛的整句（packages/engine/src/native/text.ts 的 codexUnavailable，后面可以接冒号和原因）
  const ENGINE_SENTENCE = 'Codex 没装好，读不到它的会话'
  it('Codex 没装好：引擎那句整句显示，不再套一层', () => {
    expect(unreadableText('codex', ENGINE_SENTENCE)).toBe(ENGINE_SENTENCE)
    expect(unreadableText('codex', ENGINE_SENTENCE + '：spawn ENOENT')).toBe(ENGINE_SENTENCE + '：spawn ENOENT')
    expect(unreadableText('codex', ENGINE_SENTENCE).match(/读不到/g)).toHaveLength(1)
  })
  it('别的错误照旧套「读不到……」', () => {
    expect(unreadableText('codex', 'EACCES')).toBe('读不到 Codex 的会话：EACCES')
    expect(unreadableText('claude', '无权限')).toBe('读不到 Claude Code 的会话目录：无权限')
  })
})

describe('isResumeLiveError', () => {
  it('认带代码的 resume.live，也认外面又拼了前缀的', () => {
    const err = 'PIXELSKY_ERR:{"code":"resume.live","params":{"source":"terminal"}}'
    expect(isResumeLiveError(err)).toBe(true)
    expect(isResumeLiveError('启动失败：' + err)).toBe(true)
    expect(isResumeLiveError('PIXELSKY_ERR:{"code":"files.exists"}')).toBe(false)
    expect(isResumeLiveError(null)).toBe(false)
  })
})
