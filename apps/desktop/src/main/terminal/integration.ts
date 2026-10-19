// 终端 shell 集成：给我们开的 shell 注入「提示符标记」（OSC 633 的 D 命令结束 + A 提示符开始，参照 VS Code），
// 解析在 shellMarks.ts。目的是不靠 shell 退出就知道一条命令跑完了（任务面板里 Ctrl+C 会让 `; exit N` 后缀整行作废）。
// 只管内置的 PowerShell / cmd / bash / zsh；自定义 Shell、fish、sh 不注入，行为和以前一样。
// 注入失败也不会影响 shell：没有标记，上层就退回到「看 shell 有没有退出」。
import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { TerminalProfile } from '../../shared/types/terminal'

export type IntegrationKind = 'powershell' | 'cmd' | 'bash' | 'zsh'

export interface ShellIntegration {
  kind: IntegrationKind
  /** 代替 profile.args 的启动参数 */
  args: string[]
  /** 要加进环境变量的（同名的覆盖，Windows 上不分大小写） */
  env: Record<string, string>
  /** shell 会报告上一条命令的退出码（D 标记）；cmd 拿不到，只报提示符开始 */
  exitCodes: boolean
}

const program = (command: string): string =>
  (command.replaceAll('\\', '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '')

/** 这个终端程序该用哪种注入；自定义 Shell 一律不注入（参数是用户自己定的） */
export function integrationKind(profile: Pick<TerminalProfile, 'command' | 'custom'>): IntegrationKind | null {
  if (profile.custom) return null
  const name = program(profile.command)
  if (name === 'pwsh' || name === 'powershell') return 'powershell'
  if (name === 'cmd') return 'cmd'
  if (name === 'bash') return 'bash'
  if (name === 'zsh') return 'zsh'
  return null
}

/**
 * PowerShell：在用户 profile 加载完之后（-NoExit -EncodedCommand）把 prompt 包一层。
 * 用命令文本而不是 .ps1 文件：Windows PowerShell 默认执行策略（Restricted）不让跑脚本文件。
 * - 先存 $?（后面任何语句都会改它），再关掉严格模式（用户可能全局开着，读没定义的 $LASTEXITCODE 会报错）
 * - 只有 Get-History 的编号变了（真执行过命令）才发 D：第一个提示符、清屏重画、空行回车都不算
 * - 退出码：命令被中止（Ctrl+C，历史记录的 ExecutionStatus 是 Stopped）记 130；否则 $? 为真是 0；否则取非 0 的 $LASTEXITCODE，没有就 1（和任务后缀的判断一致）。
 *   cmdlet 出错时 $LASTEXITCODE 还是以前某条原生命令的旧值，所以 $Error 里多出新错误就记 1
 * - 标记用 [Console]::Write 直接写，不进 prompt 的返回值，所以用户的提示符、返回值原样不动；
 *   $? 失败时补一个 Write-Error -ErrorAction Ignore 把它还原成假，$LASTEXITCODE 没碰过
 * - 任何一步出错都吞掉，prompt 照常调用原来的
 */
export const POWERSHELL_SCRIPT = `try {
  if (-not (Get-Variable -Name __PixelskyPrompt -Scope Global -ErrorAction SilentlyContinue)) {
    $global:__PixelskyPrompt = $function:prompt
    $global:__PixelskyLastId = $null
    $global:__PixelskyError = $null
    function global:prompt {
      $ok = $?
      try {
        Set-StrictMode -Off
        $code = $global:LASTEXITCODE
        $id = 0
        $last = Get-History -Count 1
        if ($last) { $id = $last.Id }
        $err = $null
        if ($Error.Count -gt 0) { $err = $Error[0] }
        $newError = -not [object]::ReferenceEquals($err, $global:__PixelskyError)
        $global:__PixelskyError = $err
        $esc = [string][char]27
        $bel = [string][char]7
        $text = ''
        if ($null -ne $global:__PixelskyLastId -and $id -ne $global:__PixelskyLastId) {
          $exit = 0
          if ($last.ExecutionStatus -eq 'Stopped') { $exit = 130 }
          elseif (-not $ok) { $exit = 1; if (-not $newError -and $code -is [int] -and $code -ne 0) { $exit = $code } }
          $text = $esc + ']633;D;' + $exit + $bel
        }
        $global:__PixelskyLastId = $id
        [Console]::Write($text + $esc + ']633;A' + $bel)
      } catch {}
      if (-not $ok) { Write-Error 'failure' -ErrorAction Ignore }
      & $global:__PixelskyPrompt
    }
  }
} catch {}
`

/**
 * bash：--init-file 先照 -l 的顺序读用户的启动文件，再把钩子放进 PROMPT_COMMAND 最前面。
 * --init-file 不能和 --login 一起用，所以登录 shell 由这里模仿（/etc/profile，再第一个存在的 ~/.bash_profile、~/.bash_login、~/.profile），
 * 参数里的 -l / --login 由 shellIntegration 去掉并设 PIXELSKY_SHELL_LOGIN。
 * 钩子开头保存 $? 并在最后原样返回，用户自己的 PROMPT_COMMAND 看到的退出码不变。
 */
export const BASH_SCRIPT = `# 像素星空终端集成（自动生成，每次启动会覆盖，不要手改）
if [ -n "$PIXELSKY_SHELL_LOGIN" ]; then
  [ -r /etc/profile ] && . /etc/profile
  for __pixelsky_rc in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [ -r "$__pixelsky_rc" ]; then . "$__pixelsky_rc"; break; fi
  done
else
  [ -r ~/.bashrc ] && . ~/.bashrc
fi
unset __pixelsky_rc PIXELSKY_SHELL_LOGIN
__pixelsky_precmd() {
  local ec=$?
  if [ -n "$__pixelsky_seen" ]; then printf '\\033]633;D;%s\\007' "$ec"; fi
  __pixelsky_seen=1
  printf '\\033]633;A\\007'
  return $ec
}
case ";$PROMPT_COMMAND;" in
  *";__pixelsky_precmd;"*) ;;
  *) PROMPT_COMMAND="__pixelsky_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac
`

/** zsh 钩子：放在用户 .zshrc 之后，precmd 最前面（保住 $?）。第一个提示符之前没跑过命令，不发 D */
const ZSH_HOOK = `__pixelsky_precmd() {
  local ec=$?
  if [[ -n $__pixelsky_seen ]]; then printf '\\e]633;D;%s\\a' "$ec"; fi
  __pixelsky_seen=1
  printf '\\e]633;A\\a'
  return $ec
}
precmd_functions=(__pixelsky_precmd \${precmd_functions:#__pixelsky_precmd})
`

/**
 * zsh 用 ZDOTDIR 指向我们的目录，里面每个启动文件先把 ZDOTDIR 换回用户的、读用户自己的同名文件、再换回来
 * （用户在 .zshenv 里改 ZDOTDIR 也跟得上）；.zshrc 末尾装钩子，并把 ZDOTDIR 还原成用户启动文件跑完后的值（用户在 ~/.zshenv 里 export ZDOTDIR=~/.config/zsh 也对；
 * 只有它还是 $HOME 且启动前没设过时才 unset）。
 */
const zshSource = (file: string): string => `if [[ -f "$PIXELSKY_USER_ZDOTDIR/${file}" ]]; then
  ZDOTDIR="$PIXELSKY_USER_ZDOTDIR"
  . "$PIXELSKY_USER_ZDOTDIR/${file}"
  PIXELSKY_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
  ZDOTDIR="$PIXELSKY_ZDOTDIR"
fi
`
export const ZSH_FILES: Record<string, string> = {
  '.zshenv': `# 像素星空终端集成（自动生成，不要手改）\n${zshSource('.zshenv')}`,
  '.zprofile': `# 像素星空终端集成（自动生成，不要手改）\n${zshSource('.zprofile')}`,
  // /etc/zshrc（macOS）会按 ZDOTDIR 定 HISTFILE，这时 ZDOTDIR 还是我们的目录：先改回用户的
  '.zshrc': `# 像素星空终端集成（自动生成，不要手改）
if [[ "$HISTFILE" == "$PIXELSKY_ZDOTDIR/.zsh_history" ]]; then HISTFILE="$PIXELSKY_USER_ZDOTDIR/.zsh_history"; fi
${zshSource('.zshrc')}${ZSH_HOOK}if [[ "$PIXELSKY_USER_ZDOTDIR" == "$HOME" && -z "$PIXELSKY_ORIG_ZDOTDIR" ]]; then unset ZDOTDIR; else ZDOTDIR="$PIXELSKY_USER_ZDOTDIR"; fi
unset PIXELSKY_ZDOTDIR PIXELSKY_USER_ZDOTDIR PIXELSKY_ORIG_ZDOTDIR
`,
}

/** 把 bash / zsh 要用的脚本写到 dir 下；失败就抛，调用方当作没有 bash / zsh 集成 */
export async function writeIntegrationFiles(dir: string): Promise<void> {
  await mkdir(join(dir, 'zsh'), { recursive: true })
  await writeFile(join(dir, 'bash.sh'), BASH_SCRIPT, 'utf8')
  for (const [name, content] of Object.entries(ZSH_FILES)) await writeFile(join(dir, 'zsh', name), content, 'utf8')
}

/** dir 下的 name；按目标平台拼，Windows 上也换成正斜杠（Git Bash / msys 认 C:/x/y，反斜杠会被当转义） */
const inDir = (dir: string, name: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? win32.join(dir, name).replaceAll('\\', '/') : posix.join(dir, name)

/**
 * 这个终端该怎么注入；不支持（或 bash / zsh 的脚本没写成，dir 为 null）返回 null。
 * env 是将要传给 shell 的环境变量（取用户原有的 PROMPT、ZDOTDIR 用）
 */
export function shellIntegration(
  profile: Pick<TerminalProfile, 'command' | 'args' | 'custom'>,
  dir: string | null,
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): ShellIntegration | null {
  const kind = integrationKind(profile)
  if (kind === 'powershell')
    return {
      kind,
      args: [
        ...profile.args,
        '-NoExit',
        '-EncodedCommand',
        Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64'),
      ],
      env: {},
      exitCodes: true,
    }
  if (kind === 'cmd') {
    // cmd 的 PROMPT 每次出提示符都会展开；$E 是 ESC，结尾要 BEL（ESC \ 会被 ConPTY 吞掉），只能直接放进环境变量。
    // 退出码 cmd 的提示符里拿不到，只报提示符开始
    const own = '\u001b]633;A\u0007'
    const key = Object.keys(env).find(k => k.toLowerCase() === 'prompt')
    const base = (key && env[key]) || '$P$G'
    return {
      kind,
      args: profile.args,
      env: { PROMPT: base.includes(own) ? base : '$E]633;A\u0007' + base },
      exitCodes: false,
    }
  }
  if (!dir) return null
  if (kind === 'bash') {
    const login = profile.args.some(a => a === '-l' || a === '--login')
    const rest = profile.args.filter(a => a !== '-l' && a !== '--login' && a !== '-i')
    return {
      kind,
      args: ['--init-file', inDir(dir, 'bash.sh', platform), '-i', ...rest],
      env: login ? { PIXELSKY_SHELL_LOGIN: '1' } : {},
      exitCodes: true,
    }
  }
  if (kind === 'zsh') {
    const zdotdir = inDir(dir, 'zsh', platform)
    const original = env.ZDOTDIR ?? ''
    return {
      kind,
      args: profile.args,
      env: {
        ZDOTDIR: zdotdir,
        PIXELSKY_ZDOTDIR: zdotdir,
        PIXELSKY_USER_ZDOTDIR: original || env.HOME || '',
        PIXELSKY_ORIG_ZDOTDIR: original,
      },
      exitCodes: true,
    }
  }
  return null
}
