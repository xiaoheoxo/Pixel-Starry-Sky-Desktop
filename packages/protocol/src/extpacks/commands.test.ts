import { describe, expect, it } from 'vitest'
import { commandProblems, permissionProblems, scriptProblems } from './commands'

const text = (v: unknown): boolean => typeof v === 'string' && v.length > 0
const codes = (raw: unknown, seen = new Set<string>()): string[] => commandProblems(raw, seen, text).map(p => p.code)
const ok = { id: 'format', title: '排版' }

describe('命令字段', () => {
  it('合格的没有问题；where、requires 的取值', () => {
    expect(codes(ok)).toEqual([])
    expect(codes({ ...ok, where: ['palette', 'editor'], requires: 'selection' })).toEqual([])
    expect(codes({ ...ok, where: [] })).toEqual(['command.fields'])
    expect(codes({ ...ok, where: ['palette', 'palette'] })).toEqual(['command.fields'])
    expect(codes({ ...ok, requires: 'file' })).toEqual(['command.fields'])
  })
  it('id 重复算问题', () => {
    const seen = new Set<string>()
    expect(codes(ok, seen)).toEqual([])
    expect(codes(ok, seen)).toEqual(['command.fields'])
  })
  it('快捷键：打字用的键必须带 mod 或 alt，只带 shift 不行；F 键可以单独用', () => {
    const key = (keybinding: unknown): string[] => codes({ ...ok, keybinding })
    expect(key({ code: 'KeyJ', mod: true })).toEqual([])
    expect(key({ code: 'KeyJ', alt: true, shift: true })).toEqual([])
    expect(key({ code: 'F5' })).toEqual([])
    expect(key({ code: 'KeyJ' })).toEqual(['command.keybinding'])
    expect(key({ code: 'KeyJ', shift: true })).toEqual(['command.keybinding'])
    expect(key({ code: 'Enter', mod: true })).toEqual(['command.keybinding'])
    expect(key({ code: 'KeyJ', mod: 'yes' })).toEqual(['command.keybinding'])
    expect(key('Ctrl+J')).toEqual(['command.keybinding'])
  })
})

describe('权限', () => {
  it('白名单之外、重复都报', () => {
    expect(permissionProblems(['editor.read', 'storage'])).toEqual([])
    expect(permissionProblems(['network']).map(p => p.code)).toEqual(['manifest.permissions'])
    expect(permissionProblems(['storage', 'storage'])).toHaveLength(1)
    expect(permissionProblems([{ a: 1 }])).toHaveLength(1)
  })
})

describe('脚本正文', () => {
  it('可读的通过；最长行或平均行太长算压缩过', () => {
    expect(scriptProblems('a.js', 'const a = 1\nconst b = 2\n')).toEqual([])
    expect(scriptProblems('a.js', 'x'.repeat(2001)).map(p => p.code)).toEqual(['script.minified'])
    expect(scriptProblems('a.js', `${'x'.repeat(300)}\n`.repeat(3).trimEnd()).map(p => p.code)).toEqual([
      'script.minified',
    ])
  })
})
