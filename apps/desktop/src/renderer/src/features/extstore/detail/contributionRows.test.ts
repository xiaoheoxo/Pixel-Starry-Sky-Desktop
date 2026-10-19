import { describe, expect, it } from 'vitest'
import type { ExtPackContributes, ExtPackManifest } from '@pixelsky/protocol'
import { contributionGroupsOf, contributionRowsOf } from './contributionRows'

const manifest = (contributes: ExtPackContributes): ExtPackManifest => ({ contributes }) as ExtPackManifest

describe('contributionRowsOf', () => {
  it('没有清单是空的', () => {
    expect(contributionRowsOf(null, 'zh-CN')).toEqual([])
    expect(contributionRowsOf(undefined, 'en-US')).toEqual([])
  })

  it('按显示顺序、清单下标，标签按语言', () => {
    const m = manifest({
      themes: [
        { id: 'a', label: 'A', uiTheme: 'dark', path: 'a.json' },
        { id: 'b', label: { zh: '乙', en: 'B' }, uiTheme: 'dark', path: 'b.json' },
      ],
      grammars: [{ scopeName: 'source.swift', language: 'Swift', path: 'g.json' } as never],
      prompts: [{ id: 'p', title: { zh: '提示', en: 'Prompt' }, path: 'p.md' } as never],
      skills: [{ path: 'skills/x' }],
    })
    expect(contributionRowsOf(m, 'zh-CN').map(r => [r.kind, r.index, r.label])).toEqual([
      ['grammars', 0, 'Swift'],
      ['themes', 0, 'A'],
      ['themes', 1, '乙'],
      ['skills', 0, 'skills/x'],
      ['prompts', 0, '提示'],
    ])
    expect(contributionRowsOf(m, 'en-US')[2].label).toBe('B')
  })

  it('语言没写时退回 scopeName', () => {
    const m = manifest({ grammars: [{ scopeName: 'source.foo', path: 'g.json' } as never] })
    expect(contributionRowsOf(m, 'zh-CN')[0].label).toBe('source.foo')
  })
})

describe('contributionGroupsOf', () => {
  it('按种类合并，名字去重', () => {
    const m = manifest({
      grammars: [{ scopeName: 's', language: 'Swift', path: 'g.json' } as never],
      snippets: [{ language: 'swift', path: 'a.json' } as never, { language: 'swift', path: 'b.json' } as never],
    })
    expect(contributionGroupsOf(m, 'zh-CN')).toEqual([
      { kind: 'grammars', count: 1, names: ['Swift'] },
      { kind: 'snippets', count: 2, names: ['swift'] },
    ])
  })
})
