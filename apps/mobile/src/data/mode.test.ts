import { describe, expect, it } from 'vitest'
import { fastStatus, modeChip, modelLabel, permissionOptions } from './mode'

describe('modeChip', () => {
  it('names the four permission modes', () => {
    const text = (permissionMode: 'ask' | 'edits' | 'plan' | 'full') =>
      modeChip({ permissionMode, model: null, effort: null }).permission
    expect([text('ask'), text('edits'), text('plan'), text('full')]).toEqual([
      '每步问我',
      '自动改文件',
      '只规划',
      '完全放行',
    ])
  })

  it('hides model and effort when null', () => {
    expect(modeChip({ permissionMode: 'ask', model: null, effort: null })).toEqual({
      permission: '每步问我',
      model: null,
      effort: null,
    })
  })

  it('shows simplified model and effort labels', () => {
    expect(modeChip({ permissionMode: 'edits', model: 'claude-sonnet-4-5-20250929', effort: 'medium' })).toEqual({
      permission: '自动改文件',
      model: 'Sonnet 4.5',
      effort: '中',
    })
    const e = (effort: 'low' | 'high' | 'xhigh' | 'max') =>
      modeChip({ permissionMode: 'ask', model: null, effort }).effort
    expect([e('low'), e('high'), e('xhigh'), e('max')]).toEqual(['低', '高', '超高', '最高'])
  })
})

describe('permissionOptions', () => {
  it('lists the current full / auto mode as disabled so the sheet has a selected row', () => {
    for (const current of ['full', 'auto'] as const) {
      expect(permissionOptions('codex', current).at(-1)).toEqual({
        value: current,
        label: current === 'full' ? '完全放行' : '自动审核',
        hint: '只能在电脑上打开',
        disabled: true,
      })
    }
    expect(permissionOptions('codex', 'ask').some(o => o.disabled)).toBe(false)
  })
})

describe('modelLabel', () => {
  it('simplifies claude names', () => {
    expect(modelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
    expect(modelLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4')
    expect(modelLabel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
    expect(modelLabel('sonnet')).toBe('Sonnet')
    expect(modelLabel('claude-opus-4-1[1m]')).toBe('Opus 4.1')
  })

  it('falls back to the raw name, truncated when long', () => {
    expect(modelLabel('gpt-5')).toBe('gpt-5')
    expect(modelLabel('my-custom-model-with-a-long-name')).toBe('my-custom-model-…')
  })
})

describe('fastStatus', () => {
  const flags = (
    fastAvailable: boolean | null,
    fastState: 'off' | 'on' | 'cooldown' | null,
    fastBlocked: string | null,
  ) => ({
    fastAvailable,
    fastState,
    fastBlocked,
  })

  it('can turn on by default, with the price hint', () => {
    expect(fastStatus(null)).toEqual({
      available: true,
      hint: '回复更快，按更高的价格计费',
      warn: false,
      cooldown: false,
    })
    expect(fastStatus(flags(true, 'off', null)).available).toBe(true)
  })

  it('names why it cannot turn on', () => {
    expect(fastStatus(flags(false, null, 'preference'))).toMatchObject({
      available: false,
      hint: '暂时不可用：账号没有开启 Fast 模式',
      warn: true,
    })
    expect(fastStatus(flags(false, null, 'something_new')).hint).toBe('暂时不可用：原因未知')
  })

  it('shows cooldown and the Codex hints', () => {
    expect(fastStatus(flags(true, 'cooldown', null))).toMatchObject({ available: true, cooldown: true, warn: true })
    expect(fastStatus(flags(true, 'on', 'codex_gateway')).hint).toBe('接口支持 Fast 时生效，不支持的打开了也没有效果')
  })
})
