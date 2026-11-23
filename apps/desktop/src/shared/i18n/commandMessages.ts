/** Claude Code 内置命令的菜单说明。调用名与原始引擎正文不做翻译。 */
export const commandMessages = {
  'commands.compact': {
    zh: '总结当前对话以释放上下文，可附加摘要要求',
    en: 'Summarize the conversation to free up context; optionally add summary instructions',
  },
  'commands.btw': {
    zh: '临时问一个旁支问题，不加入主对话上下文',
    en: 'Ask a side question without adding it to the main conversation context',
  },
  'commands.context': { zh: '查看当前上下文使用情况', en: 'Show current context usage' },
  'commands.clear': {
    zh: '开始空上下文的新会话，旧会话仍可恢复',
    en: 'Start a new session with empty context; the previous session remains resumable',
  },
  'commands.reset': {
    zh: '开始空上下文的新会话，旧会话仍可恢复',
    en: 'Start a new session with empty context; the previous session remains resumable',
  },
  'commands.new': {
    zh: '开始空上下文的新会话，旧会话仍可恢复',
    en: 'Start a new session with empty context; the previous session remains resumable',
  },
  'commands.model': { zh: '切换 Claude Code 使用的模型', en: 'Change the model used by Claude Code' },
  'commands.effort': { zh: '设置模型的思考强度', en: 'Set the model effort level' },
  'commands.fast': { zh: '开启或关闭快速模式', en: 'Turn fast mode on or off' },
  'commands.focus': {
    zh: '切换专注视图，仅显示提示、摘要和回复',
    en: 'Toggle focus view: prompt, summary and response only',
  },
  'commands.autocompact': { zh: '设置自动压缩上下文的窗口大小', en: 'Configure the auto-compaction window size' },
  'commands.output-style': { zh: '查看或切换回复输出风格', en: 'List or switch output styles' },
  'commands.init': {
    zh: '为当前代码库创建 CLAUDE.md 项目说明',
    en: 'Create a CLAUDE.md file documenting the codebase',
  },
  'commands.rename': { zh: '重命名当前对话', en: 'Rename the current conversation' },
  'commands.name': { zh: '重命名当前对话', en: 'Rename the current conversation' },
  'commands.usage': {
    zh: '查看会话费用、套餐用量及额度消耗来源',
    en: 'Show session cost, plan usage and what contributes to your limits',
  },
  'commands.cost': { zh: '查看会话费用和用量', en: 'Show session cost and usage' },
  'commands.stats': { zh: '查看使用统计', en: 'Show usage statistics' },
  'commands.insights': {
    zh: '分析 Claude Code 会话并生成使用报告',
    en: 'Analyze Claude Code sessions and generate a usage report',
  },
  'commands.recap': { zh: '为当前会话生成一句话摘要', en: 'Generate a one-line recap of the current session' },
  'commands.goal': {
    zh: '设定目标，持续工作直到满足完成条件',
    en: 'Set a goal and keep working until its completion condition is met',
  },
  'commands.handoff': {
    zh: '写一份交接文档代替前面的历史（和换引擎的交接不是一回事）',
    en: 'Write a handoff document that replaces earlier history (not the same as switching engines)',
  },
  'commands.agents': {
    zh: '了解如何创建或管理子代理及其配置',
    en: 'Learn how to create or manage subagents and their configuration',
  },
  'commands.list-agents': {
    zh: '列出可联系的子代理、队友和其他 Claude 会话',
    en: 'List subagents, teammates and other Claude sessions you can message',
  },
  'commands.peers': {
    zh: '列出可联系的子代理、队友和其他 Claude 会话',
    en: 'List subagents, teammates and other Claude sessions you can message',
  },
  'commands.deep-research': {
    zh: '并行搜索与核验资料，生成带来源引用的研究报告',
    en: 'Search and verify sources in parallel, then produce a cited research report',
  },
  'commands.design': {
    zh: '授予或撤销 Claude 对 Design 项目的访问权限',
    en: 'Grant or revoke Claude access to Design projects',
  },
  'commands.design-consent': {
    zh: '授予 Claude 对 Design 项目的访问权限',
    en: 'Grant Claude access to Design projects',
  },
  'commands.design-revoke': {
    zh: '撤销 Claude 对 Design 项目的访问权限',
    en: 'Revoke Claude access to Design projects',
  },
  'commands.design-sync': {
    zh: '将 React 设计系统同步到 Claude Design',
    en: 'Sync a React design system to Claude Design',
  },
  'commands.dataviz': { zh: '使用图表与可视化展示数据', en: 'Present data using charts and visualizations' },
  'commands.update-config': {
    zh: '配置 Claude Code 设置、权限、环境变量与自动化钩子',
    en: 'Configure Claude Code settings, permissions, environment variables and automation hooks',
  },
  'commands.verify': {
    zh: '实际运行并验证代码修改的完整功能流程',
    en: 'Run and verify the complete flow affected by a code change',
  },
  'commands.debug': {
    zh: '开启本次会话调试日志，协助排查问题',
    en: 'Enable session debug logging and help diagnose issues',
  },
  'commands.code-review': {
    zh: '审查当前修改、PR、分支或路径，检查缺陷与改进项',
    en: 'Review changes, a PR, branch or path for bugs and improvements',
  },
  'commands.review': {
    zh: '审查当前修改、PR、分支或路径，检查缺陷与改进项',
    en: 'Review changes, a PR, branch or path for bugs and improvements',
  },
  'commands.simplify': {
    zh: '检查并改进代码复用、简洁性与效率',
    en: 'Review and improve code reuse, simplicity and efficiency',
  },
  'commands.batch': {
    zh: '规划大规模改动，并在多个独立工作树中并行执行',
    en: 'Plan a large-scale change and execute it in parallel in isolated worktrees',
  },
  'commands.fewer-permission-prompts': {
    zh: '分析常用只读工具调用，建议权限白名单以减少确认',
    en: 'Analyze common read-only tool calls and suggest permission rules to reduce prompts',
  },
  'commands.doctor': {
    zh: '检查 Claude Code 安装与配置，诊断问题并协助修复',
    en: 'Check Claude Code installation and configuration, diagnose issues and help fix them',
  },
  'commands.checkup': {
    zh: '检查 Claude Code 安装与配置，诊断问题并协助修复',
    en: 'Check Claude Code installation and configuration, diagnose issues and help fix them',
  },
  'commands.loop': { zh: '按指定时间间隔重复执行提示或命令', en: 'Repeat a prompt or command at a specified interval' },
  'commands.proactive': {
    zh: '按指定时间间隔重复执行提示或命令',
    en: 'Repeat a prompt or command at a specified interval',
  },
  'commands.claude-api': {
    zh: '查阅 Claude API、Anthropic SDK 与模型接入资料',
    en: 'Consult Claude API, Anthropic SDK and model integration references',
  },
  'commands.workflow-authoring': {
    zh: '查阅 Workflow 工作流脚本编写与调试指南',
    en: 'Consult guides for writing and debugging Workflow scripts',
  },
  'commands.run': {
    zh: '启动项目应用，实际操作并验证修改效果',
    en: 'Launch the project app and exercise it to verify a change',
  },
  'commands.run-skill-generator': {
    zh: '为项目创建或完善运行与验证技能',
    en: 'Create or improve project run and verification skills',
  },
  'commands.plugin-authoring': {
    zh: '编写或调试 Claude Code 界面插件与钩子',
    en: 'Write or debug Claude Code UI plugins and hooks',
  },
  'commands.auto-mode-setup': {
    zh: '为自动模式配置当前环境与规则',
    en: 'Configure the environment and rules for auto mode',
  },
  'commands.color': { zh: '设置当前会话提示栏颜色', en: 'Set the prompt bar color for this session' },
  'commands.heapdump': {
    zh: '导出 JavaScript 堆快照以排查内存问题',
    en: 'Export a JavaScript heap snapshot to diagnose memory issues',
  },
  'commands.__remote-workflow': {
    zh: '执行服务端会话提供的工作流脚本',
    en: 'Run the workflow script provided by a server-launched session',
  },
  'commands.workflow-launch-exec': {
    zh: '执行服务端启动的工作流交接',
    en: 'Execute a server-launched workflow handoff',
  },
  'commands.reload-skills': {
    zh: '重新扫描本机新增或修改的技能与命令',
    en: 'Rescan skills and commands added or changed on disk',
  },
  'commands.security-review': {
    zh: '检查当前分支待提交修改中的安全漏洞',
    en: 'Review pending changes on the current branch for security vulnerabilities',
  },
  'commands.team-onboarding': {
    zh: '根据使用经验生成队友上手 Claude Code 的指南',
    en: 'Create a Claude Code onboarding guide for teammates based on your usage',
  },
  'commands.help': { zh: '查看 Claude Code 帮助与命令说明', en: 'Show Claude Code help and command descriptions' },
  'commands.memory': {
    zh: '查看或编辑项目记忆与 CLAUDE.md 文件',
    en: 'View or edit project memory and CLAUDE.md files',
  },
  'commands.plan': { zh: '进入规划模式，可附加任务说明', en: 'Enter plan mode with an optional task description' },
  'commands.resume': {
    zh: '恢复指定会话或选择历史对话',
    en: 'Resume a specified session or select a past conversation',
  },
  'commands.continue': {
    zh: '恢复指定会话或选择历史对话',
    en: 'Resume a specified session or select a past conversation',
  },
  'commands.rewind': { zh: '将对话或代码回退到之前的状态', en: 'Rewind the conversation or code to an earlier state' },
  'commands.export': { zh: '导出当前对话', en: 'Export the current conversation' },
  'commands.add-dir': {
    zh: '为当前会话添加可访问的工作目录',
    en: 'Add an accessible working directory to the current session',
  },
  'commands.status': { zh: '查看版本、模型、账号与连接状态', en: 'Show version, model, account and connection status' },
  'commands.menuEmpty': { zh: '没有匹配的命令', en: 'No matching commands' },
} as const
