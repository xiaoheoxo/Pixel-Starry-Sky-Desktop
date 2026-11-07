import { AUTO_REVIEW_TEXT } from '@pixelsky/protocol'

export const codexMessages = {
  'session.live.ApprovalCard.allowAll': {
    zh: '本会话后续不再询问',
    en: 'Allow all for this session',
  },
  'session.live.ApprovalCard.allowAllHint': {
    zh: '允许当前操作，并将本会话切换为完全放行；可在输入框的权限菜单中改回',
    en: 'Allow this operation and enable full access for this session. Change it back in the composer permission menu.',
  },
  'codex.permission.ask': {
    zh: '不受信任的命令需要确认；项目写入受沙箱约束',
    en: 'Untrusted commands require approval; workspace writes are sandboxed',
  },
  'codex.permission.edits': {
    zh: '项目内自动操作；超出沙箱时按原生策略询问',
    en: 'Work automatically in the workspace; ask when sandbox escalation is needed',
  },
  'codex.permission.auto': {
    zh: '要审批的操作先由审查模型按风险判断，危险的才拦下；审查会花额度',
    en: 'A review model checks risky actions first and blocks dangerous ones. Reviews use your quota',
  },
  'codex.review.running': { zh: '正在审查', en: 'Reviewing' },
  'codex.review.approved': { zh: '审查放行', en: 'Approved by review' },
  'codex.review.risk.low': { zh: '低风险', en: 'Low risk' },
  'codex.review.risk.medium': { zh: '中风险', en: 'Medium risk' },
  'codex.review.risk.high': { zh: '高风险', en: 'High risk' },
  'codex.review.risk.critical': { zh: '极高风险', en: 'Critical risk' },
  'codex.review.blockedCount': { zh: '{n} 条被拦下', en: '{n} blocked' },
  'codex.review.notRun': { zh: '没有运行', en: 'Did not run' },
  'codex.review.denied': { zh: '已拦下', en: 'Blocked' },
  'codex.review.timedOut': { zh: '审查超时', en: 'Review timed out' },
  'codex.review.timedOutHint': {
    zh: '没判断出结果，不等于危险',
    en: 'No decision was reached, which does not mean it is dangerous',
  },
  'codex.review.override': { zh: '仍要执行', en: 'Run anyway' },
  'codex.review.overrideHint': {
    zh: '会带上你的同意再审一次，可能还是被拦下',
    en: 'It is reviewed again with your approval and may still be blocked',
  },
  'codex.review.overridden': { zh: '已同意，让模型重试', en: 'Approved. Asked the model to retry' },
  'codex.review.retryMessage': {
    zh: '我确认要执行被拦下的这一项：{action}。请只重试这一项。',
    en: 'I approve this blocked action: {action}. Please retry only this one.',
  },
  'codex.review.tooMany': {
    zh: AUTO_REVIEW_TEXT.tooMany,
    en: 'Auto-review blocked several actions in a row, so this turn stopped. Check what was blocked or rephrase, or switch to Ask every time in the composer permission menu.',
  },
  'codex.review.networkDenied': {
    zh: AUTO_REVIEW_TEXT.networkDenied,
    en: 'Auto-review blocked a network request.',
  },
  'codex.permission.plan': {
    zh: '只读，用 Codex 原生计划模式先出方案；需要你拿主意时会弹出问题',
    en: 'Read-only; uses Codex native plan mode to propose a plan and asks you when a decision is needed',
  },
  'codex.fastNoTier': {
    zh: '当前模型没有 Fast 档位，打开了也不会生效',
    en: 'This model has no Fast tier, so turning it on has no effect',
  },
  'codex.fastUnverified': {
    zh: '是否生效、怎么计费取决于你的接口或线路',
    en: 'Whether it takes effect and how it is billed depend on your endpoint or route',
  },
  'codex.ultrafastDropped': {
    zh: '当前模型或线路没有 Ultrafast，已改成 Fast',
    en: 'This model or route has no Ultrafast, so it was changed to Fast',
  },
  'speed.off': { zh: '普通', en: 'Normal' },
  'speed.ultrafastDesc': {
    zh: '最快的速度。订阅额度按 8 倍扣，credits 按 6 倍',
    en: 'The fastest speed. Subscription limits count 8x, credits 6x',
  },
  'speed.holdHint': {
    zh: '点一下开关 Fast（2.5 倍），按住开 Ultrafast（8 倍）',
    en: 'Click for Fast (2.5x), press and hold for Ultrafast (8x)',
  },
  'speed.holding': {
    zh: '继续按住开启：订阅额度按 8 倍扣',
    en: 'Keep holding to turn on. Subscription limits count 8x',
  },
  'speed.tooShort': {
    zh: '要按满 0.6 秒才开启，这样不会误点。订阅额度按 8 倍扣',
    en: "Hold for 0.6 seconds to turn it on, so it can't happen by accident. Subscription limits count 8x",
  },
  'speed.holdLabel': { zh: 'Fast 模式，按住开 Ultrafast', en: 'Fast mode, press and hold for Ultrafast' },
  'speed.next': {
    zh: '这一轮按原来的速度跑完，下一轮起改成 {p0}',
    en: 'This turn finishes at its current speed; {p0} from the next turn',
  },
  'speed.sessionOnly': { zh: 'Ultrafast 只对这个会话生效', en: 'Ultrafast applies to this session only' },
  'codex.fastPending': { zh: '下一轮生效', en: 'Next turn' },
  'codex.fastNextOn': {
    zh: '这一轮按普通速度跑完，下一轮起打开',
    en: 'This turn finishes at normal speed; on from the next turn',
  },
  'codex.fastNextOff': {
    zh: '这一轮还按 Fast 跑完，下一轮起关闭',
    en: 'This turn finishes in Fast; off from the next turn',
  },
  'codex.targets': { zh: '适用引擎', en: 'Applies to' },
  'codex.extensionInfo': {
    zh: 'Codex 和 Pixel 支持独立 Skills、stdio / HTTP MCP 与命令行；Claude 插件保持专属',
    en: 'Codex and Pixel support standalone skills, stdio / HTTP MCP and CLI tools; Claude plugins remain engine-specific',
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
  'codex.noRoutes': {
    zh: '没有可用的 Codex Responses 平台线路，请公开兼容的 OpenAI 分组或主动选择自有',
    en: 'No Codex Responses route is available. Publish a compatible OpenAI group or choose your own account.',
  },
  'codex.authMissing': {
    zh: 'Codex 未登录，请在本机运行 codex login 后重新检测',
    en: 'Codex is not signed in. Run codex login locally, then check again.',
  },
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
  'codex.routingTimeout': {
    zh: '连接 ChatGPT 超时，检查网络或代理后重试',
    en: 'Timed out connecting to ChatGPT. Check your network or proxy and try again',
  },
  'codex.imageUnsupported': { zh: '此 Codex 模型不支持图片', en: 'This Codex model does not support images' },
  'codex.effortUnsupported': {
    zh: '此 Codex 模型不支持当前强度',
    en: 'This Codex model does not support the selected effort',
  },
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
