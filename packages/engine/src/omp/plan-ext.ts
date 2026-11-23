// oh-my-pi 的计划模式（docs/omp-engine.md §11.5）：omp 自带的计划模式在 RPC 里进不去（只有终端界面和 ACP 有），
// 照像素星空引擎的做法（packages/cli/src/extensions/plan.ts）写一个扩展，omp 会话总是 -e 加载：
// 计划档启动（OMP_PLAN_ENV=1）时注入计划说明、按白名单拦工具、exit_plan_mode 弹我们的计划卡（标题和选项原文同
// pixel/translate.ts，isPlanSelect 认得），批准后 setStatus('pixelsky-mode', <回到的档>) 报给宿主（PixelSession.syncMode）。
// 不在计划档也要加载：注入的计划说明留在会话历史里，换了进程（批准后回到完全放行、空闲关掉、重开应用）要靠它从上下文里滤掉，
// 不然模型还以为在计划档（实测）。再回到计划要换进程（权限档变了本来就换进程，pixel/session.ts ompRestarts）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_PLAN_TOOL, PLAN_OPTIONS, PLAN_TITLE } from '../pixel/translate'

/** 批准后报给宿主的档（PIXEL_MODES 的值） */
export const OMP_PLAN_RETURN_ENV = 'PIXELSKY_OMP_PLAN_RETURN'
/** 为 1 时这个进程以计划档启动 */
export const OMP_PLAN_ENV = 'PIXELSKY_OMP_PLAN'

/**
 * 计划中放行的工具：只读的查看、搜索、联网，和计划本身要用的。bash、编辑、eval、task（子智能体，计划状态不共享，没核实）、
 * MCP 和不认识的一律拦——白名单，不是黑名单
 */
export const OMP_PLAN_ALLOW = [
  'read',
  'glob',
  'grep',
  'ast_grep',
  'web_search',
  'fetch',
  'ask',
  'todo',
  'wait',
  EXIT_PLAN_TOOL,
] as const

const PLAN_PROMPT = `[PLAN MODE ACTIVE]
You are in plan mode: explore and design, but do not change anything yet.

- Editing and writing files is blocked, and so are shell commands and subagents. Use read, glob, grep and ast_grep to investigate; web_search and fetch also work.
- When the plan is ready, call the ${EXIT_PLAN_TOOL} tool with the full plan in Markdown (goal, steps, files to change, how to verify). The user will review it.
- If the user approves, plan mode ends and you implement the plan. If not, ask what to change and revise the plan.
- Do not ask "should I proceed?" in text; ${EXIT_PLAN_TOOL} is how you ask.`

export const OMP_PLAN_SOURCE = `// 像素星空写的文件，每次启动会覆盖。oh-my-pi 的计划模式（权限档是计划时加载）
const EXIT_PLAN_TOOL = ${JSON.stringify(EXIT_PLAN_TOOL)}
const PLAN_TITLE = ${JSON.stringify(PLAN_TITLE)}
const [START, REFINE] = ${JSON.stringify(PLAN_OPTIONS)}
const PLAN_CONTEXT = 'pixelsky-plan-mode'
const MODE_STATUS = 'pixelsky-mode'
const PLAN_PROMPT = ${JSON.stringify(PLAN_PROMPT)}
const ALLOW = new Set(${JSON.stringify(OMP_PLAN_ALLOW)})

export default function pixelskyPlan(pi) {
  // 计划状态整个进程共用：子智能体会把扩展再挂一份（同一个进程），批准之后它们也不能还在计划里
  const state = (globalThis.__pixelskyOmpPlan ??= { plan: process.env.${OMP_PLAN_ENV} === '1' })
  const back = process.env.${OMP_PLAN_RETURN_ENV} || 'default'
  // omp 的 before_agent_start 不带 messageType（实测）：每次都注入
  pi.on('before_agent_start', async () => {
    if (!state.plan) return undefined
    return { message: { customType: PLAN_CONTEXT, content: PLAN_PROMPT, display: false } }
  })
  pi.on('context', async event => {
    if (state.plan) return undefined
    return { messages: event.messages.filter(m => m.customType !== PLAN_CONTEXT) }
  })
  // 拦截在 omp 自己的确认之前（实测），「每次都问」档下也不弹确认卡
  pi.on('tool_call', async event => {
    // 应用自己的只读工具（对话历史、频道里读和记录的）也放行，名单由 tools-ext.ts 按工具的只读标记给
    if (!state.plan || ALLOW.has(event.toolName) || globalThis.__pixelskyOmpTools?.readOnly.has(event.toolName)) return undefined
    return {
      block: true,
      reason: 'Tool "' + event.toolName + '" is blocked: the session is in plan mode (read-only). Investigate with read/glob/grep, then call ' + EXIT_PLAN_TOOL + ' with your plan.',
    }
  })
  // 不在计划档启动的不注册交计划的工具（模型看到它会想去调）
  if (!state.plan) return
  const T = pi.typebox.Type
  pi.registerTool({
    name: EXIT_PLAN_TOOL,
    label: 'Plan',
    description: 'Present your implementation plan to the user for approval and leave plan mode. Only use this in plan mode, once the plan is complete. Pass the whole plan as Markdown. If the user approves, implement it; otherwise revise the plan.',
    parameters: T.Object({
      plan: T.String({ minLength: 1, description: 'The complete implementation plan in Markdown: goal, ordered steps, files to change, and how to verify' }),
    }),
    approval: 'read',
    loadMode: 'essential',
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const text = s => ({ content: [{ type: 'text', text: s }], details: { plan: params.plan } })
      if (!state.plan) return text('Not in plan mode; nothing to approve. Continue with the task.')
      if (!ctx.hasUI) return text('No interactive user is available to approve the plan. Present the plan as your final answer instead.')
      const choice = await ctx.ui.select(PLAN_TITLE + '\\n' + params.plan, [START, REFINE])
      if (choice === START) {
        state.plan = false
        ctx.ui.setStatus(MODE_STATUS, back)
        return text('The user approved the plan. Plan mode is now off. Implement the plan step by step, keeping the todo list updated.')
      }
      return text('The user wants to keep refining the plan. You are still in plan mode: ask what should change, then call ' + EXIT_PLAN_TOOL + ' again with the revised plan.')
    },
  })
}
`

/** 写到 dir 下（内容一样就不写），返回文件路径 */
export function writeOmpPlan(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'pixelsky-plan.mjs')
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // 还没有
  }
  if (current !== OMP_PLAN_SOURCE) writeFileSync(file, OMP_PLAN_SOURCE)
  return file
}
