export const codexMessages = {
  'session.live.ApprovalCard.allowAll': {
    zh: '本会话后续不再询问',
    en: 'Allow all for this session',
  },
  'session.live.ApprovalCard.allowAllHint': {
    zh: '允许当前操作，并将本会话切换为完全放行；可在输入框的权限菜单中改回',
    en: 'Allow this operation and enable full access for this session. Change it back in the composer permission menu.',
  },
  'codex.nextTurn': {
    zh: '模型、强度和权限修改从下一轮生效',
    en: 'Model, effort and permission changes apply next turn',
  },
  'codex.permission.ask': {
    zh: '不受信任的命令需要确认；项目写入受沙箱约束',
    en: 'Untrusted commands require approval; workspace writes are sandboxed',
  },
  'codex.permission.edits': {
    zh: '项目内自动操作；超出沙箱时按原生策略询问',
    en: 'Work automatically in the workspace; ask when sandbox escalation is needed',
  },
  'codex.permission.plan': {
    zh: '只读，用 Codex 原生计划模式先出方案；需要你拿主意时会弹出问题',
    en: 'Read-only; uses Codex native plan mode to propose a plan and asks you when a decision is needed',
  },
  'codex.fastGateway': {
    zh: '接口支持 Fast 时生效，不支持的打开了也没有效果',
    en: 'Takes effect if the endpoint supports Fast; otherwise turning it on has no effect',
  },
  'codex.fastUnverified': {
    zh: '你的接口或当前模型可能不支持 Fast，打开了可能不生效',
    en: 'Your endpoint or the current model may not support Fast; turning it on may have no effect',
  },
  'codex.targets': { zh: '适用引擎', en: 'Applies to' },
  'codex.extensionInfo': {
    zh: 'Codex 和像素星空支持独立 Skills、stdio / HTTP MCP 与命令行；Claude 插件保持专属',
    en: 'Codex and Pixel Starry Sky support standalone skills, stdio / HTTP MCP and CLI tools; Claude plugins remain engine-specific',
  },
  'codex.nativeSettings': {
    zh: '使用本机 Codex 登录及 provider 配置；输出风格和提问开关由原生配置管理。',
    en: 'Use your local Codex sign-in and provider configuration. Output styles and question controls are managed by native config.',
  },
  'engineConfigWarnings.title': { zh: '配置提示', en: 'Config warnings' },
  'engineConfigWarnings.note': {
    zh: '{p0} 读取本机配置时报的提示，不影响使用，也不会显示在对话里。改好配置后点「重新检测」清掉；下一轮还有的话会再出现',
    en: '{p0} reported these while reading your local config. They don’t affect use and aren’t shown in conversations. After fixing the config, click Detect again to clear them; they come back next turn if still present',
  },
  'engineConfigWarnings.badge': { zh: '{p0} 条配置提示', en: '{p0} config warnings' },
  'codex.mcpInput': { zh: '填写 MCP 请求的数据（JSON）', en: 'Enter the data requested by MCP (JSON)' },
  'codex.mcpInputInvalid': { zh: '请输入有效的 JSON 对象', en: 'Enter a valid JSON object' },
  'codex.noRoutes': {
    zh: '没有可用的 Codex Responses 平台线路，请公开兼容的 OpenAI 分组或主动选择自有',
    en: 'No Codex Responses route is available. Publish a compatible OpenAI group or choose your own account.',
  },
  'codex.defaultEffort': {
    zh: '该模型不支持原强度，已切换到模型默认强度',
    en: 'The model does not support the previous effort; switched to its default',
  },
  'codex.nativeSkill': { zh: 'Codex 技能使用 $名称 调用', en: 'Invoke Codex skills with $name' },
  'codex.authMissing': {
    zh: 'Codex 未登录，请在本机运行 codex login 后重新检测',
    en: 'Codex is not signed in. Run codex login locally, then check again.',
  },
  'codex.compacted': { zh: 'Codex 上下文压缩完成', en: 'Codex context compaction completed' },
  'codex.compacting': { zh: 'Codex 正在压缩上下文', en: 'Codex is compacting context' },
  'codex.commandApproval': { zh: 'Codex 命令审批', en: 'Codex command approval' },
  'codex.fileApproval': { zh: 'Codex 文件修改', en: 'Codex file changes' },
  'codex.networkApproval': { zh: 'Codex 网络访问', en: 'Codex network access' },
  'codex.permissionApproval': { zh: 'Codex 权限申请', en: 'Codex permission request' },
  'codex.question': { zh: 'Codex 提问', en: 'Codex question' },
  'codex.mcpApproval': { zh: 'MCP 输入请求', en: 'MCP input request' },
  'codex.subagentCommandApproval': {
    zh: 'Codex 子智能体 {agent} 命令审批',
    en: 'Codex subagent {agent} command approval',
  },
  'codex.subagentFileApproval': { zh: 'Codex 子智能体 {agent} 文件修改', en: 'Codex subagent {agent} file changes' },
  'codex.subagentNetworkApproval': {
    zh: 'Codex 子智能体 {agent} 网络访问',
    en: 'Codex subagent {agent} network access',
  },
  'codex.subagentPermissionApproval': {
    zh: 'Codex 子智能体 {agent} 权限申请',
    en: 'Codex subagent {agent} permission request',
  },
  'codex.subagentQuestion': { zh: 'Codex 子智能体 {agent} 提问', en: 'Codex subagent {agent} question' },
  'codex.subagentMcpApproval': { zh: 'MCP 输入请求（子智能体 {agent}）', en: 'MCP input request (subagent {agent})' },
  'codex.processExit': { zh: 'Codex 进程已退出', en: 'Codex process exited' },
  'codex.imageUnsupported': { zh: '此 Codex 模型不支持图片', en: 'This Codex model does not support images' },
  'codex.effortUnsupported': {
    zh: '此 Codex 模型不支持当前强度',
    en: 'This Codex model does not support the selected effort',
  },
  'codex.gatewayUnavailable': { zh: 'Codex 平台代理不可用，请重启应用', en: 'Codex platform gateway is unavailable' },
  'codex.protocolRoute': {
    zh: '线路协议与当前引擎不兼容',
    en: 'The route protocol is incompatible with the selected engine',
  },
  'codex.modelMismatch': {
    zh: '请求模型与当前平台会话不一致',
    en: 'The requested model does not match the platform session',
  },
  'codex.couldNotResumeThread': {
    zh: '无法恢复 Codex 会话，已开始新会话（之前的上下文没有带过去）',
    en: 'Could not resume the Codex thread; started a new thread (previous context was not carried over)',
  },
  'codex.couldNotSeedThread': {
    zh: '没能把之前的对话注入 Codex 会话，这一轮改用文字交接',
    en: 'Could not add the previous conversation to the Codex thread; sent it as a text handoff instead',
  },
  'codex.imagesNotPassed': {
    zh: '当前模型不能看图，之前的 {p0} 张图片实际没有带上',
    en: "The current model can't view images, so {p0} earlier image(s) were not actually passed along",
  },
  'codex.couldNotReadVersion': { zh: '无法读取 Codex 版本号', en: 'Could not read the Codex version' },
  'codex.couldNotRewindThread': {
    zh: '无法回退 Codex 会话到这条消息，已开始新会话（之前的上下文没有带过去）',
    en: 'Could not rewind the Codex thread to this message; started a new thread (previous context was not carried over)',
  },
  'codex.couldNotForkThread': {
    zh: '无法分叉 Codex 会话，已开始新会话（之前的上下文没有带过去）',
    en: 'Could not fork the Codex thread; started a new thread (previous context was not carried over)',
  },
  'codex.codexIsTooOld': {
    zh: 'Codex 版本太低（需要 0.160.0 或以上）：在终端运行 npm i -g @openai/codex@latest',
    en: 'Codex is too old (requires 0.160.0 or later). Run npm i -g @openai/codex@latest',
  },
  // Codex 换了模型（session.ts codexRerouteNotice）：带原因的在前，免得被不带原因的模板先匹配
  'codex.modelReroutedCyber': {
    zh: 'Codex 把模型从 {p0} 换成了 {p1}：请求被判定为高风险网络安全活动',
    en: 'Codex switched the model from {p0} to {p1}: the request was flagged as high-risk cybersecurity activity',
  },
  'codex.modelRerouted': { zh: 'Codex 把模型从 {p0} 换成了 {p1}', en: 'Codex switched the model from {p0} to {p1}' },
  // Codex 重连状态条的原因（session.ts codexRetryState）
  'codex.retryConnectionLost': { zh: '连接断开', en: 'Connection lost' },
  'codex.retryWaitingForNetwork': { zh: '等待网络恢复', en: 'waiting for network' },
} as const
