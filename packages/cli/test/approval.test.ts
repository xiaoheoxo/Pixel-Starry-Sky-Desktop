import { describe, expect, it } from 'vitest'
import {
  ALLOW_OPTION,
  ALWAYS_OPTION,
  APPROVAL_OPTIONS,
  DENY_OPTION,
  PERMISSION_MODES,
  ALLOW_TOOLS_ENV,
  RULE_ENTRY,
  ruleKey,
  approvalTitle,
  approvalTool,
  createApprovalExtension,
  decidePermission,
  describeToolCall,
  isAllowedTool,
  resolvePermissionMode,
  type PermissionMode,
} from '../src/extensions/approval.ts'
import {
  EXIT_PLAN_TOOL,
  PLAN_CONTEXT,
  PLAN_OPTIONS,
  PLAN_TITLE,
  REFINE_OPTION,
  START_OPTION,
} from '../src/extensions/plan.ts'

const decide = (mode: PermissionMode, toolName: string, hasUI = true) =>
  decidePermission({ mode, toolName, hasUI }).action

describe('decidePermission', () => {
  it('default: 只读放行，编辑 / shell / 未知工具询问', () => {
    // codemode 脚本本身放行：脚本里的每个工具调用另走一次这里
    for (const t of ['read', 'ls', 'find', 'grep', 'todo_write', 'codemode', 'read_mcp_resource', 'list_mcp_resources'])
      expect(decide('default', t)).toBe('allow')
    for (const t of ['edit', 'write', 'bash', 'powershell', 'mcp__x__y']) expect(decide('default', t)).toBe('ask')
  })

  it('acceptEdits: edit / write 放行，shell 与未知工具询问', () => {
    expect(decide('acceptEdits', 'edit')).toBe('allow')
    expect(decide('acceptEdits', 'write')).toBe('allow')
    expect(decide('acceptEdits', 'bash')).toBe('ask')
    expect(decide('acceptEdits', 'powershell')).toBe('ask')
    expect(decide('acceptEdits', 'mystery')).toBe('ask')
  })

  it('bypassPermissions: 全部放行（含没有界面时）', () => {
    for (const t of ['read', 'edit', 'bash', 'mystery']) expect(decide('bypassPermissions', t, false)).toBe('allow')
  })

  it('plan: 只读放行，其余拒绝并说明在计划模式', () => {
    expect(decide('plan', 'grep')).toBe('allow')
    expect(decide('plan', 'codemode')).toBe('allow')
    for (const t of ['edit', 'write', 'bash', 'powershell', 'mystery']) {
      const d = decidePermission({ mode: 'plan', toolName: t, hasUI: true })
      expect(d.action).toBe('block')
      expect(d.action === 'block' && d.reason).toContain('plan mode')
    }
  })

  it('没有界面时，需要询问的一律拒绝并给出原因', () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const d = decidePermission({ mode, toolName: 'bash', hasUI: false })
      expect(d.action).toBe('block')
      expect(d.action === 'block' && d.reason).toContain('no interactive UI')
    }
    expect(decide('default', 'read', false)).toBe('allow')
    expect(decide('acceptEdits', 'edit', false)).toBe('allow')
  })
})

describe('resolvePermissionMode', () => {
  it('命令行参数优先于环境变量，默认 default', () => {
    expect(resolvePermissionMode(undefined, undefined).mode).toBe('default')
    expect(resolvePermissionMode(undefined, 'plan').mode).toBe('plan')
    expect(resolvePermissionMode('acceptEdits', 'plan').mode).toBe('acceptEdits')
    expect(resolvePermissionMode('', 'plan').mode).toBe('plan')
  })

  it('不认识的值回落 default 并给警告', () => {
    const r = resolvePermissionMode('yolo', undefined)
    expect(r.mode).toBe('default')
    expect(r.warning).toContain('yolo')
    for (const m of PERMISSION_MODES) expect(resolvePermissionMode(m, undefined).warning).toBeUndefined()
  })
})

