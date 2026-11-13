// 「/」菜单里像素星空自己处理的 Codex 命令（docs/ui/codex-flow-slash-feedback.md B，D277）
import { describe, expect, it, vi } from 'vitest'
import { appCommandsFor, runAppCommand, typedAppCommand, type AppCommandContext } from './appCommands'

function context(patch: Partial<AppCommandContext['live']> = {}, extra: Partial<AppCommandContext> = {}) {
  const live: AppCommandContext['live'] = {
    sessionId: 's1',
    started: true,
    fast: false,
    fastSupported: true,
    fastAvailable: true,
    fastBlocked: null,
    setFast: vi.fn(),
    permissionMode: 'edits',
    permissionModes: ['ask', 'edits', 'plan', 'full'],
    defaultPermissionMode: 'ask',
    setPermissionMode: vi.fn(),
    ...patch,
  }
  const ctx: AppCommandContext = {
    live,
    newChat: vi.fn(),
    fork: vi.fn(),
    openSide: vi.fn(),
    archive: vi.fn(),
    openModelMenu: vi.fn(),
    openEffortMenu: vi.fn(),
    openOverview: vi.fn(),
    openFeedback: vi.fn(),
    ...extra,
  }
  return ctx
}
const names = (ctx: AppCommandContext, engine: 'codex' | 'claude' = 'codex') =>
  appCommandsFor(engine, ctx).map(c => c.name)

describe('像素星空处理的 Codex 命令', () => {
  it('只在 Codex 会话里列，按 对话 → 模型与模式 → 查看 排', () => {
    expect(names(context(), 'claude')).toEqual([])
    const list = appCommandsFor('codex', context())
    expect(list.map(c => c.name)).toEqual([
      'new',
      'fork',
      'side',
      'archive',
      'model',
      'effort',
      'fast',
      'plan',
      'status',
      'mcp',
      'feedback',
    ])
    expect(list.map(c => c.group)).toEqual([
      'chat',
      'chat',
      'chat',
      'chat',
      'mode',
      'mode',
      'mode',
      'mode',
      'view',
      'view',
      'view',
    ])
  })

  it('拿不到入口的不列：没开始的对话不能分支，没有旁聊、归档，引擎没有 Fast、计划模式；新任务页只剩不依赖会话的', () => {
    const notStarted = names(context({ started: false }, { openSide: null, archive: null }))
    expect(notStarted).not.toContain('fork')
    expect(notStarted).not.toContain('side')
    expect(notStarted).not.toContain('archive')
    expect(names(context({ fastSupported: false, permissionModes: ['ask', 'full'] }))).not.toEqual(
      expect.arrayContaining(['fast']),
    )
    expect(names(context({ permissionModes: ['ask', 'full'] }))).not.toContain('plan')
    expect(names(context({ sessionId: null, started: false }, { openSide: null, archive: null }))).toEqual([
      'model',
      'effort',
      'fast',
      'plan',
      'feedback',
    ])
  })

  it('/fast 开不了时不改、返回原因；能开就切换', () => {
    const blocked = context({ fastAvailable: false, fastBlocked: '当前模型没有 Fast' })
    expect(runAppCommand('fast', blocked)).toBe('当前模型没有 Fast')
    expect(blocked.live.setFast).not.toHaveBeenCalled()
    const on = context({ fast: true, fastAvailable: false })
    expect(runAppCommand('fast', on)).toBeNull()
    expect(on.live.setFast).toHaveBeenCalledWith(false)
  })

  it('/plan 进计划模式；再来一次回到这个引擎新会话的默认权限（默认就是计划时回到编辑）', () => {
    const a = context()
    runAppCommand('plan', a)
    expect(a.live.setPermissionMode).toHaveBeenCalledWith('plan')
    const b = context({ permissionMode: 'plan' })
    runAppCommand('plan', b)
    expect(b.live.setPermissionMode).toHaveBeenCalledWith('ask')
    const c = context({ permissionMode: 'plan', defaultPermissionMode: 'plan' })
    runAppCommand('plan', c)
    expect(c.live.setPermissionMode).toHaveBeenCalledWith('edits')
  })

  it('各命令调到对应的入口；表里没有的、现在不能用的返回 undefined', () => {
    const ctx = context()
    runAppCommand('side', ctx)
    runAppCommand('status', ctx)
    runAppCommand('effort', ctx)
    expect(ctx.openSide).toHaveBeenCalled()
    expect(ctx.openOverview).toHaveBeenCalled()
    expect(ctx.openEffortMenu).toHaveBeenCalled()
    expect(runAppCommand('compact', ctx)).toBeUndefined()
    expect(runAppCommand('side', context({}, { openSide: null }))).toBeUndefined()
    // 代码模式没有右栏概况：/status、/mcp 不列
    expect(names(context({}, { openOverview: null }))).not.toContain('status')
    expect(names(context({}, { openOverview: null }))).not.toContain('mcp')
  })

  it('手打的整段命令才算；带参数的、表里没有的照原样发给引擎', () => {
    expect(typedAppCommand('/fast')).toBe('fast')
    expect(typedAppCommand('  /plan  ')).toBe('plan')
    expect(typedAppCommand('/fast 打开')).toBeNull()
    expect(typedAppCommand('/compact')).toBeNull()
    expect(typedAppCommand('/goal 修好测试')).toBeNull()
    expect(typedAppCommand('fast')).toBeNull()
  })
})
