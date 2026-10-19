// 审批卡 / 提问卡的键盘操作（和列表卡的 Ctrl+Enter 允许、Ctrl+⌫ 拒绝同一套习惯）。纯函数，组件只负责执行
import type { AlwaysScope } from '@pixelsky/protocol'
import { menuDigit } from '@/ui/menuDigit'

export interface CardKeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
  /** 长按连发 */
  repeat?: boolean
}

/** 输入法正在组字：Enter / 数字是在选字，不是操作卡片 */
export const isComposingKey = (e: Pick<CardKeyEvent, 'isComposing' | 'keyCode'>): boolean =>
  e.isComposing === true || e.keyCode === 229

/** 「始终允许」快捷键用哪个范围：优先最窄的「本会话」，没有时只有一个范围才直接用，免得悄悄放宽到整个项目 / 全部项目 */
export function alwaysKeyScope(scopes: readonly AlwaysScope[]): AlwaysScope | null {
  if (scopes.includes('session')) return 'session'
  return scopes.length === 1 ? scopes[0] : null
}

export type ApprovalKey =
  | { type: 'allow' }
  | { type: 'deny' }
  | { type: 'always'; scope: AlwaysScope }
  | { type: 'focusComposer' }

/**
 * 单张审批卡（和列表卡同一套修饰键，免得误触就放行）：
 * Ctrl/⌘+Enter 允许一次、Ctrl/⌘+⌫ 拒绝、Ctrl/⌘+Shift+Enter 始终允许（要有明确范围）、Esc 回到输入框（不拒绝）。
 * typing 为 true（焦点在输入框 / 文本域）、输入法组字、长按连发时一律不处理
 */
export function approvalShortcut(
  e: CardKeyEvent,
  ctx: { typing: boolean; canAllow: boolean; scopes: readonly AlwaysScope[] },
): ApprovalKey | null {
  if (isComposingKey(e) || ctx.typing || e.repeat || e.altKey) return null
  const mod = e.ctrlKey || e.metaKey
  if (e.key === 'Escape') return mod || e.shiftKey ? null : { type: 'focusComposer' }
  if (!mod) return null
  if (e.key === 'Enter') {
    if (!ctx.canAllow) return null
    if (!e.shiftKey) return { type: 'allow' }
    const scope = alwaysKeyScope(ctx.scopes)
    return scope ? { type: 'always', scope } : null
  }
  if (e.key === 'Backspace' && !e.shiftKey) return { type: 'deny' }
  return null
}

export type QuestionKey = { type: 'pick'; index: number } | { type: 'next' } | { type: 'submit' }

/**
 * 提问卡：1–9 选当前题的第 N 个选项、Enter 到下一题、Ctrl/⌘+Enter 提交。
 * 焦点在输入框里只认 Ctrl/⌘+Enter；canAdvance 为 false（焦点在底部按钮上）时 Enter 留给按钮本身；
 * canPick 为 false（焦点在底部按钮上、或没有可选的题）时数字不处理；长按连发一律忽略
 */
export function questionShortcut(
  e: CardKeyEvent,
  ctx: { typing: boolean; canAdvance: boolean; canPick: boolean },
): QuestionKey | null {
  if (isComposingKey(e) || e.repeat) return null
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) return { type: 'submit' }
  if (ctx.typing || e.ctrlKey || e.metaKey || e.altKey) return null
  const digit = menuDigit(e)
  if (digit >= 0) return ctx.canPick ? { type: 'pick', index: digit } : null
  if (e.key === 'Enter' && !e.shiftKey && ctx.canAdvance) return { type: 'next' }
  return null
}

/**
 * 数字键落在哪道题：焦点在某题里就是那题（多选能连着按几个）；焦点在卡片本身时是第一道没答完的题，
 * 全答完了就不处理（不悄悄改第一题）；焦点在底部按钮等其他地方不处理
 */
export function digitQuestion(
  focus: { block: number | null; onCard: boolean },
  answered: readonly boolean[],
): number | null {
  if (focus.block !== null) return focus.block
  if (!focus.onCard) return null
  const at = answered.indexOf(false)
  return at >= 0 ? at : null
}