describe('describeToolCall', () => {
  it('优先显示命令 / 路径并截断', () => {
    expect(describeToolCall('bash', { command: 'ls -la' })).toBe('ls -la')
    expect(describeToolCall('edit', { path: 'a.ts' })).toBe('a.ts')
    expect(describeToolCall('bash', { command: 'x'.repeat(2000) }).length).toBe(801)
  })

  it('web_fetch：先写归一化后的网址，再写 prompt；prompt 再长网址也不会被截没', () => {
    expect(describeToolCall('web_fetch', { prompt: 'p'.repeat(2000), url: 'https://Example.com/a' })).toMatch(
      /^https:\/\/example\.com\/a — p+…$/,
    )
    expect(describeToolCall('web_fetch', { url: 'https://example.com/' })).toBe('https://example.com/')
  })

  it('web_fetch：各种写法的本机地址在摘要里现出原形（显示归一化后的网址）', () => {
    expect(describeToolCall('web_fetch', { url: 'http://127。0。0。1/' })).toBe('http://127.0.0.1/')
    expect(describeToolCall('web_fetch', { url: 'http://2130706433/' })).toBe('http://127.0.0.1/')
    expect(describeToolCall('web_fetch', { url: 'http://ｌｏｃａｌｈｏｓｔ:3000/' })).toBe('http://localhost:3000/')
    // 不是合法网址：照原文显示
    expect(describeToolCall('web_fetch', { url: 'not a url' })).toBe('not a url')
  })

  it('截断不劈开 emoji', () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00)
    expect(describeToolCall('bash', { command: `${'x'.repeat(799)}${emoji}tail` })).toBe(`${'x'.repeat(799)}…`)
  })
})

describe('isAllowedTool / approvalTool', () => {
  it('PIXELSKY_ALLOW_TOOLS：写工具名，或 mcp__<服务器> 表示这个服务器的全部工具', () => {
    expect(isAllowedTool('mcp__pixelsky_history__search', 'mcp__pixelsky_history')).toBe(true)
    expect(isAllowedTool('mcp__pixelsky_history', 'mcp__pixelsky_history')).toBe(true)
    expect(isAllowedTool('mcp__pixelsky_historyx__a', 'mcp__pixelsky_history')).toBe(false)
    // 服务器名里的 - 在 Pi 的工具名里是 _
    expect(isAllowedTool('mcp__dev_radius__x', ' mcp__dev-radius , bash')).toBe(true)
    expect(isAllowedTool('bash', 'mcp__a,bash')).toBe(true)
    expect(isAllowedTool('bash', undefined)).toBe(false)
    expect(isAllowedTool('bash', ' , ')).toBe(false)
  })

  it('approvalTool 从询问标题取回工具名', () => {
    expect(approvalTool(approvalTitle('write', { path: 'a.ts' }))).toBe('write')
    expect(approvalTool(approvalTitle('mcp__a__b', {}))).toBe('mcp__a__b')
    expect(approvalTool('计划已就绪，要开始执行吗？')).toBe('')
  })
})

