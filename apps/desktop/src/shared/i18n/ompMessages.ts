// oh-my-pi（omp，用户自己装的引擎）的界面文案，docs/omp-engine.md
export const ompMessages = {
  'engine.omp.intro': {
    zh: '开源的编码智能体 oh-my-pi（omp，基于 Pi，MIT 协议），用它的官方安装器安装。可以用它自己登录的账号和 Key，也可以用平台余额。',
    en: 'The open-source coding agent oh-my-pi (omp, built on Pi, MIT license), installed with its official installer. Use its own sign-ins and keys, or your platform balance.',
  },
  'engine.omp.useSettings': {
    zh: '使用 omp 自己设置的默认模型',
    en: 'Use the default model from omp settings',
  },
  'modelChannels.executor.desc.omp': {
    zh: '开源的 oh-my-pi，要另外安装；工具多，带 LSP、调试器',
    en: 'Open-source oh-my-pi, installed separately. Lots of tools, including LSP and a debugger',
  },
  'fullAccess.confirm.omp': {
    zh: 'oh-my-pi 会跳过所有权限检查',
    en: 'oh-my-pi skips every permission check',
  },
  // 引擎（packages/engine/src/omp、pixel/session.ts 的 omp 分支）发的中文原文，英文界面按这里翻
  'engine.omp.notFoundWin': {
    zh: '没找到 oh-my-pi（omp）。安装：在 PowerShell 运行 irm https://omp.sh/install.ps1 | iex',
    en: 'oh-my-pi (omp) not found. Install it in PowerShell: irm https://omp.sh/install.ps1 | iex',
  },
  'engine.omp.notFoundUnix': {
    zh: '没找到 oh-my-pi（omp）。安装：在终端运行 curl -fsSL https://omp.sh/install | sh',
    en: 'oh-my-pi (omp) not found. Install it in a terminal: curl -fsSL https://omp.sh/install | sh',
  },
  'engine.omp.tooOld': {
    zh: 'oh-my-pi {p0} 版本太低（需要 {p1} 以上）：点更新按钮，或在终端运行 omp update',
    en: 'oh-my-pi {p0} is too old (requires {p1} or later). Use the update button, or run omp update in a terminal.',
  },
  'engine.omp.notFound': { zh: '没找到 oh-my-pi', en: 'oh-my-pi not found' },
  'engine.omp.updateCustom': {
    zh: '自定义的命令不叫 omp，没法在软件里更新',
    en: 'The custom command is not named omp, so it cannot be updated in the app',
  },
  'engine.omp.noInstaller': {
    zh: '没找到 PowerShell / curl，请按提示在终端安装 oh-my-pi',
    en: 'PowerShell / curl not found. Install oh-my-pi from a terminal as shown',
  },
  'engine.omp.noVersion': { zh: '读不出 oh-my-pi 的版本', en: 'Could not read the oh-my-pi version' },
  'engine.omp.cannotStart': { zh: 'oh-my-pi 启动不了', en: 'oh-my-pi could not start' },
  'engine.omp.unavailable': { zh: 'oh-my-pi 不可用', en: 'oh-my-pi is unavailable' },
  'engine.omp.failed': { zh: 'oh-my-pi 出错了', en: 'oh-my-pi ran into an error' },
  'engine.omp.noModel': {
    zh: 'oh-my-pi 还没有能用的模型：在终端里运行 omp，用 /login 登录或设置 API Key；也可以在模型菜单里改用平台线路',
    en: 'oh-my-pi has no usable model yet. Run omp in a terminal and sign in with /login or set an API key, or switch to a platform route in the model menu.',
  },
  'engine.omp.fastStuck': {
    zh: 'oh-my-pi 的 Fast 档关不掉，为免按 Fast 加价扣费，这条消息没有发出',
    en: 'oh-my-pi could not turn off its Fast tier, so this message was not sent to avoid Fast-rate charges',
  },
  'engine.omp.notice.promptStall': {
    zh: 'oh-my-pi {p0} 秒没有开始处理这条消息，已让它停下',
    en: 'oh-my-pi did not start on this message within {p0} seconds, so it was stopped',
  },
  'engine.omp.notice.resumeCarried': {
    zh: '没能接上原来的 oh-my-pi 会话，已改开新会话；下一条消息会把之前的聊天一起带过去',
    en: 'Could not resume the previous oh-my-pi session, so a new one was started. The earlier chat will be sent along with your next message.',
  },
  'engine.omp.notice.resumeLost': {
    zh: '没能接上原来的 oh-my-pi 会话，已改开新会话（之前的上下文没有带过去）',
    en: 'Could not resume the previous oh-my-pi session, so a new one was started (the earlier context was not carried over).',
  },
  'engine.omp.export.fresh': {
    zh: '先发一条消息，再用 oh-my-pi 导出',
    en: 'Send a message first, then export with oh-my-pi',
  },
  'engine.omp.export.rewound': {
    zh: '回退之后先发一条消息，再用 oh-my-pi 导出',
    en: 'After rewinding, send a message before exporting with oh-my-pi',
  },
  'engine.omp.export.failed': { zh: 'oh-my-pi 没有导出成功', en: 'oh-my-pi could not export the session' },
  // omp 自己报的英文
  'engine.omp.compact.small': {
    zh: '对话还太短，没有可以压缩的内容',
    en: 'Nothing to compact (session too small)',
  },
  'engine.omp.compact.badHandoff': {
    zh: '模型写的交接文档不合格式，没有采用；可以再试一次',
    en: 'Handoff generation produced an invalid document',
  },
  'engine.omp.notice.sessionMoved': {
    zh: '这个会话的文件被别的程序占用或改过（比如终端里的 omp），之后的内容存到新的会话文件，对话照常继续',
    en: 'Another program (such as omp in a terminal) is using or has changed this session file. New messages are saved to a new session file and the chat continues as usual.',
  },
  'engine.omp.side.badFile': {
    zh: '认不出这个对话的会话文件，旁聊没有发出',
    en: 'Could not read the session file of this chat, so the side question was not sent',
  },
  'engine.stoppedWithMain': {
    zh: '已停止，连同 {p0} 个后台子智能体（{p1}）',
    en: 'Stopped, along with {p0} background subagents ({p1})',
  },
  'engine.omp.agentNotStopped': {
    zh: '这个子智能体没有停下来',
    en: 'This subagent could not be stopped',
  },
  'engine.omp.agentNoTranscript': {
    zh: '这个子智能体还没有对话记录',
    en: 'This subagent has no transcript yet',
  },
  'engine.omp.isolateFailed': {
    zh: 'oh-my-pi 的隔离设置没有写出来',
    en: 'Could not write the oh-my-pi isolation settings',
  },
  'engine.omp.tuiFresh': {
    zh: 'oh-my-pi 要先在界面里发一条消息，才能切到终端',
    en: 'Send a message in this oh-my-pi chat before switching to the terminal',
  },
  'engine.omp.ultracodeDesc': {
    zh: '让 oh-my-pi 把任务拆开交给并行子智能体（最多 8 个同时跑），消耗明显增加；会话里切换在下一轮生效',
    en: 'oh-my-pi splits work across parallel subagents (up to 8 at once), using noticeably more. Changes in a session apply from the next turn.',
  },
  'engine.omp.thinkingDesc': {
    zh: '让模型返回思考摘要（关掉不省额度）；会话里切换在下一轮生效',
    en: 'Ask the model for thinking summaries (turning this off does not save usage). Changes in a session apply from the next turn.',
  },
  'engine.omp.notice.noTask': {
    zh: 'oh-my-pi 没有 task 工具（启动参数关掉了），Ultracode 已关闭',
    en: 'oh-my-pi has no task tool (disabled by launch arguments), so Ultracode was turned off',
  },
  'engine.omp.notice.fastOff': {
    zh: 'oh-my-pi 的这个模型不支持 Fast，已关闭',
    en: 'This oh-my-pi model does not support Fast, so it was turned off',
  },
  'speed.ompCost': {
    zh: '让 oh-my-pi 按 Fast 档请求，更快但按 Fast 加价计费；它派的子智能体也按 Fast 计费',
    en: 'oh-my-pi requests the Fast tier: faster, but billed at Fast rates. Subagents it starts are billed at Fast rates too.',
  },
  'speed.ompUnavailable': {
    zh: 'oh-my-pi 的这个模型没有 Fast 档（平台线路只有 gpt 系模型能开）',
    en: 'This oh-my-pi model has no Fast tier (on platform routes only gpt models support it)',
  },
  // 旁聊（omp/btw.ts、omp/side.ts）
  'engine.omp.side.exited': {
    zh: 'oh-my-pi 进程退出了，旁聊没有答完',
    en: 'The oh-my-pi process exited before the side chat finished',
  },
  'engine.omp.side.restarted': {
    zh: 'oh-my-pi 换了进程（权限档、设置变了），旁聊被打断，请再问一次',
    en: 'oh-my-pi restarted (permission or settings changed), interrupting the side chat. Please ask again.',
  },
  // 上下文明细（omp/context.ts）
  'engine.omp.noContext': { zh: 'oh-my-pi 没有给出上下文明细', en: 'oh-my-pi did not report context details' },
  'session.contextData.systemContext': { zh: '系统上下文', en: 'System context' },
  'session.contextData.instructionFiles': { zh: '指令文件', en: 'Instruction files' },
  'session.ContextWindowButton.ompRefresh': {
    zh: '由 oh-my-pi 在本机估算，不请求模型',
    en: 'Estimated locally by oh-my-pi without calling the model',
  },
  'session.ContextWindowButton.ompEstimateNote': {
    zh: '分类由 oh-my-pi 在本机估算，不请求模型；合计可能和占用略有出入。',
    en: 'oh-my-pi estimates the categories locally without calling the model; the total may differ slightly from usage.',
  },
  'engine.omp.sessionsDir': { zh: 'oh-my-pi 没有给出会话目录', en: 'oh-my-pi did not report its sessions folder' },
  'engine.omp.unknownFile': {
    zh: '认不出这个对话的会话文件',
    en: 'This conversation’s session file is not recognized',
  },
  'engine.omp.switchCancelled': { zh: '切换会话被取消了', en: 'Switching sessions was cancelled' },
  'engine.omp.navigateCancelled': { zh: '移动位置被取消了', en: 'Moving to that point was cancelled' },
  'engine.omp.noResponse': { zh: 'oh-my-pi {p0} 秒没有回应', en: 'oh-my-pi did not respond for {p0} seconds' },
  'engine.omp.exited': { zh: 'oh-my-pi 进程退出了', en: 'The oh-my-pi process exited' },
  'engine.omp.side.noAnswer': { zh: 'oh-my-pi 没有回答', en: 'oh-my-pi did not answer' },
  'engine.omp.side.failed': { zh: 'oh-my-pi 旁聊出错了', en: 'oh-my-pi side chat failed' },
  'engine.omp.side.notRunning': { zh: 'oh-my-pi 没有在运行', en: 'oh-my-pi is not running' },
  'engine.omp.side.procExited': { zh: 'oh-my-pi 旁聊进程退出了', en: 'The oh-my-pi side chat process exited' },
} as const
