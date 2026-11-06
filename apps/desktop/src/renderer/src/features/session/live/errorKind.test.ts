// 错误卡片的归类和按钮（docs/ui/source-switch.md §3.5）：结构化的 kind 优先，没有才按文字猜；上下文超限给「压缩后重试」
import { describe, expect, it, vi } from 'vitest'
import { translateMessage } from '../../../../../shared/i18n/translate'
import { errorKindOf } from '../../sidebar/sessionStatusModel'
import { actionsFor, classifyError, compactThenRetry, loginActions, noticeActions } from './errorKind'

describe('classifyError', () => {
  it('引擎给了 kind 就用它，不看文字', () => {
    expect(classifyError('登录已失效：在终端运行 claude auth login 重新登录', { kind: 'busy' })).toBe('busy')
    expect(classifyError('随便一句话', { kind: 'overflow' })).toBe('overflow')
    expect(classifyError('余额不足', { kind: 'route', code: 'x', status: 403 })).toBe('route')
  })

  it('引擎认过但归不了类（没写 kind）：不再按文字猜', () => {
    expect(classifyError('账户余额或账单有问题', { code: 'something', status: 502 })).toBeNull()
  })

  it('kind 是不认识的值（别的版本写的）时退回按文字猜', () => {
    expect(classifyError('请求太频繁，已触发限额', { kind: 'future' as never })).toBe('busy')
  })

  it('没有 error 字段（旧会话、旧引擎）按文字猜，每一类都有', () => {
    const cases: Array<[string, ReturnType<typeof classifyError>]> = [
      ['登录已失效：在终端运行 claude auth login 重新登录', 'auth'],
      ['平台账号已退出或切换，请重新登录原账号', 'auth'],
      ['API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY', 'auth'],
      ['API Error: 401 unauthorized', 'auth'],
      ['账户余额或账单有问题', 'balance'],
      ['API Error: 402 insufficient balance', 'balance'],
      ['找不到所选模型', 'route'],
      ['没有权限：当前账号或 API Key 不能用这个模型或资源', 'route'],
      ['API Error: 403 group not available', 'route'],
      ['请求太频繁，已触发限额', 'busy'],
      ['服务繁忙，请稍后再试', 'busy'],
      ['服务出错，通常是暂时的，稍后再试', 'busy'],
      ['API Error: 529 Overloaded', 'busy'],
      // 上下文超限：英文原文和我们翻好的中文
      ['上下文太长：先压缩（/compact）或开一个新会话', 'overflow'],
      ['Prompt is too long', 'overflow'],
      ['API Error: 400 context_length_exceeded', 'overflow'],
      ["This model's maximum context length is 128000 tokens", 'overflow'],
      ['Too many tokens in the request', 'overflow'],
      // 压缩也失败了：再压缩没用，不给「压缩后重试」
      ['上下文太长，自动压缩也没成功：接口给压缩请求返回了空内容或没发完。', null],
      ['工作目录不存在', null],
      ['连不上模型服务：检查网络、代理或防火墙', null],
    ]
    for (const [text, kind] of cases) expect(classifyError(text), text).toBe(kind)
  })

  it('标题带 HTTP 状态码后仍然是 busy', () => {
    expect(classifyError('服务出错（HTTP 502），通常是暂时的，稍后再试')).toBe('busy')
    expect(classifyError('服务繁忙（HTTP 529），请稍后再试')).toBe('busy')
    expect(classifyError('请求太频繁（HTTP 429），已触发限额')).toBe('busy')
  })
})

describe('带状态码的标题有英文', () => {
  it('英文界面里状态码保留', () => {
    expect(translateMessage('服务出错（HTTP 502），通常是暂时的，稍后再试', 'en-US')).toBe(
      'The service hit an error (HTTP 502). This is usually temporary; try again shortly.',
    )
    expect(translateMessage('服务繁忙（HTTP 529），请稍后再试', 'en-US')).toBe(
      'Service busy (HTTP 529). Try again later.',
    )
    expect(translateMessage('请求太频繁（HTTP 429），已触发限额', 'en-US')).toBe(
      'Too many requests (HTTP 429). Rate limit reached.',
    )
  })
})

describe('noticeActions', () => {
  const own = { platform: null, provider: null }
  const platform = { platform: { groupId: 1, account: 'a@b.c' }, provider: null } as never

  it('上下文超限：压缩后重试排在重试前面，不给换线路 / 额度来源', () => {
    expect(noticeActions('overflow', own, 'claude', { retry: true, compact: true })).toEqual(['compact-retry', 'retry'])
    expect(noticeActions('overflow', platform, 'claude', { retry: true, compact: true })).toEqual([
      'compact-retry',
      'retry',
    ])
    expect(actionsFor('overflow', platform, 'claude')).toEqual([])
  })

  it('引擎不支持压缩，或会话正忙 / 队列里有东西：不给压缩后重试', () => {
    expect(noticeActions('overflow', own, 'claude', { retry: true, compact: false })).toEqual(['retry'])
    expect(noticeActions('overflow', own, 'claude', { retry: false, compact: true })).toEqual([])
  })

  it('别的类型的按钮不变，也不会冒出压缩后重试', () => {
    expect(noticeActions('balance', platform, 'claude', { retry: true, compact: true })).toEqual([
      'retry',
      'open-account',
      'open-menu',
      'use-self',
    ])
    expect(noticeActions(null, own, 'claude', { retry: true, compact: true })).toEqual(['retry'])
  })

  it('像素星空：命令行没配自己的 Key（selfReady 不为真）时不给「改用自有」', () => {
    const custom = { platform: null, provider: { id: 'p1' } } as never
    expect(actionsFor('balance', platform, 'pixel')).toEqual(['open-account', 'open-menu'])
    expect(actionsFor('auth', platform, 'pixel', false)).toEqual(['sign-in'])
    expect(actionsFor('auth', custom, 'pixel')).toEqual(['edit-provider'])
    expect(noticeActions('busy', platform, 'pixel', { retry: true, compact: false })).toEqual(['retry', 'open-menu'])
    // 配了（目录里有模型）照常给；Claude Code / Codex 不受影响
    expect(actionsFor('balance', platform, 'pixel', true)).toEqual(['open-account', 'open-menu', 'use-self'])
    expect(noticeActions('busy', platform, 'pixel', { retry: false, compact: false, selfReady: true })).toEqual([
      'open-menu',
      'use-self',
    ])
    expect(actionsFor('auth', platform, 'codex')).toEqual(['sign-in', 'use-self'])
  })
})

