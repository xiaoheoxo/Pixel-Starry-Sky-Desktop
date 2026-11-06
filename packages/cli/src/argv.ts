// 入口参数拦截：关掉 Pi 里不要的子命令，并把项目信任默认设为「不信任」。
// 只用可擦除的 TS 语法。

export type ArgvResult = { action: 'run'; args: string[] } | { action: 'blocked'; message: string; exitCode: number }

/** 包管理 / 自更新子命令：Pi 在 main() 里按 args[0] 分发，必须在交给 Pi 之前拦下。 */
const BLOCKED_SUBCOMMANDS: Record<string, readonly [string, string]> = {
  install: ['安装扩展', 'Installing extensions'],
  remove: ['卸载扩展', 'Removing extensions'],
  uninstall: ['卸载扩展', 'Removing extensions'],
  update: ['更新（含自更新）', 'Updating'],
}

/** 单独出现时才当作子命令的词（否则可能是普通提问，如 `pixelsky login page bug`）。 */
const BLOCKED_WHEN_ALONE: Record<string, readonly [string, string]> = {
  login: ['订阅账号登录', 'Subscription login'],
  logout: ['订阅账号登出', 'Subscription logout'],
  share: ['分享会话', 'Sharing sessions'],
  changelog: ['查看更新日志', 'Changelog'],
}

/** 会走包管理器的资源来源前缀（-e npm:xxx 等会触发下载安装） */
const REMOTE_SOURCE = /^(npm:|git:|github:|https?:|ssh:)/
/** 后面跟资源来源的选项 */
const SOURCE_OPTIONS = new Set(['-e', '--extension', '--skill', '--prompt-template', '--theme'])
/** 不走项目信任流程的子命令（不要往后面追加参数） */
const TRUST_FREE_SUBCOMMANDS = new Set(['config', 'list', 'auth', 'mcp'])
const TRUST_FLAGS = new Set(['--approve', '-a', '--no-approve', '-na'])

function unavailable([zh, en]: readonly [string, string]): ArgvResult {
  return {
    action: 'blocked',
    exitCode: 1,
    message:
      `${zh}在 Pixel 命令行中不可用（更新随桌面端进行；扩展、技能请放进用户目录 ~/.pixelsky-cli/agent/；账号请用环境变量或 auth.json 里的 API 密钥）。\n` +
      `${en} is not available in the Pixel CLI (updates ship with the desktop app; put extensions/skills under ~/.pixelsky-cli/agent/; use API keys via environment variables or auth.json).`,
  }
}

/**
 * 处理命令行参数。
 * - 被关闭的子命令：返回 blocked（调用方打印 message 并以非零退出）
 * - 来自 npm / git / 网址的 -e / --skill 等来源：同样拦截
 * - 没有显式传 --approve / --no-approve 时追加 --no-approve：项目目录里的设置、扩展、技能、提示词、主题、
 *   mcp.json 一律不加载（只用用户级）；用户明确传了 -a 则以用户为准
 */
export function interceptArgv(args: readonly string[]): ArgvResult {
  const first = args[0]
  if (first !== undefined) {
    if (Object.hasOwn(BLOCKED_SUBCOMMANDS, first)) return unavailable(BLOCKED_SUBCOMMANDS[first])
    if (args.length === 1 && Object.hasOwn(BLOCKED_WHEN_ALONE, first)) return unavailable(BLOCKED_WHEN_ALONE[first])
  }

  const dashDash = args.indexOf('--')
  const optionArgs = dashDash === -1 ? args : args.slice(0, dashDash)
  for (let i = 0; i < optionArgs.length - 1; i++) {
    if (SOURCE_OPTIONS.has(optionArgs[i]) && REMOTE_SOURCE.test(optionArgs[i + 1].trim())) {
      return unavailable(['从 npm / git / 网址加载扩展与资源', 'Loading extensions from npm, git or URLs'])
    }
  }

  if (first !== undefined && TRUST_FREE_SUBCOMMANDS.has(first)) return { action: 'run', args: [...args] }
  if (optionArgs.some(a => TRUST_FLAGS.has(a))) return { action: 'run', args: [...args] }
  // 追加在 `--` 之前，避免被当成消息
  return { action: 'run', args: [...optionArgs, '--no-approve', ...args.slice(optionArgs.length)] }
}
