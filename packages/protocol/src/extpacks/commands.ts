// 命令贡献（contributes.commands）和脚本（main）的校验（docs/ui/extension-commands-plan.md §5.1）。
// 这里不读文件之外的东西，桌面、命令行、云端检查器都走它
import type { ExtIssueCode } from './codes'
import { EXT_LIMITS, EXT_SCRIPT_PERMISSIONS } from './types'

type Rec = Record<string, unknown>

export interface CommandProblem {
  code: ExtIssueCode
  zh: string
  en: string
  path?: string
}

export const COMMAND_KEYS = ['id', 'title', 'description', 'where', 'requires', 'keybinding'] as const
export const COMMAND_KEYBINDING_KEYS = ['code', 'mod', 'shift', 'alt'] as const

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,47}$/
/** KeyboardEvent.code：字母、数字要带修饰键（不然打字就会触发），F 键可以单独用 */
const NEEDS_MODIFIER =
  /^(Key[A-Z]|Digit[0-9]|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote|Minus|Equal|BracketLeft|BracketRight)$/
const F_KEY = /^F([1-9]|1[0-2])$/

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 一条命令的字段问题；id 重复也算（seen 是这个扩展里已经出现过的 id） */
export function commandProblems(raw: unknown, seen: Set<string>, validText: (v: unknown) => boolean): CommandProblem[] {
  const out: CommandProblem[] = []
  const bad = (zh: string, en: string, path?: string): void => {
    out.push({ code: 'command.fields', zh, en, path })
  }
  if (!isRec(raw)) {
    bad('这一条必须是对象', 'This entry must be an object')
    return out
  }
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id))
    bad('id 只能用字母、数字和 -，最多 48 个字符', 'id may only use letters, digits and -, up to 48 characters', 'id')
  else if (seen.has(raw.id)) bad(`id「${raw.id}」重复了`, `Duplicate id "${raw.id}"`, 'id')
  else seen.add(raw.id)
  if (!validText(raw.title))
    bad('title 必须是非空文字或 { zh, en }', 'title must be non-empty text or { zh, en }', 'title')
  if (raw.description !== undefined && !validText(raw.description))
    bad('description 必须是非空文字或 { zh, en }', 'description must be non-empty text or { zh, en }', 'description')
  if (raw.where !== undefined) {
    const w = raw.where
    if (
      !(
        Array.isArray(w) &&
        w.length > 0 &&
        new Set(w).size === w.length &&
        w.every(x => x === 'palette' || x === 'editor')
      )
    )
      bad('where 只能是 palette、editor', 'where may only be palette and editor', 'where')
  }
  if (raw.requires !== undefined && raw.requires !== 'selection' && raw.requires !== 'editor')
    bad('requires 只能是 editor、selection', 'requires may only be editor or selection', 'requires')
  if (raw.keybinding !== undefined) out.push(...keybindingProblems(raw.keybinding))
  return out
}

function keybindingProblems(k: unknown): CommandProblem[] {
  const bad = (zh: string, en: string): CommandProblem[] => [{ code: 'command.keybinding', zh, en, path: 'keybinding' }]
  if (!isRec(k) || typeof k.code !== 'string')
    return bad('keybinding 必须是 { code, mod, shift, alt }', 'keybinding must be { code, mod, shift, alt }')
  for (const key of ['mod', 'shift', 'alt'])
    if (k[key] !== undefined && typeof k[key] !== 'boolean')
      return bad(`keybinding.${key} 必须是 true 或 false`, `keybinding.${key} must be true or false`)
  if (F_KEY.test(k.code)) return []
  if (!NEEDS_MODIFIER.test(k.code)) return bad(`不认识的按键「${k.code}」`, `Unknown key "${k.code}"`)
  if (k.mod !== true && k.alt !== true)
    return bad('这个按键要带 mod 或 alt，不然打字时就会触发', 'This key needs mod or alt, or typing would trigger it')
  return []
}

/** permissions 的问题（带脚本的扩展才走这里）：未知或重复都拒绝 */
export function permissionProblems(list: unknown[]): CommandProblem[] {
  const out: CommandProblem[] = []
  const seen = new Set<unknown>()
  for (const p of list) {
    if (typeof p !== 'string' || !EXT_SCRIPT_PERMISSIONS.includes(p))
      out.push({
        code: 'manifest.permissions',
        zh: `不认识的权限「${String(p)}」，只能用 ${EXT_SCRIPT_PERMISSIONS.join('、')}`,
        en: `Unknown permission "${String(p)}"; allowed: ${EXT_SCRIPT_PERMISSIONS.join(', ')}`,
        path: 'permissions',
      })
    else if (seen.has(p))
      out.push({
        code: 'manifest.permissions',
        zh: `权限「${p}」重复了`,
        en: `Duplicate permission "${p}"`,
        path: 'permissions',
      })
    seen.add(p)
  }
  return out
}

/** 脚本正文的问题：太大、压缩或混淆过（审核看不了） */
export function scriptProblems(path: string, text: string): CommandProblem[] {
  const lines = text.split('\n')
  const longest = lines.reduce((max, l) => Math.max(max, l.length), 0)
  const average = text.length / lines.length
  if (longest > EXT_LIMITS.scriptLineChars || average > EXT_LIMITS.scriptAverageLineChars)
    return [
      {
        code: 'script.minified',
        zh: `脚本像是压缩或混淆过（最长一行 ${longest} 个字符），要提交可读的源码：${path}`,
        en: `The script looks minified or obfuscated (longest line ${longest} characters). Submit readable source: ${path}`,
        path,
      },
    ]
  return []
}
