import { describe, expect, it } from 'vitest'
import {
  defaultWindow,
  freshModels,
  groupByVendor,
  groupState,
  oldModels,
  prettyModelName,
  vendorOf,
} from './menuModelRules'

// 正式站管理员账号看到的一部分（2026-11-17）
const MODELS = [
  'claude-fable-5-2',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-5-20251101',
  'claude-sonnet-5-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-haiku-5-5',
  'gpt-6.1-sol',
  'gpt-5.6-sol',
  'gpt-6',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'codex-auto-review',
  'gpt-image-2.5-flare',
  'gemini-4-carbon',
  'gemini-3.8-flash',
  'deepseek-v4.1-flash',
  'glm-5',
]

describe('按厂商分组', () => {
  it('前缀认厂商，名字里有 image 的归图片模型，认不出的归其他；组按固定顺序、组内保持原顺序', () => {
    expect(vendorOf('gpt-image-2.5-flare')).toBe('image')
    expect(vendorOf('gemini-3.1-flash-image')).toBe('image')
    expect(vendorOf('codex-auto-review')).toBe('gpt')
    expect(vendorOf('o3')).toBe('gpt')
    expect(vendorOf('glm-5')).toBe('other')
    expect(groupByVendor(MODELS).map(g => [g.vendor, g.models.length])).toEqual([
      ['claude', 9],
      ['gpt', 7],
      ['gemini', 2],
      ['deepseek', 1],
      ['other', 1],
      ['image', 1],
    ])
    expect(groupByVendor(MODELS)[1]!.models.slice(0, 2)).toEqual(['gpt-6.1-sol', 'gpt-5.6-sol'])
  })
})

describe('旧版', () => {
  it('同一条产品线有更高主版本号才算；带日期的、没有版本号的、只有自己一条线的不算', () => {
    expect([...oldModels(MODELS)].sort()).toEqual(
      [
        'claude-opus-4-8',
        'claude-opus-4-5-20251101',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
        'gpt-5.6-sol',
        'gpt-5.5',
      ].sort(),
    )
    // 同一主版本（opus-5 和 opus-5-5）不算；gpt-5.4-mini、gpt-5.3-codex-spark 没有更新的同线
    expect(oldModels(['claude-opus-5', 'claude-opus-5-5']).size).toBe(0)
    expect(oldModels(['claude-haiku-4-5-20251001']).size).toBe(0)
  })
})

describe('显示名', () => {
  it('去掉日期，数字用点连，GPT 和版本号用连字符', () => {
    expect(prettyModelName('claude-opus-4-5-20251101')).toBe('Claude Opus 4.5')
    expect(prettyModelName('claude-haiku-5-5')).toBe('Claude Haiku 5.5')
    expect(prettyModelName('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(prettyModelName('gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark')
    expect(prettyModelName('gemini-4-carbon')).toBe('Gemini 4 Carbon')
    expect(prettyModelName('deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash')
    expect(prettyModelName('codex-auto-review')).toBe('Codex Auto Review')
  })
})

describe('默认窗口、新模型、组开关', () => {
  it('默认窗口取官方价格表，没有的为 null', () => {
    expect(defaultWindow('claude-opus-5-5')).toBe(1_000_000)
    expect(defaultWindow('not-a-model')).toBeNull()
  })
  it('第一次打开不标新；之后没见过的标新', () => {
    expect(freshModels(['a', 'b'], null).size).toBe(0)
    expect([...freshModels(['a', 'b', 'c'], ['a'])]).toEqual(['b', 'c'])
  })
  it('组开关：全显示、全隐藏、部分', () => {
    expect(groupState(['a', 'b'], [])).toBe('on')
    expect(groupState(['a', 'b'], ['a', 'b', 'x'])).toBe('off')
    expect(groupState(['a', 'b'], ['b'])).toBe('mixed')
  })
})
