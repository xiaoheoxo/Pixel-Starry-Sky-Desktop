import { describe, expect, it } from 'vitest'
import { planInfo, planProviderOf } from './plans'

describe('planInfo', () => {
  it('Claude：倍数由引擎并进套餐值，20x 是最高档', () => {
    expect(planInfo('claude', 'max_20x')).toEqual({ label: 'Ultra', tone: 'top' })
    expect(planInfo('claude', 'max_5x')).toEqual({ label: 'Max', tone: 'high' })
    expect(planInfo('claude', 'max')).toEqual({ label: 'Max', tone: 'high' })
    expect(planInfo('claude', 'team_5x')).toEqual({ label: 'Team 5x', tone: 'team' })
    expect(planInfo('claude', 'team')).toEqual({ label: 'Team', tone: 'team' })
    expect(planInfo('claude', 'pro')).toEqual({ label: 'Pro', tone: 'std' })
    expect(planInfo('claude', 'free')).toEqual({ label: 'Free', tone: 'free' })
    expect(planInfo('claude', 'enterprise')).toEqual({ label: 'Enterprise', tone: 'team' })
    expect(planInfo('claude', 'Max')).toEqual({ label: 'Max', tone: 'high' })
  })

  it('ChatGPT：planType 按用户确认的倍数对应', () => {
    const cases: [string, string, string][] = [
      ['free', 'Free', 'free'],
      ['go', 'Go', 'free'],
      ['plus', 'Plus', 'std'],
      ['prolite', 'Pro 10x', 'high'],
      ['pro', 'Pro 20x', 'high'],
      ['promax', 'Pro 50x', 'top'],
      ['team', 'Team', 'team'],
      ['self_serve_business_prolite', 'Team 10x', 'team'],
      ['self_serve_business_usage_based', 'Business', 'team'],
      ['business', 'Business', 'team'],
      ['ent26', 'Enterprise', 'team'],
      ['enterprise_cbp_usage_based', 'Enterprise', 'team'],
      ['edu_plus', 'Edu', 'std'],
    ]
    for (const [plan, label, tone] of cases) expect(planInfo('chatgpt', plan)).toEqual({ label, tone })
  })

  it('同一个 pro：Claude 是标准档，ChatGPT 是 Pro 20x', () => {
    expect(planInfo('claude', 'pro')?.label).toBe('Pro')
    expect(planInfo('chatgpt', 'pro')?.label).toBe('Pro 20x')
  })

  it('没有、unknown 不显示；认不出的首字母大写', () => {
    expect(planInfo('chatgpt', 'unknown')).toBeNull()
    expect(planInfo('claude', null)).toBeNull()
    expect(planInfo('claude', '  ')).toBeNull()
    expect(planInfo('chatgpt', 'k12')).toEqual({ label: 'K12', tone: 'std' })
  })

  it('planProviderOf', () => {
    expect(planProviderOf('codex')).toBe('chatgpt')
    expect(planProviderOf('claude')).toBe('claude')
  })
})
