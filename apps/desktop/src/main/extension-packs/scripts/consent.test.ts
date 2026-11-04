import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptConsent, ScriptStorage } from './consent'
import { SCRIPT_LIMITS, ScriptCallError } from './api'

const dir = mkdtempSync(join(tmpdir(), 'ext-scripts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('ScriptConsent', () => {
  it('同意、撤销、忘掉都写盘；重开还在', () => {
    const file = join(dir, 'a.json')
    const c = new ScriptConsent(file)
    c.grant('x.y', ['editor.read', 'storage'])
    c.revoke('x.y', 'storage')
    expect(new ScriptConsent(file).granted('x.y')).toEqual(['editor.read'])
    c.forget('x.y')
    expect(new ScriptConsent(file).granted('x.y')).toEqual([])
  })
  it('文件坏了当没同意过，不是当全同意', () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, '{oops')
    expect(new ScriptConsent(file).granted('x.y')).toEqual([])
    writeFileSync(file, JSON.stringify({ 'x.y': 'all', 'a.b': [1] }))
    const c = new ScriptConsent(file)
    expect(c.granted('x.y')).toEqual([])
    expect(c.granted('a.b')).toEqual([])
  })
})

describe('ScriptStorage', () => {
  it('每个扩展分开；存取删', () => {
    const s = new ScriptStorage(join(dir, 'store'))
    s.set('a.a', 'k', 'v')
    expect(s.get('a.a', 'k')).toBe('v')
    expect(s.get('b.b', 'k')).toBeNull()
    s.delete('a.a', 'k')
    expect(s.get('a.a', 'k')).toBeNull()
  })
  it('__proto__ 这样的键不会拿到原型上的东西', () => {
    const s = new ScriptStorage(join(dir, 'store'))
    expect(s.get('a.a', 'toString')).toBeNull()
    expect(s.get('a.a', '__proto__')).toBeNull()
    s.set('a.a', '__proto__', 'x')
    expect(s.get('a.a', '__proto__')).toBe('x')
    expect(({} as { x?: unknown }).x).toBeUndefined()
  })
  it('超过上限报错，原来的还在；卸载后清掉', () => {
    const s = new ScriptStorage(join(dir, 'store'))
    s.set('c.c', 'keep', '1')
    expect(() => s.set('c.c', 'big', 'x'.repeat(SCRIPT_LIMITS.storageChars))).toThrow(ScriptCallError)
    expect(s.get('c.c', 'keep')).toBe('1')
    s.forget('c.c')
    expect(s.get('c.c', 'keep')).toBeNull()
  })
})
