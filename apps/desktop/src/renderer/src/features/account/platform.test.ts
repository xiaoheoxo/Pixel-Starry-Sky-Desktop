import { describe, expect, it } from 'vitest'
import { classifyError, platformNoticeText } from '../session/live/errorKind'
import {
  formatMultiplier,
  groupProblem,
  groupsForModel,
  noRouteReason,
  platformModels,
  resolvePlatform,
  visibleModels,
  groupSupportsEngine,
  refreshedSelection,
  type PlatformGroup,
} from './platform'

function group(id: string, rate: number, models: string[]): PlatformGroup {
  return {
    id,
    name: `g${id}`,
    description: '',
    platform: 'anthropic',
    rate_multiplier: rate,
    billing_source: 'balance_only',
    models,
    modelsError: null,
  }
}

// 管理员排序：1、2、3
const groups = [
  group('1', 1, ['opus', 'sonnet']),
  group('2', 0.6, ['sonnet', 'haiku']),
  group('3', 0.6, ['sonnet']),
  group('4', 0, []),
]

describe('平台目录：先选模型、再选线路（docs/ui/source-switch.md §3.2）', () => {
  it('按声明的协议能力筛选引擎，旧 OpenAI 组只给 Codex，保留有效倍率', () => {
    const openai = { ...group('5', 0.8, ['gpt-model']), platform: 'openai' }
    expect(groupSupportsEngine(openai, 'codex')).toBe(true)
    expect(groupSupportsEngine(openai, 'claude')).toBe(false)
    expect(groupSupportsEngine({ ...openai, supported_engines: ['claude', 'codex'] }, 'claude')).toBe(true)
    expect(groupSupportsEngine(group('1', 1, ['opus']), 'codex')).toBe(false)
  })
  it('模型并集按分组顺序去重', () => {
    expect(platformModels(groups)).toEqual(['opus', 'sonnet', 'haiku'])
  })

  it('线路只列包含该模型的，按倍率从低到高，同倍率按管理员排序；零倍率有效', () => {
    expect(groupsForModel(groups, 'sonnet').map(g => g.id)).toEqual(['2', '3', '1'])
    expect(groupsForModel(groups, 'opus').map(g => g.id)).toEqual(['1'])
    expect(groupsForModel([group('9', 0, ['x']), group('8', 1, ['x'])], 'x').map(g => g.id)).toEqual(['9', '8'])
  })

  it('对齐：原线路有这个模型就不动；没有就换到倍率最低的线路', () => {
    expect(resolvePlatform(groups, '1', 'sonnet')).toEqual({ groupId: '1', model: 'sonnet' })
    expect(resolvePlatform(groups, '1', 'haiku')).toEqual({ groupId: '2', model: 'haiku' })
  })

  it('对齐：模型不在了保线路取第一个模型；线路也不在了取第一个有模型的线路；目录空时都是 null', () => {
    expect(resolvePlatform(groups, '2', 'gone')).toEqual({ groupId: '2', model: 'sonnet' })
    expect(resolvePlatform(groups, '4', null)).toEqual({ groupId: '1', model: 'opus' })
    expect(resolvePlatform([], '1', 'opus')).toEqual({ groupId: null, model: null })
  })

  it('重读目录：只在 Claude Code 能用的分组里对齐，不会换到只有 Codex 能用的分组', () => {
    const codex = { ...group('5', 0.1, ['gpt-6-astra']), platform: 'openai' }
    expect(refreshedSelection([codex, group('2', 1, ['claude-sonnet'])], '9', 'gone')).toEqual({
      groupId: '2',
      model: 'claude-sonnet',
    })
    expect(refreshedSelection([codex], '1', 'claude-opus')).toEqual({ groupId: null, model: null })
  })

  it('重读目录：有分组读模型失败（余额 ≤ 0 时读不出）就不改已存的选择', () => {
    const blocked = { ...group('1', 1, []), modelsError: '无法读取该分组的模型' }
    expect(refreshedSelection([blocked, group('3', 0, []), group('2', 1, ['claude-x'])], '1', 'claude-opus')).toEqual(
      {},
    )
    expect(refreshedSelection([blocked], '1', 'claude-opus')).toEqual({})
  })

  it('倍率显示最多三位小数', () => {
    expect([1, 0.6, 0, 0.125, 1.23456].map(formatMultiplier)).toEqual(['×1', '×0.6', '×0', '×0.125', '×1.235'])
  })
})

