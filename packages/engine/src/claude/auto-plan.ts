// 多步任务自动列计划（docs/ui/progress-card.md §10）：-p 模式下任务工具要先 ToolSearch，模型几乎不主动用，
// 进度卡片只在用户点名「任务清单」时才出现。启动时用 --append-system-prompt-file 追加这段说明。
// 措辞照 2026-11-04 实测（2.1.317）：温和的说法 Sonnet 0/4 不列，这版 2/2 列、简单问答和一步的活不列
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const AUTO_PLAN_PROMPT = `# Progress list (required by this app)
This app shows your task list to the user as a live progress card; it is the only way they can see where you are.
- If the request involves 3 or more distinct actions (for example: write code, write tests, run them, fix failures), your FIRST tool call must create the list: one TaskCreate per step. Do this even if each step is quick.
- Set a task to in_progress right before you start it and to completed right after it is done.
- Do not create a list for questions, explanations, or one- or two-action requests.
`

/**
 * 说明文件的路径（用文件不用命令行字符串：Windows 的 .cmd 启动器处理换行和引号不可靠）。
 * 关掉了、或用户把任务工具关了时返回 null；写不了文件也返回 null，照常启动。
 * 照 Claude Code 自己的读法：CLAUDE_CODE_ENABLE_TODO_TOOLS 只有 1/true/yes/on 算开（没设时启动环境会补成 1），
 * CLAUDE_CODE_ENABLE_TASKS 是 0/false/no/off 时任务工具也关
 * shortcut: settings.json 里的 env 不看，只看启动环境；有人在那里关了再补
 */
export function autoPlanFile(on: boolean, env: Record<string, string | undefined>, dir?: string): string | null {
  const flag = (name: string) => env[name]?.trim().toLowerCase()
  const tools = flag('CLAUDE_CODE_ENABLE_TODO_TOOLS')
  const tasks = flag('CLAUDE_CODE_ENABLE_TASKS')
  if (!on) return null
  if (tools !== undefined && !['1', 'true', 'yes', 'on'].includes(tools)) return null
  if (tasks !== undefined && ['0', 'false', 'no', 'off'].includes(tasks)) return null
  const base = dir ?? tmpdir()
  const file = join(base, 'claude-auto-plan.md')
  try {
    let current: string | null = null
    try {
      current = readFileSync(file, 'utf8')
    } catch {
      // 还没写过
    }
    if (current !== AUTO_PLAN_PROMPT) {
      mkdirSync(base, { recursive: true })
      writeFileSync(file, AUTO_PLAN_PROMPT)
    }
    return file
  } catch {
    return null
  }
}
