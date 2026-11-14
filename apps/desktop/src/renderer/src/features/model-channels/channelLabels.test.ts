import { describe, expect, it } from 'vitest'
import { accountText, authChannelSub, channelAccount, maskEmail } from './channelLabels'
import { parseAntigravityNote } from './channelPrefs'

describe('Antigravity 账号套餐与备注（方案 D）', () => {
  it('parseAntigravityNote：只收字符串并去首尾空格、截断长度', () => {
    expect(parseAntigravityNote(null)).toBe('')
    expect(parseAntigravityNote('{')).toBe('')
    expect(parseAntigravityNote(JSON.stringify(123))).toBe('')
    expect(parseAntigravityNote(JSON.stringify('  r123@gmail.com  '))).toBe('r123@gmail.com')
    expect(parseAntigravityNote(JSON.stringify('a'.repeat(200)))).toHaveLength(120)
  })

  it('channelAccount：Antigravity 非 Key 登录时合并备注与套餐；Key 登录不给账号对象', () => {
    expect(
      channelAccount('antigravity', { auth: { kind: 'apiKey' }, account: { plan: 'Google AI Ultra' } }, 'a@b.com'),
    ).toBeUndefined()
    expect(
      channelAccount('antigravity', { auth: { kind: 'login' }, account: { plan: 'Google AI Ultra' } }, ''),
    ).toEqual({
      plan: 'Google AI Ultra',
    })
    expect(
      channelAccount(
        'antigravity',
        { auth: { kind: 'login' }, account: { plan: 'Google AI Ultra' } },
        '  ray@gmail.com ',
      ),
    ).toEqual({ email: 'ray@gmail.com', plan: 'Google AI Ultra' })
    expect(channelAccount('claude', { account: { email: 'c@x.com', plan: 'max_20x' } }, 'ignored')).toEqual({
      email: 'c@x.com',
      plan: 'max_20x',
    })
  })

  it('authChannelSub：左栏副标题覆盖备注、仅套餐、Key 与原 Claude 行为', () => {
    expect(
      authChannelSub(
        'antigravity',
        { auth: { kind: 'login' }, account: { plan: 'Google AI Ultra' } },
        '10 个可用',
        'ray@gmail.com',
      ),
    ).toBe('r•••@gmail.com · Ultra')
    expect(
      authChannelSub(
        'antigravity',
        { auth: { kind: 'login' }, account: { plan: 'Google AI Ultra' } },
        '10 个可用',
        '',
      ),
    ).toBe('Ultra · 10 个可用')
    expect(authChannelSub('antigravity', { auth: { kind: 'apiKey' } }, '7 个可用', 'ray@gmail.com')).toBe(
      'API Key · 7 个可用',
    )
    expect(authChannelSub('antigravity', { auth: { kind: 'login' } }, '10 个可用', '')).toBe('10 个可用')
    expect(authChannelSub('claude', { account: { email: 'ray@gmail.com', plan: 'max_20x' } }, '5 个可用')).toBe(
      'r•••@gmail.com · Ultra',
    )
  })

  it('accountText 与 maskEmail', () => {
    expect(maskEmail('ray@gmail.com')).toBe('r•••@gmail.com')
    expect(maskEmail('a@gmail.com')).toBe('a@gmail.com')
    expect(accountText({ email: 'ray@gmail.com', plan: 'Google AI Pro' }, 'antigravity')).toBe('ray@gmail.com · Pro')
    expect(accountText({ plan: 'Google AI Ultra' }, 'antigravity')).toBe('Ultra')
  })
})
