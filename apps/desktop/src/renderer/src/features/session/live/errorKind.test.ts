// 错误卡片的归类和按钮（docs/ui/source-switch.md §3.5）：结构化的 kind 优先，没有才按文字猜；上下文超限给「压缩后重试」
import { describe, expect, it, vi } from 'vitest'
import { translateMessage } from '../../../../../shared/i18n/translate'
import { errorKindOf } from '../../sidebar/sessionStatusModel'
import { actionsFor, classifyError, compactThenRetry, noticeActions } from './errorKind'

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