describe('createApprovalExtension', () => {
  function setup(
    mode: PermissionMode,
    hasUI: boolean,
    answer: string | null = ALLOW_OPTION,
    entries: Array<{ type: string; customType?: string; data?: unknown }> = [],
  ) {
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {}
    const flags: string[] = []
    const confirms: string[][] = []
    const appended: Array<[string, unknown]> = []
    const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {}
    const tools: Record<string, { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = {}
    const statuses: string[] = []
    let planAnswer: string | undefined = START_OPTION
    const plans: string[] = []
    const pi = {
      registerFlag: (name: string) => flags.push(name),
      registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands[name] = def.handler
      },
      getFlag: () => undefined,
      registerTool: (tool: { name: string }) => (tools[tool.name] = tool as never),
      appendEntry: (type: string, data: unknown) => appended.push([type, data]),
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers[name] = handler
      },
    }
    const ext = createApprovalExtension({ mode })
    ext(pi as never)
    const ctx = {
      hasUI,
      sessionManager: { getEntries: () => entries },
      ui: {
        setStatus: (key: string, text: string) => statuses.push(`${key}=${text}`),
        select: async (title: string, options: string[]) => {
          if (options[0] === PLAN_OPTIONS[0]) {
            expect(options).toEqual([...PLAN_OPTIONS])
            plans.push(title)
            return planAnswer
          }
          expect(options).toEqual([...APPROVAL_OPTIONS])
          const [head, ...rest] = title.split('\n')
          confirms.push([head, rest.join('\n')])
          return answer ?? undefined
        },
      },
    }
    const start = () => handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx)
    const call = (toolName: string, input: unknown) => handlers.tool_call({ type: 'tool_call', toolName, input }, ctx)
    const notices: string[] = []
    const setMode = (args: string) =>
      commands['pixelsky-mode'](args, { ui: { ...ctx.ui, notify: (message: string) => notices.push(message) } })
    const exitPlan = async (plan: string, answer: string | undefined) => {
      planAnswer = answer
      return (await tools[EXIT_PLAN_TOOL].execute('t1', { plan }, undefined, undefined, ctx)).content[0].text
    }
    const before = () => handlers.before_agent_start({ type: 'before_agent_start', messageType: 'user' }, ctx)
    const context = (messages: unknown[]) => handlers.context({ type: 'context', messages }, ctx)
    return { ext, flags, confirms, appended, call, setMode, notices, start, statuses, exitPlan, plans, before, context }
  }

  it('注册 --permission-mode 参数', () => {
    expect(setup('default', true).flags).toContain('permission-mode')
  })

  it('询问时用户同意放行、拒绝则 block', async () => {
    const yes = setup('default', true, ALLOW_OPTION)
    expect(await yes.call('bash', { command: 'rm -rf x' })).toBeUndefined()
    expect(yes.confirms[0]).toEqual(['允许工具 bash？ / Allow tool bash?', 'rm -rf x'])
    expect(await yes.call('bash', { command: 'rm -rf x' })).toBeUndefined()
    expect(yes.confirms).toHaveLength(2)
    const no = setup('default', true, DENY_OPTION)
    expect(await no.call('bash', { command: 'rm -rf x' })).toMatchObject({ block: true })
    // 对话框超时 / 取消（undefined）按拒绝
    expect(await setup('default', true, null).call('bash', { command: 'x' })).toMatchObject({ block: true })
  })

  it('本会话不再询问：同一条命令 / 同一个工具不再问，记进会话文件', async () => {
    const s = setup('default', true, ALWAYS_OPTION)
    await s.start()
    expect(await s.call('bash', { command: 'npm test' })).toBeUndefined()
    expect(await s.call('bash', { command: ' npm test ' })).toBeUndefined()
    expect(s.confirms).toHaveLength(1)
    // 别的命令照问
    expect(await s.call('bash', { command: 'npm publish' })).toBeUndefined()
    expect(s.confirms).toHaveLength(2)
    expect(await s.call('mcp__gh__create_issue', { title: 'a' })).toBeUndefined()
    expect(await s.call('mcp__gh__create_issue', { title: 'b' })).toBeUndefined()
    expect(s.confirms).toHaveLength(3)
    expect(s.appended).toEqual([
      [RULE_ENTRY, { key: 'bash:npm test' }],
      [RULE_ENTRY, { key: 'bash:npm publish' }],
      [RULE_ENTRY, { key: 'mcp__gh__create_issue' }],
    ])
  })

  it('桌面端声明不用问的工具（PIXELSKY_ALLOW_TOOLS）：不问，计划模式里也放行', async () => {
    process.env[ALLOW_TOOLS_ENV] = 'mcp__pixelsky_history'
    try {
      const s = setup('plan', true, DENY_OPTION)
      expect(await s.call('mcp__pixelsky_history__search', { query: 'x' })).toBeUndefined()
      expect(await s.call('mcp__other__x', {})).toMatchObject({ block: true })
      expect(s.confirms).toHaveLength(0)
    } finally {
      delete process.env[ALLOW_TOOLS_ENV]
    }
  })

  it('allowed / remember：子智能体那边记的规则主会话也认，并写进会话文件', async () => {
    const s = setup('default', true, DENY_OPTION)
    await s.start()
    expect(s.ext.allowed('write')).toBe(false)
    s.ext.remember('write')
    s.ext.remember('write')
    expect(s.ext.allowed('write')).toBe(true)
    expect(s.appended).toEqual([[RULE_ENTRY, { key: 'write' }]])
    expect(await s.call('write', { path: 'a' })).toBeUndefined()
    expect(s.confirms).toHaveLength(0)
  })

  it('续接会话：从会话文件读回规则，规则不越过计划模式', async () => {
    const s = setup('default', true, DENY_OPTION, [
      { type: 'custom', customType: RULE_ENTRY, data: { key: 'write' } },
      { type: 'custom', customType: 'other', data: { key: 'bash:ls' } },
    ])
    await s.start()
    expect(await s.call('write', { path: 'a' })).toBeUndefined()
    expect(s.confirms).toHaveLength(0)
    expect(await s.call('bash', { command: 'ls' })).toMatchObject({ block: true })
    expect(s.confirms).toHaveLength(1)
    await s.setMode('plan')
    expect(await s.call('write', { path: 'a' })).toMatchObject({ block: true })
  })

  it('规则的键：命令按完整命令，其余按工具名', () => {
    expect(ruleKey('bash', { command: ' git status ' })).toBe('bash:git status')
    expect(ruleKey('powershell', { command: 'dir' })).toBe('powershell:dir')
    expect(ruleKey('edit', { path: 'a' })).toBe('edit')
  })

  it('/pixelsky-mode 运行中切换权限模式；不认识的值提示并保持原模式', async () => {
    const s = setup('default', true)
    expect(await s.call('write', { path: 'a' })).toBeUndefined()
    expect(s.confirms).toHaveLength(1)
    await s.setMode('plan')
    expect(await s.call('write', { path: 'a' })).toMatchObject({ block: true })
    await s.setMode('nope')
    expect(s.notices).toHaveLength(1)
    expect(await s.call('write', { path: 'a' })).toMatchObject({ block: true })
    await s.setMode(' bypassPermissions ')
    expect(await s.call('bash', { command: 'x' })).toBeUndefined()
    expect(s.confirms).toHaveLength(1)
  })

  it('没有界面时不询问直接 block；只读工具不询问', async () => {
    const s = setup('default', false)
    expect(await s.call('write', { path: 'a' })).toMatchObject({ block: true })
    expect(await s.call('read', { path: 'a' })).toBeUndefined()
    expect(s.confirms).toHaveLength(0)
  })

  it('计划模式：注入说明、exit_plan_mode 交计划；开始执行回到进入前的模式，继续完善留在计划模式', async () => {
    const s = setup('acceptEdits', true)
    await s.start()
    expect(await s.before()).toBeUndefined()
    await s.setMode('plan')
    expect(s.statuses).toEqual(['pixelsky-mode=acceptEdits', 'pixelsky-mode=plan'])
    expect(await s.before()).toMatchObject({ message: { customType: PLAN_CONTEXT, display: false } })
    expect(await s.call(EXIT_PLAN_TOOL, { plan: 'x' })).toBeUndefined()
    expect(await s.call('write', { path: 'a' })).toMatchObject({ block: true })

    expect(await s.exitPlan('# 计划\n1. 改 a', REFINE_OPTION)).toMatch(/still in plan mode/)
    expect(s.plans[0]).toBe(`${PLAN_TITLE}\n# 计划\n1. 改 a`)
    expect(await s.exitPlan('# 计划', undefined)).toMatch(/still in plan mode/)
    expect(s.statuses.at(-1)).toBe('pixelsky-mode=plan')

    expect(await s.exitPlan('# 计划', START_OPTION)).toMatch(/approved/)
    expect(s.statuses.at(-1)).toBe('pixelsky-mode=acceptEdits')
    // 回到 acceptEdits：改文件不用问
    expect(await s.call('write', { path: 'a' })).toBeUndefined()
    expect(s.confirms).toHaveLength(0)
    // 不在计划模式时调用：什么都不问
    expect(await s.exitPlan('# 计划', START_OPTION)).toMatch(/Not in plan mode/)
    expect(s.plans).toHaveLength(3)
  })

  it('一开始就是计划模式：确认后回到 default；退出后上下文里去掉注入的说明', async () => {
    const s = setup('plan', true)
    await s.start()
    const injected = { role: 'custom', customType: PLAN_CONTEXT, content: '[PLAN MODE ACTIVE] ...' }
    const user = { role: 'user', content: 'hi' }
    expect(await s.context([injected, user])).toBeUndefined()
    await s.exitPlan('# p', START_OPTION)
    expect(s.statuses.at(-1)).toBe('pixelsky-mode=default')
    expect(await s.context([injected, user])).toEqual({ messages: [user] })
  })

  it('没有界面时计划交不出去：不弹框，让模型直接把计划写成回答', async () => {
    const s = setup('plan', false)
    expect(await s.exitPlan('# p', START_OPTION)).toMatch(/No interactive user/)
    expect(s.plans).toHaveLength(0)
  })
})
