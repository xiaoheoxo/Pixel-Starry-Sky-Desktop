// 「/」菜单里像素星空自己处理的 Codex 命令（docs/ui/codex-flow-slash-feedback.md B，D277）：
// 选了直接打开已有的功能，不发给 Codex。只在 Codex 会话里列；表里没有的 /xxx 照旧原样发给引擎
import type { EngineId } from '@pixelsky/protocol'
import type { ComposerController } from '@/features/engine'
import type { AppCommand } from '@/features/resume/useResumeCommand'
import { tr, type TranslationKey } from '../../i18n/core'

export type AppCommandGroup = 'chat' | 'mode' | 'view'

/** 命令要用的已有入口；拿不到的（新任务页没有旁聊、归档）传 null，那条命令就不列 */
export interface AppCommandContext {
  live: Pick<
    ComposerController,
    | 'sessionId'
    | 'started'
    | 'fast'
    | 'fastSupported'
    | 'fastAvailable'
    | 'fastBlocked'
    | 'setFast'
    | 'permissionMode'
    | 'permissionModes'
    | 'defaultPermissionMode'
    | 'setPermissionMode'
  >
  newChat(): void
  fork(): void
  openSide: (() => void) | null
  archive: (() => void) | null
  openModelMenu(): void
  openEffortMenu(): void
  /** 右栏概况；代码模式没有概况，传 null */
  openOverview: (() => void) | null
  openFeedback(): void
}

interface Spec {
  name: string
  group: AppCommandGroup
  description(ctx: AppCommandContext): TranslationKey
  available(ctx: AppCommandContext): boolean
  /** 执行；做不了时返回给用户看的一句话 */
  run(ctx: AppCommandContext): string | null
}

const inSession = (ctx: AppCommandContext): boolean => ctx.live.sessionId !== null
const done = (fn: () => void): null => {
  fn()
  return null
}

const SPECS: Spec[] = [
  { name: 'new', group: 'chat', description: () => 'appCommand.new', available: inSession, run: c => done(c.newChat) },
  {
    name: 'fork',
    group: 'chat',
    description: () => 'appCommand.fork',
    available: c => inSession(c) && c.live.started,
    run: c => done(c.fork),
  },
  {
    name: 'side',
    group: 'chat',
    description: () => 'appCommand.side',
    available: c => !!c.openSide,
    run: c => done(c.openSide!),
  },
  {
    name: 'archive',
    group: 'chat',
    description: () => 'appCommand.archive',
    available: c => !!c.archive,
    run: c => done(c.archive!),
  },
  {
    name: 'model',
    group: 'mode',
    description: () => 'appCommand.model',
    available: () => true,
    run: c => done(c.openModelMenu),
  },
  {
    name: 'effort',
    group: 'mode',
    description: () => 'appCommand.effort',
    available: () => true,
    run: c => done(c.openEffortMenu),
  },
  {
    name: 'fast',
    group: 'mode',
    description: c => (c.live.fast ? 'appCommand.fastOff' : 'appCommand.fastOn'),
    available: c => c.live.fastSupported,
    run: c => {
      if (!c.live.fast && c.live.fastAvailable === false) return c.live.fastBlocked ?? tr('appCommand.fastUnavailable')
      c.live.setFast(!c.live.fast)
      return null
    },
  },
  {
    name: 'plan',
    group: 'mode',
    description: c => (c.live.permissionMode === 'plan' ? 'appCommand.planOff' : 'appCommand.planOn'),
    available: c => c.live.permissionModes.includes('plan'),
    run: c => {
      const { permissionMode, defaultPermissionMode, setPermissionMode } = c.live
      // 退出时回到这个引擎新会话的默认权限；默认就是计划模式时回到「编辑」
      setPermissionMode(
        permissionMode !== 'plan' ? 'plan' : defaultPermissionMode !== 'plan' ? defaultPermissionMode : 'edits',
      )
      return null
    },
  },
  {
    name: 'status',
    group: 'view',
    description: () => 'appCommand.status',
    available: c => inSession(c) && !!c.openOverview,
    run: c => done(c.openOverview!),
  },
  {
    name: 'mcp',
    group: 'view',
    description: () => 'appCommand.mcp',
    available: c => inSession(c) && !!c.openOverview,
    run: c => done(c.openOverview!),
  },
  {
    name: 'feedback',
    group: 'view',
    description: () => 'appCommand.feedback',
    available: () => true,
    run: c => done(c.openFeedback),
  },
]

export const APP_COMMAND_NAMES: readonly string[] = SPECS.map(s => s.name)

/** 现在能用的命令（菜单里列的），按表的顺序；不是 Codex 时没有 */
export function appCommandsFor(engine: EngineId | null | undefined, ctx: AppCommandContext): AppCommand[] {
  if (engine !== 'codex') return []
  return SPECS.filter(s => s.available(ctx)).map(s => ({
    invocation: 'app',
    name: s.name,
    description: tr(s.description(ctx)),
    source: 'app',
    group: s.group,
  }))
}

/** 菜单里选中或手打整段「/名字」回车时执行；不是表里的命令返回 undefined（调用方照旧处理） */
export function runAppCommand(name: string, ctx: AppCommandContext): string | null | undefined {
  const spec = SPECS.find(s => s.name === name)
  return spec && spec.available(ctx) ? spec.run(ctx) : undefined
}

/** 手打的整段命令：「/fast」「 /fast 」算，「/fast 打开」（带参数）不算，照原样发给引擎 */
export function typedAppCommand(text: string): string | null {
  const m = /^\/([a-z]+)$/.exec(text.trim())
  return m && APP_COMMAND_NAMES.includes(m[1]) ? m[1] : null
}