describe('按文字猜时认状态码（和协议的 classifyErrorText 一致）', () => {
  it('余额的话盖过 403 / 429；authentication 字样在别的状态码下不算登录', () => {
    expect(classifyError('API Error: 403 {"error":{"message":"insufficient balance"}}')).toBe('balance')
    expect(classifyError('429 You exceeded your current quota, please check your plan and billing details')).toBe(
      'balance',
    )
    expect(classifyError('HTTP 502 authentication gateway unavailable')).toBe('busy')
    expect(classifyError('Your input exceeds the context window of this model.')).toBe('overflow')
    expect(errorKindOf('API Error: 403 余额不足')).toBe('balance')
    expect(errorKindOf('Error: 502 Bad Gateway')).toBe('busy')
  })
})

describe('压缩后重试', () => {
  const own = { platform: null, provider: null }

  it('按钮只在引擎支持压缩（compactAvailable）、会话空闲且队列为空（retry）时出现', () => {
    const show = (retry: boolean, compact: boolean) =>
      noticeActions('overflow', own, 'claude', { retry, compact }).includes('compact-retry')
    expect(show(true, true)).toBe(true)
    expect(show(true, false)).toBe(false)
    expect(show(false, true)).toBe(false)
    expect(show(false, false)).toBe(false)
  })

  it('先压缩、压缩成功才发「继续」', async () => {
    const order: string[] = []
    await compactThenRetry(
      async () => void order.push('compact'),
      async () => void order.push('retry'),
    )
    expect(order).toEqual(['compact', 'retry'])
  })

  it('压缩失败（引擎不支持、正忙）不发「继续」，错误原样抛出', async () => {
    const retry = vi.fn(async () => undefined)
    await expect(
      compactThenRetry(async () => {
        throw new Error('等待当前任务和排队消息结束后压缩')
      }, retry),
    ).rejects.toThrow('等待当前任务和排队消息结束后压缩')
    expect(retry).not.toHaveBeenCalled()
  })

  it('没有桥接（没有 compact）同样不发「继续」', async () => {
    const retry = vi.fn(async () => undefined)
    await expect(compactThenRetry(undefined, retry)).rejects.toThrow('当前引擎不支持原生压缩')
    expect(retry).not.toHaveBeenCalled()
  })
})

describe('侧栏状态', () => {
  it('上下文超限没有单独的图标，算 failed；别的类型照旧', () => {
    expect(errorKindOf('上下文太长：先压缩（/compact）或开一个新会话')).toBe('failed')
    expect(errorKindOf('请求太频繁，已触发限额')).toBe('busy')
    expect(errorKindOf('工作目录不存在')).toBe('failed')
  })
})

describe('loginActions（自己订阅的登录失效，docs/ui/claude-login-recovery.md §1 第 4 条）', () => {
  const own = { platform: null, provider: null } as const
  const account = (id: string, status: 'ok' | 'expired' | 'unknown' = 'ok') => ({
    id,
    email: `${id}@example.com`,
    plan: null,
    label: null,
    addedAt: 0,
    status,
  })

  it('单账号：只给「重新登录」（普通登录，不指定账号）', () => {
    expect(loginActions('auth', own, 'claude', null)).toEqual([{ kind: 'relogin' }])
    expect(loginActions('auth', own, 'codex', { current: 'default', accounts: [] })).toEqual([{ kind: 'relogin' }])
  })

  it('多账号：重新登录当前那个；有别的没失效的账号时再给「换成 X」', () => {
    const accounts = { current: 'a_1', accounts: [account('default', 'expired'), account('a_1'), account('a_2')] }
    expect(loginActions('auth', own, 'claude', accounts)).toEqual([
      { kind: 'relogin', target: 'a_1' },
      { kind: 'switch', account: account('a_2') },
    ])
    // 当前是原来的账号、但它不在列表里（第一次添加账号时没登录）：普通登录，不指定账号
    const unlisted = { current: 'default', accounts: [account('a_1')] }
    expect(loginActions('auth', own, 'claude', unlisted)).toEqual([
      { kind: 'relogin' },
      { kind: 'switch', account: account('a_1') },
    ])
    const allExpired = { current: 'a_1', accounts: [account('a_1'), account('a_2', 'expired')] }
    expect(loginActions('auth', own, 'claude', allExpired)).toEqual([{ kind: 'relogin', target: 'a_1' }])
  })

  it('不是登录失效、平台 / 自定义接口的会话、Pixel 引擎：不给', () => {
    expect(loginActions('busy', own, 'claude', null)).toEqual([])
    expect(
      loginActions('auth', { platform: { groupId: '1', account: 'a@b.c' }, provider: null }, 'claude', null),
    ).toEqual([])
    expect(loginActions('auth', { platform: null, provider: { id: 'my' } }, 'claude', null)).toEqual([])
    expect(loginActions('auth', own, 'pixel', null)).toEqual([])
  })
})
