import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillCommand } from '@pixelsky/protocol'
import { rememberCommands, rememberedCommands } from './rememberedCommands'

const skill = (name: string): SkillCommand => ({
  name,
  description: '',
  source: 'engine',
  invocation: 'skill',
  path: `/s/${name}`,
})

describe('记住引擎报的技能', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('按引擎:项目分开，只记技能；读坏数据、存不了不报错', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
    expect(rememberedCommands('codex:p1')).toEqual([])
    rememberCommands('codex:p1', [
      { name: 'compact', description: '', source: 'engine', invocation: 'slash' },
      skill('grill-me'),
    ])
    rememberCommands('codex:p2', [skill('other')])
    expect(rememberedCommands('codex:p1')).toEqual([skill('grill-me')])
    expect(rememberedCommands('codex:p2').map(c => c.name)).toEqual(['other'])
    store.set('pixelsky.engine-commands.v1', '{bad')
    expect(rememberedCommands('codex:p1')).toEqual([])
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('full')
      },
    })
    expect(() => rememberCommands('codex:p1', [skill('x')])).not.toThrow()
  })
})
