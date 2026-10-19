import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubagentSettingsStore } from './store'
import { DEFAULT_SUBAGENT_SETTINGS, parseSubagentSettings } from '../../shared/types/subagents'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pixelsky-subagents-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const custom = {
  id: 'test-writer',
  name: '写测试',
  description: '补单元测试',
  target: { kind: 'custom', providerId: 'ds', model: 'deepseek-chat' },
  tools: 'all',
  maxMinutes: 30,
  instructions: '用 vitest',
  enabled: true,
}

describe('设置 › 子智能体（docs/ui/subagent-routing.md）', () => {
  it('默认：内置通用、探索两个类型，出错改走主会话，同时 4 个', () => {
    expect(parseSubagentSettings(null)).toEqual(DEFAULT_SUBAGENT_SETTINGS)
    expect(DEFAULT_SUBAGENT_SETTINGS.types.map(t => [t.id, t.tools, t.enabled])).toEqual([
      ['general', 'all', true],
      ['explore', 'read', true],
    ])
    expect(DEFAULT_SUBAGENT_SETTINGS).toMatchObject({ fallback: true, maxConcurrent: 4 })
  })

  it('内置类型总在、通用总是开着、名字不能改；标识不对或重复的丢掉；认不出的值回到默认', () => {
    const s = parseSubagentSettings({
      types: [
        { ...custom },
        { id: 'general', name: '改名', enabled: false, target: { kind: 'platform', groupId: '7', model: 'm' } },
        { ...custom, name: '重复' },
        { ...custom, id: 'Bad ID' },
        { ...custom, id: 'odd', tools: 'root', maxMinutes: 45, description: 'x'.repeat(900) },
      ],
      maxConcurrent: 3,
      fallback: 'yes',
    })
    expect(s.types.map(t => t.id)).toEqual(['test-writer', 'general', 'explore', 'odd'])
    const general = s.types.find(t => t.id === 'general')!
    expect(general).toMatchObject({ name: '通用', enabled: true, target: null })
    expect(s.types.find(t => t.id === 'test-writer')!.name).toBe('写测试')
    const odd = s.types.find(t => t.id === 'odd')!
    expect([odd.tools, odd.maxMinutes, odd.description.length]).toEqual(['all', 30, 500])
    expect([s.maxConcurrent, s.fallback]).toEqual([4, true])
  })

  it('第一期的格式（一个 target）读成通用类型的站点', () => {
    const s = parseSubagentSettings({
      target: { kind: 'custom', providerId: 'ds', model: 'deepseek-chat' },
      fallback: false,
      maxMinutes: 10,
    })
    expect(s.types[0]).toMatchObject({
      id: 'general',
      target: { kind: 'custom', providerId: 'ds', model: 'deepseek-chat' },
      maxMinutes: 10,
    })
    expect(s.types.map(t => t.id)).toEqual(['general', 'explore'])
    expect(s.fallback).toBe(false)
  })

  it('存盘、重开读回；文件坏了回到默认', () => {
    const store = new SubagentSettingsStore(dir)
    expect(store.get()).toEqual(DEFAULT_SUBAGENT_SETTINGS)
    const saved = store.set({ types: [...DEFAULT_SUBAGENT_SETTINGS.types, custom], maxConcurrent: 2 })
    expect(saved.types.map(t => t.id)).toEqual(['general', 'explore', 'test-writer'])
    expect(saved.maxConcurrent).toBe(2)
    expect(new SubagentSettingsStore(dir).get()).toEqual(saved)
    expect(JSON.parse(readFileSync(join(dir, 'subagents.json'), 'utf8'))).toEqual(saved)
    writeFileSync(join(dir, 'subagents.json'), '{oops')
    expect(new SubagentSettingsStore(dir).get()).toEqual(DEFAULT_SUBAGENT_SETTINGS)
  })
})
