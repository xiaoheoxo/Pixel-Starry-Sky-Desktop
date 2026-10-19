import { describe, expect, it, vi } from 'vitest'
import { translateMessage } from '@/i18n/core'
import { cleanIpcError, openStorePage } from './useStore'

// 打开面板页：演示模式不打开任何页面；真实构建的 IPC 错误整理成可读的话。

describe('openStorePage', () => {
  it('演示模式：不调用主进程，返回 demo（界面提示「演示模式不会打开支付页」，而不是去浏览器付款）', async () => {
    const openStore = vi.fn()
    await expect(openStorePage(true, { openStore }, 'purchase')).resolves.toBe('demo')
    expect(openStore).not.toHaveBeenCalled()
  })

  it('真实构建：把种类和参数交给主进程，成功返回 opened', async () => {
    const openStore = vi.fn(async () => undefined)
    await expect(openStorePage(false, { openStore }, 'purchase', { tab: 'subscription', group: 3 })).resolves.toBe(
      'opened',
    )
    expect(openStore).toHaveBeenCalledWith('purchase', { tab: 'subscription', group: 3 })
  })

  it('主进程拒绝时去掉 IPC 前缀，只留下给用户看的那句话', async () => {
    const openStore = vi.fn(async () => {
      throw new Error("Error invoking remote method 'account:openStore': Error: 面板地址不在可信域名内，已拒绝打开")
    })
    await expect(openStorePage(false, { openStore }, 'redeem')).rejects.toThrow('面板地址不在可信域名内，已拒绝打开')
  })

  it('没有桥接：报「无法打开面板页」', async () => {
    await expect(openStorePage(false, undefined, 'purchase')).rejects.toThrow('无法打开面板页')
  })
})

describe('cleanIpcError', () => {
  it('空消息用兜底文案', () => {
    expect(cleanIpcError(new Error("Error invoking remote method 'x': Error: "), '兜底')).toBe('兜底')
    expect(cleanIpcError(undefined, '兜底')).toBe('兜底')
  })
})

describe('主进程的中文错误在英文界面有译文', () => {
  const en = (s: string): string => translateMessage(s, 'en-US')
  it('store.ts 抛出的提示', () => {
    expect(en('请先刷新套餐信息')).toBe('Refresh the plan info first')
    expect(en('没有可用的面板地址')).toBe('No usable panel address')
    expect(en('暂时读不到订阅套餐和充值信息（HTTP 502）')).toBe('Could not read plans and top-up info (HTTP 502)')
    expect(en('服务返回的套餐数据异常')).toBe('Invalid plan data returned by service')
    expect(en('无效的面板页')).toBe('Invalid panel page')
    expect(en('面板地址不在可信域名内，已拒绝打开')).toContain('not on a trusted domain')
    expect(en('面板地址不是 https，已拒绝打开')).toContain('not https')
    expect(en('面板地址带有用户名或密码，已拒绝打开')).toContain('username or password')
  })
  it('中文界面保持原文', () => {
    expect(translateMessage('请先刷新套餐信息', 'zh-CN')).toBe('请先刷新套餐信息')
    expect(translateMessage('暂时读不到订阅套餐和充值信息（HTTP 502）', 'zh-CN')).toBe(
      '暂时读不到订阅套餐和充值信息（HTTP 502）',
    )
  })
})
