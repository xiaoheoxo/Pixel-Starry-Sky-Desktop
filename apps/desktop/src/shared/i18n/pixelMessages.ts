// 像素星空引擎（自带命令行智能体，基于 Pi）的界面文案，docs/own-cli.md
export const pixelMessages = {
  'engine.pixel.name': { zh: '像素星空', en: 'Pixel Starry Sky' },
  'engine.pixel.intro': {
    zh: '像素星空自带的编码智能体，基于开源的 Pi（MIT 协议）。需要你自己的 API Key，或使用平台余额。',
    en: "Pixel Starry Sky's built-in coding agent, built on the open-source Pi (MIT license). Needs your own API key, or your platform balance.",
  },
  'engine.pixel.useSettings': {
    zh: '使用像素星空命令行的默认模型',
    en: 'Use the Pixel Starry Sky CLI default model',
  },
  // 防空转（packages/cli/src/extensions/loopGuard.ts stopNotice）：引擎发英文原文，这里按模板翻译
  'engine.pixel.loopGuard.repeat': {
    zh: '这一轮已停下：智能体连着 {p1} 次用同样的参数调用「{p0}」，结果都一样。发一条消息可以接着做。',
    en: 'Stopped this run: the agent repeated the same "{p0}" call {p1} times in a row with the same result. Send a message to continue.',
  },
  'engine.pixel.loopGuard.failed': {
    zh: '这一轮已停下：连着 {p0} 步工具调用全部失败。发一条消息可以接着做。',
    en: 'Stopped this run: every tool call failed for {p0} steps in a row. Send a message to continue.',
  },
  // 引擎（packages/engine/src/pixel）里的中文报错和提示：引擎发中文原文，英文界面按这里翻译（docs/own-cli.md §15）
  'engine.pixel.error.bundledMissing': {
    zh: '没有找到像素星空自带的命令行（{p0}），安装可能不完整：请重新安装像素星空',
    en: 'Could not find the Pixel Starry Sky CLI that ships with the app ({p0}). The installation may be incomplete: please reinstall Pixel Starry Sky.',
  },
  'engine.pixel.error.cliMissing': {
    zh: '没有找到像素星空命令行：设置环境变量 PIXELSKY_CLI_BIN 指向命令行入口，或把 pixelsky 装到 PATH 上',
    en: 'Could not find the Pixel Starry Sky CLI. Set the PIXELSKY_CLI_BIN environment variable to the CLI entry point, or put pixelsky on your PATH.',
  },
  'engine.pixel.error.startReasonReinstall': {
    zh: '像素星空命令行启动不了：{p0}。请重新安装像素星空',
    en: 'The Pixel Starry Sky CLI failed to start: {p0}. Please reinstall Pixel Starry Sky.',
  },
  'engine.pixel.error.startReason': {
    zh: '像素星空命令行启动不了：{p0}',
    en: 'The Pixel Starry Sky CLI failed to start: {p0}',
  },
  'engine.pixel.error.startReinstall': {
    zh: '像素星空命令行启动不了。请重新安装像素星空',
    en: 'The Pixel Starry Sky CLI failed to start. Please reinstall Pixel Starry Sky.',
  },
  'engine.pixel.error.start': {
    zh: '像素星空命令行启动不了',
    en: 'The Pixel Starry Sky CLI failed to start',
  },
  'engine.pixel.shell.wslOnly': {
    zh: '没有找到 Git Bash，只找到了 WSL 的 bash（{p0}）：命令会在 Linux 子系统里运行，Windows 的路径和工具用不了。请安装 Git for Windows（https://git-scm.com/download/win），装好后点「重新检测」；已经装了的话，在 ~/.pixelsky-cli/agent/settings.json 里用 "shellPath" 写上 bash.exe 的完整路径',
    en: 'Git Bash was not found, only the WSL bash ({p0}): commands would run inside the Linux subsystem, where Windows paths and tools are unavailable. Install Git for Windows (https://git-scm.com/download/win), then click "Detect again". If it is already installed, set "shellPath" in ~/.pixelsky-cli/agent/settings.json to the full path of bash.exe.',
  },
  'engine.pixel.shell.missing': {
    zh: '没有找到 Git Bash：像素星空在 Windows 上用它运行命令，现在运行命令会失败。请安装 Git for Windows（https://git-scm.com/download/win），装好后点「重新检测」；已经装了的话，在 ~/.pixelsky-cli/agent/settings.json 里用 "shellPath" 写上 bash.exe 的完整路径',
    en: 'Git Bash was not found. Pixel Starry Sky uses it to run commands on Windows, so running commands will fail. Install Git for Windows (https://git-scm.com/download/win), then click "Detect again". If it is already installed, set "shellPath" in ~/.pixelsky-cli/agent/settings.json to the full path of bash.exe.',
  },
  'engine.pixel.error.processExited': {
    zh: '引擎进程已退出',
    en: 'The engine process has exited',
  },
  'engine.pixel.error.responseTimeout': {
    zh: '等命令行回应超时',
    en: 'Timed out waiting for the CLI to respond',
  },
  'engine.pixel.notice.promptStall': {
    zh: '像素星空 {p0} 秒没有开始处理这条消息，已让它停下',
    en: 'Pixel Starry Sky did not start on this message within {p0} seconds, so it was stopped',
  },
  'engine.pixel.notice.resumeCarried': {
    zh: '没能接上原来的像素星空会话，已改开新会话；下一条消息会把之前的聊天一起带过去',
    en: 'Could not resume the previous Pixel Starry Sky session, so a new one was started. The earlier chat will be sent along with your next message.',
  },
  'engine.pixel.notice.resumeLost': {
    zh: '没能接上原来的像素星空会话，已改开新会话（之前的上下文没有带过去）',
    en: 'Could not resume the previous Pixel Starry Sky session, so a new one was started (the earlier context was not carried over).',
  },
  'engine.pixel.side.noAnswer': {
    zh: '像素星空没有回答',
    en: 'Pixel Starry Sky did not answer',
  },
  'engine.pixel.side.noSessionFile': {
    zh: '找不到这个对话的会话文件，先在主对话里发一条消息',
    en: 'Could not find the session file for this conversation. Send a message in the main conversation first.',
  },
  'engine.pixel.side.copyFailed': {
    zh: '复制会话文件失败：{p0}',
    en: 'Could not copy the session file: {p0}',
  },
} as const
