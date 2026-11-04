// 脚本扩展的命令：列表、能不能用、快捷键（docs/ui/extension-commands-plan.md §5）。纯函数，测试直接用
import { extText, packName, type ExtCommand, type ExtLocale, type ExtPackState } from '@pixelsky/protocol'
import { sameBinding, parseBinding, type Binding } from '@/features/layout/keybindingModel'
import type { TranslationKey } from '@/i18n/core'
import { contributionsFrom } from '../model'

export const PERMISSION_TEXT: Record<string, TranslationKey> = {
  'editor.read': 'extCommands.permission.editorRead',
  'editor.write': 'extCommands.permission.editorWrite',
  'ui.notify': 'extCommands.permission.uiNotify',
  storage: 'extCommands.permission.storage',
}

export interface PackCommand {
  packKey: string
  packName: string
  id: string
  title: string
  description: string | null
  where: NonNullable<ExtCommand['where']>
  requires: ExtCommand['requires'] | null
  binding: Binding | null
}

/** 生效的命令；商店里非官方发布者的脚本（script.blocked）现阶段不列 */
export function packCommands(state: ExtPackState, locale: ExtLocale): PackCommand[] {
  const blocked = new Set(state.packs.filter(p => p.script?.blocked).map(p => p.key))
  return contributionsFrom(state, 'commands')
    .filter(({ pack }) => !blocked.has(pack.key))
    .map(({ pack, item }) => ({
      packKey: pack.key,
      packName: pack.manifest ? packName(pack.manifest, locale) : pack.key,
      id: item.id,
      title: extText(item.title, locale),
      description: item.description ? extText(item.description, locale) : null,
      where: item.where ?? ['palette'],
      requires: item.requires ?? null,
      binding: item.keybinding ? parseBinding(item.keybinding) : null,
    }))
}

export interface EditorSnapshot {
  hasEditor: boolean
  hasSelection: boolean
}

/** 不能运行的原因；能运行时为 null */
export function commandBlock(command: PackCommand, editor: EditorSnapshot): 'editor' | 'selection' | null {
  if (command.requires === 'editor' && !editor.hasEditor) return 'editor'
  if (command.requires === 'selection') {
    if (!editor.hasEditor) return 'editor'
    if (!editor.hasSelection) return 'selection'
  }
  return null
}

/** 编辑时离不开的键，扩展不能占（CodeMirror 不拦它们，它们走系统默认行为） */
const key = (code: string, shift = false): Binding => ({ code, mod: true, shift, alt: false })
export const RESERVED_BINDINGS: readonly Binding[] = [
  key('KeyA'),
  key('KeyC'),
  key('KeyV'),
  key('KeyX'),
  key('KeyZ'),
  key('KeyZ', true),
  key('KeyY'),
  key('KeyS'),
]

/**
 * 真正生效的快捷键：和软件自带的（taken）、必留的冲突就不生效，几个扩展抢同一个键时第一个生效。
 * 返回 [命令, 键]，顺序和 commands 一致
 */
export function activeBindings(commands: readonly PackCommand[], taken: readonly Binding[]): PackCommand[] {
  const used: Binding[] = [...RESERVED_BINDINGS, ...taken]
  const out: PackCommand[] = []
  for (const c of commands) {
    if (!c.binding || used.some(b => sameBinding(b, c.binding!))) continue
    used.push(c.binding)
    out.push(c)
  }
  return out
}
