import type { SkillCommand } from '@pixelsky/protocol'

const KEY = 'pixelsky.engine-commands.v1'
type Remembered = Record<string, SkillCommand[]>

function readRemembered(): Remembered {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Remembered) : {}
  } catch {
    return {}
  }
}

/** 引擎进程报上来的技能按「引擎:项目」记下：Codex 发第一条消息才起进程，之前「$」菜单拿这份顶上 */
/** all：连斜杠命令一起记（Antigravity 的命令都是进程报的，Codex 只记技能） */
export function rememberCommands(key: string, commands: SkillCommand[], all = false): void {
  try {
    // shortcut: 每个项目一份、不清旧项目，项目上千时再按最近使用裁剪
    const skills = all ? commands : commands.filter(c => c.invocation === 'skill')
    localStorage.setItem(KEY, JSON.stringify({ ...readRemembered(), [key]: skills }))
  } catch {
    // 存不了只是下次还得等进程起来
  }
}

export function rememberedCommands(key: string): SkillCommand[] {
  const list = readRemembered()[key]
  return Array.isArray(list) ? list.filter(c => c && typeof c.name === 'string') : []
}
