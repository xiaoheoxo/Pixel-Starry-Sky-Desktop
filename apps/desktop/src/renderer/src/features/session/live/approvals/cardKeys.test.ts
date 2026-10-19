import { describe, expect, it } from 'vitest'
import { alwaysKeyScope, approvalShortcut, digitQuestion, questionShortcut, type CardKeyEvent } from './cardKeys'

const ev = (key: string, extra: Partial<CardKeyEvent> = {}): CardKeyEvent => ({
  key,
  code: /^\d$/.test(key) ? `Digit${key}` : key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
})
const card = { typing: false, canAllow: true, scopes: ['session', 'project', 'user'] as const }

describe('始终允许的快捷键范围', () => {
  it('优先本会话；没有时只有一个范围才用', () => {
    expect(alwaysKeyScope(['project', 'session'])).toBe('session')
    expect(alwaysKeyScope(['project'])).toBe('project')
    expect(alwaysKeyScope(['project', 'user'])).toBeNull()
    expect(alwaysKeyScope([])).toBeNull()
  })
})

describe('单张审批卡的键盘', () => {
  const ctrl = { ctrlKey: true }
  it('Ctrl/⌘+Enter 允许一次、Ctrl/⌘+⌫ 拒绝、Ctrl/⌘+Shift+Enter 始终允许、Esc 回输入框', () => {
    expect(approvalShortcut(ev('Enter', ctrl), card)).toEqual({ type: 'allow' })
    expect(approvalShortcut(ev('Enter', { metaKey: true }), card)).toEqual({ type: 'allow' })
    expect(approvalShortcut(ev('Backspace', ctrl), card)).toEqual({ type: 'deny' })
    expect(approvalShortcut(ev('Backspace', { metaKey: true }), card)).toEqual({ type: 'deny' })
    expect(approvalShortcut(ev('Enter', { ...ctrl, shiftKey: true }), card)).toEqual({
      type: 'always',
      scope: 'session',
    })
    expect(approvalShortcut(ev('Escape'), card)).toEqual({ type: 'focusComposer' })
  })
  it('不带修饰键的 Enter / A / Esc 都不放行也不拒绝', () => {
    expect(approvalShortcut(ev('Enter'), card)).toBeNull()
    expect(approvalShortcut(ev('Backspace'), card)).toBeNull()
    expect(approvalShortcut(ev('a'), card)).toBeNull()
    expect(approvalShortcut(ev('Escape'), card)?.type).not.toBe('deny')
    expect(approvalShortcut(ev('Enter', { shiftKey: true }), card)).toBeNull()
  })
  it('始终允许要有明确范围', () => {
    const none = { ...card, scopes: ['project', 'user'] as const }
    expect(approvalShortcut(ev('Enter', { ...ctrl, shiftKey: true }), none)).toBeNull()
    expect(approvalShortcut(ev('Enter', ctrl), none)).toEqual({ type: 'allow' })
  })
  it('只能拒绝的请求：不允许也不始终允许，Ctrl+⌫ 仍可拒绝', () => {
    const only = { ...card, canAllow: false }
    expect(approvalShortcut(ev('Enter', ctrl), only)).toBeNull()
    expect(approvalShortcut(ev('Enter', { ...ctrl, shiftKey: true }), only)).toBeNull()
    expect(approvalShortcut(ev('Backspace', ctrl), only)).toEqual({ type: 'deny' })
  })
  it('在输入框里、输入法组字、长按连发、带 Alt 都不处理', () => {
    expect(approvalShortcut(ev('Escape'), { ...card, typing: true })).toBeNull()
    expect(approvalShortcut(ev('Enter', { ...ctrl, isComposing: true }), card)).toBeNull()
    expect(approvalShortcut(ev('Enter', { ...ctrl, keyCode: 229 }), card)).toBeNull()
    expect(approvalShortcut(ev('Enter', { ...ctrl, repeat: true }), card)).toBeNull()
    expect(approvalShortcut(ev('Backspace', { ...ctrl, repeat: true }), card)).toBeNull()
    expect(approvalShortcut(ev('Escape', { repeat: true }), card)).toBeNull()
    expect(approvalShortcut(ev('Enter', { ...ctrl, altKey: true }), card)).toBeNull()
  })
})

describe('提问卡的键盘', () => {
  const ctx = { typing: false, canAdvance: true, canPick: true }
  it('数字 1–9 选选项（序号从 0 起）', () => {
    expect(questionShortcut(ev('1'), ctx)).toEqual({ type: 'pick', index: 0 })
    expect(questionShortcut(ev('9'), ctx)).toEqual({ type: 'pick', index: 8 })
    expect(questionShortcut(ev('0'), ctx)).toBeNull()
  })
  it('焦点在底部按钮 / 没有可选的题时数字不处理', () => {
    expect(questionShortcut(ev('1'), { ...ctx, canPick: false })).toBeNull()
  })
  it('Enter 到下一题；焦点在底部按钮上留给按钮', () => {
    expect(questionShortcut(ev('Enter'), ctx)).toEqual({ type: 'next' })
    expect(questionShortcut(ev('Enter'), { ...ctx, canAdvance: false })).toBeNull()
  })
  it('Ctrl / ⌘ + Enter 提交，输入框里也认', () => {
    expect(questionShortcut(ev('Enter', { ctrlKey: true }), ctx)).toEqual({ type: 'submit' })
    expect(questionShortcut(ev('Enter', { metaKey: true }), { ...ctx, typing: true })).toEqual({ type: 'submit' })
  })
  it('长按连发一律忽略', () => {
    expect(questionShortcut(ev('1', { repeat: true }), ctx)).toBeNull()
    expect(questionShortcut(ev('Enter', { repeat: true }), ctx)).toBeNull()
    expect(questionShortcut(ev('Enter', { ctrlKey: true, repeat: true }), ctx)).toBeNull()
  })
  it('输入框里数字和 Enter 是打字；组字时什么都不认', () => {
    expect(questionShortcut(ev('1'), { ...ctx, typing: true })).toBeNull()
    expect(questionShortcut(ev('Enter'), { ...ctx, typing: true })).toBeNull()
    expect(questionShortcut(ev('1', { isComposing: true }), ctx)).toBeNull()
    expect(questionShortcut(ev('Enter', { ctrlKey: true, keyCode: 229 }), ctx)).toBeNull()
  })
})

describe('数字键落在哪道题', () => {
  it('焦点在某题里就是那题，即使它已答完（多选能连着按）', () => {
    expect(digitQuestion({ block: 1, onCard: false }, [false, true])).toBe(1)
  })
  it('焦点在卡片上：第一道没答完的题；全答完了不处理', () => {
    expect(digitQuestion({ block: null, onCard: true }, [true, false, false])).toBe(1)
    expect(digitQuestion({ block: null, onCard: true }, [true, true])).toBeNull()
  })
  it('焦点在底部按钮等其他地方不处理', () => {
    expect(digitQuestion({ block: null, onCard: false }, [false])).toBeNull()
  })
})