describe('错误卡片归类（§3.5）', () => {
  it('按文字归类', () => {
    expect(classifyError('登录已失效：在终端运行 claude auth login 重新登录')).toBe('auth')
    expect(classifyError('平台账号已退出或切换，请重新登录原账号')).toBe('auth')
    expect(classifyError('账户余额或账单有问题')).toBe('balance')
    expect(classifyError('API Error: 402 insufficient balance')).toBe('balance')
    expect(classifyError('找不到所选模型')).toBe('route')
    expect(classifyError('API Error: 403 group not available')).toBe('route')
    expect(classifyError('请求太频繁，已触发限额')).toBe('busy')
    expect(classifyError('工作目录不存在')).toBeNull()
    // 第二轮的新说法（docs/ui/conversation-ux-2.md §2.1）
    expect(classifyError('API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY')).toBe('auth')
    expect(classifyError('没有权限：当前账号或 API Key 不能用这个模型或资源')).toBe('route')
    expect(classifyError('服务出错，通常是暂时的，稍后再试')).toBe('busy')
    expect(classifyError('连不上模型服务：检查网络、代理或防火墙')).toBeNull()
  })

  it('平台会话的「登录已失效」换成平台的说法，自有会话不变', () => {
    const text = '登录已失效：在终端运行 claude auth login 重新登录'
    expect(platformNoticeText({ platform: { groupId: '1', account: 'a@b.c' } }, text)).toMatch(/^平台登录已失效/)
    expect(platformNoticeText({ platform: null }, text)).toBe(text)
  })
})

describe('没有可用线路的原因（余额为 0 时 Sub2api 不给读模型）', () => {
  const failed = (id: string, billing: string): PlatformGroup => ({
    ...group(id, 1, []),
    billing_source: billing,
    modelsError: '无法读取该分组的模型',
  })

  it('余额计费的线路、余额为 0、模型读不出来：提示充值', () => {
    const r = noRouteReason({ groups: [failed('2', 'balance_only')], error: '无法读取该分组的模型' }, 0)
    expect(r.balance).toBe(true)
    expect(r.message).toMatch(/^余额不足/)
    expect(groupProblem(failed('2', 'balance_only'), 0)).toMatch(/^余额不足/)
  })

  it('有余额或订阅线路时按原错误说，不误报余额', () => {
    expect(noRouteReason({ groups: [failed('2', 'balance_only')], error: null }, 5)).toEqual({
      message: '模型读取失败：无法读取该分组的模型',
      balance: false,
    })
    expect(noRouteReason({ groups: [failed('3', 'plan_only')], error: null }, 0).balance).toBe(false)
    expect(noRouteReason({ groups: [], error: null }, 0).message).toMatch(/^暂无可用线路/)
  })
})

describe('菜单里显示的模型（§8）', () => {
  it('隐藏的不列，正在用的和默认模型照常显示', () => {
    const all = ['opus', 'sonnet', 'haiku', 'opus-20251101']
    expect(visibleModels(all, ['haiku', 'opus-20251101'], [null, null])).toEqual(['opus', 'sonnet'])
    expect(visibleModels(all, ['haiku', 'opus-20251101'], ['haiku', 'sonnet'])).toEqual(['opus', 'sonnet', 'haiku'])
    expect(visibleModels(all, all, [null, null])).toEqual([])
  })
})
