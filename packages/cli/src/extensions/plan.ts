// 计划模式：只读探索 → 用 exit_plan_mode 交出计划 → 用户确认后退出计划模式开始执行。
// 做法参照 Pi 随包的官方示例 examples/extensions/plan-mode（MIT）：每轮开始前注入一段说明告诉模型现在是计划模式，
// 退出计划模式后从上下文里去掉这段说明。权限模式本身在批准扩展（approval.ts）里，这里只放常量和纯函数。
// 只用可擦除的 TS 语法。
import { Type } from 'typebox'

export const EXIT_PLAN_TOOL = 'exit_plan_mode'
/** 计划确认的两个选项。桌面端适配器按原文认出「这是计划确认」（packages/engine/src/pixel/translate.ts 的 PLAN_OPTIONS） */
export const START_OPTION = '开始执行 / Start implementing'
export const REFINE_OPTION = '继续完善计划 / Keep planning'
export const PLAN_OPTIONS = [START_OPTION, REFINE_OPTION] as const
/** 计划确认对话框标题的第一行，后面跟计划正文 */
export const PLAN_TITLE = '计划已就绪，要开始执行吗？ / Ready to implement this plan?'
/** 注入的说明消息（customType），退出计划模式后从上下文里去掉 */
export const PLAN_CONTEXT = 'pixelsky-plan-mode'

export const PLAN_PROMPT = `[PLAN MODE ACTIVE]
You are in plan mode: explore and design, but do not change anything yet.

- Editing and writing files is blocked, and so are shell commands. Use read, grep, find and ls to investigate.
- When the plan is ready, call the ${EXIT_PLAN_TOOL} tool with the full plan in Markdown (goal, steps, files to change, how to verify). The user will review it.
- If the user approves, plan mode ends and you implement the plan. If not, ask what to change and revise the plan.
- Do not ask "should I proceed?" in text; ${EXIT_PLAN_TOOL} is how you ask.`

export function planTitle(plan: string): string {
  return `${PLAN_TITLE}\n${plan}`
}

export type PlanResult = { text: string; approved: boolean }

/** 用户的选择 → 回给模型的工具结果 */
export function planResult(choice: string | undefined): PlanResult {
  if (choice === START_OPTION)
    return {
      approved: true,
      text: 'The user approved the plan. Plan mode is now off. Implement the plan step by step, keeping the todo list updated.',
    }
  return {
    approved: false,
    text: 'The user wants to keep refining the plan. You are still in plan mode: ask what should change, then call exit_plan_mode again with the revised plan.',
  }
}

export const exitPlanParameters = Type.Object({
  plan: Type.String({
    minLength: 1,
    description:
      'The complete implementation plan in Markdown: goal, ordered steps, files to change, and how to verify',
  }),
})

export const EXIT_PLAN_DESCRIPTION = `Present your implementation plan to the user for approval and leave plan mode. Only use this in plan mode, once you have finished investigating and the plan is complete. Pass the whole plan as Markdown. If the user approves, implement it; otherwise revise the plan.`

/** 消息里是不是我们注入的计划模式说明 */
export function isPlanContext(message: unknown): boolean {
  const m = (message && typeof message === 'object' ? message : {}) as { customType?: unknown; content?: unknown }
  if (m.customType === PLAN_CONTEXT) return true
  const text =
    typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(c => (c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : '')).join('')
        : ''
  return text.startsWith('[PLAN MODE ACTIVE]')
}
