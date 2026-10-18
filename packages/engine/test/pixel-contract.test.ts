// 命令行（packages/cli）和适配器各写了一份的约定：对话框原文、状态键、条目类型、工具名。改一边忘了另一边，
// 审批 / 计划确认就会退回成普通问答卡、子智能体追踪就读不到，这里直接对照两边的常量。
// 命令行的源码用 .ts 后缀互相引用，engine 的 tsconfig 不收，所以运行时再动态加载（只有 vitest 跑它）。
import { describe, expect, it } from 'vitest'
import { APPROVAL_CONTEXT_STATUS, SUBAGENT_ENTRY, SUBAGENT_TOOL } from '../src/pixel/agents'
import { ALLOW_TOOLS_ENV, MCP_FILE_ENV, PIXEL_MODES, PROVIDERS_ENV } from '../src/pixel/session'
import {
  APPROVAL_OPTIONS,
  EXIT_PLAN_TOOL,
  PLAN_OPTIONS,
  PLAN_TITLE,
  approvalFor,
  approvalSummary,
  isApprovalSelect,
  isPlanSelect,
  toolNameFromTitle,
} from '../src/pixel/translate'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cli = (path: string): Promise<any> =>
  import(/* @vite-ignore */ new URL(`../../cli/src/${path}`, import.meta.url).href)

describe('像素星空：命令行和适配器的约定一致', () => {
  it('对话框原文、状态键、条目类型、工具名', async () => {
    const approval = await cli('extensions/approval.ts')
    const plan = await cli('extensions/plan.ts')
    const gateway = await cli('extensions/gateway.ts')
    const subagent = await cli('tools/subagent.ts')
    expect([...APPROVAL_OPTIONS]).toEqual([...approval.APPROVAL_OPTIONS])
    expect([...PLAN_OPTIONS]).toEqual([...plan.PLAN_OPTIONS])
    expect(PLAN_TITLE).toBe(plan.PLAN_TITLE)
    expect(EXIT_PLAN_TOOL).toBe(plan.EXIT_PLAN_TOOL)
    expect(SUBAGENT_TOOL).toBe(subagent.SUBAGENT_TOOL)
    expect(SUBAGENT_ENTRY).toBe(subagent.SUBAGENT_ENTRY)
    expect(PROVIDERS_ENV).toBe(gateway.PROVIDERS_ENV)
    expect(approval.MODE_STATUS).toBe('pixelsky-mode')
    expect(Object.values(PIXEL_MODES).sort()).toEqual([...approval.PERMISSION_MODES].sort())
    const mcp = await cli('extensions/mcp.ts')
    expect(MCP_FILE_ENV).toBe(mcp.MCP_FILE_ENV)
    expect(ALLOW_TOOLS_ENV).toBe(approval.ALLOW_TOOLS_ENV)
    expect(APPROVAL_CONTEXT_STATUS).toBe(subagent.APPROVAL_CONTEXT_STATUS)
  })
  it('询问标题第二行的摘要：两边算法一样（适配器靠它把询问对上工具条目）', async () => {
    const approval = await cli('extensions/approval.ts')
    for (const [name, args] of [
      ['bash', { command: 'npm test' }],
      ['bash', { command: 'x'.repeat(2000) }],
      ['write', { path: 'a.ts', content: 'x' }],
      ['edit', { file_path: 'b'.repeat(500) }],
      ['mcp__gh__create_issue', { title: '标题', body: 'y'.repeat(900) }],
      ['web_fetch', { url: 'https://example.com' }],
      ['web_fetch', { prompt: 'p'.repeat(900), url: 'http://127。0。0。1/' }],
      ['web_fetch', { url: 'not a url' }],
      ['bash', { command: `${'x'.repeat(799)}${String.fromCharCode(0xd83d, 0xde00)}tail` }],
      ['task', {}],
    ] as const) {
      expect(approvalSummary(args, name)).toBe(approval.describeToolCall(name, args))
      expect(toolNameFromTitle(approval.approvalTitle(name, args))).toBe(name)
    }
  })
  it('命令行生成的标题，适配器认得出来', async () => {
    const approval = await cli('extensions/approval.ts')
    const plan = await cli('extensions/plan.ts')
    const title: string = approval.approvalTitle('bash', { command: 'npm test' })
    expect(isApprovalSelect(title, [...approval.APPROVAL_OPTIONS])).toBe(true)
    expect(approvalFor('r', title, title.split('\n').slice(1).join('\n'), null)).toMatchObject({
      kind: 'tool',
      toolName: 'bash',
      input: 'npm test',
    })
    expect(isPlanSelect(plan.planTitle('# p'), [...plan.PLAN_OPTIONS])).toBe(true)
    expect(isPlanSelect(plan.planTitle('# p'), [...approval.APPROVAL_OPTIONS])).toBe(false)
  })
})
