// 扩展任务模板的命令拼装（docs/extensions/authoring-spec.md §8）：纯函数，不碰 window，也不 import 扩展 store，node 测试可直接用
import type { RunTask, RunTaskGroup } from '../../../../../shared/types/project-tools'

/**
 * 终端的引号风格：posix = sh / bash / zsh；pwsh = PowerShell；cmd；any = 不知道是哪个终端（复制命令、让 AI 运行等）。
 * any 用单引号；值里有单引号时，若没有 $ ` " 反斜杠 ! 和弯双引号就改用双引号（bash 和 PowerShell 都得到原值），否则按 PowerShell 的写法双写。
 * pwsh = PowerShell 7+，ps5 = Windows PowerShell 5.1（引号规则相同，但值里含 " 时 5.1 没法安全传给外部程序）
 */
export type ShellKind = 'posix' | 'pwsh' | 'ps5' | 'cmd' | 'any'

const isPowerShell = (kind: ShellKind): boolean => kind === 'pwsh' || kind === 'ps5'

/** 命令没法安全拼出来；界面据 code 换成提示文案，不往终端里写。cmdPercent = cmd 下的 %；psBatch = PowerShell 调 .bat / .cmd 时含 & | < > ^ % "；psQuote = Windows PowerShell 5.1 下含 " */
export type TaskCommandErrorCode = 'cmdPercent' | 'psBatch' | 'psQuote'
export class TaskCommandError extends Error {
  constructor(
    readonly value: string,
    readonly code: TaskCommandErrorCode = 'cmdPercent',
  ) {
    super(`cannot safely pass this path or task name (${code}): ${value}`)
    this.name = 'TaskCommandError'
  }
}

/** 终端程序的名字：去掉目录和 .exe，小写 */
export function shellName(program: string | undefined): string {
  const base = (program ?? '').replaceAll('\\', '/').split('/').pop() ?? ''
  return base.toLowerCase().replace(/\.exe$/, '')
}

/** 不传（或空）= 不知道终端；认不出的程序名（含 wsl、远程）按 POSIX shell 处理 */
export function shellKind(program: string | undefined): ShellKind {
  const name = shellName(program)
  if (!name) return 'any'
  if (name === 'pwsh') return 'pwsh'
  if (name === 'powershell') return 'ps5'
  return name === 'cmd' ? 'cmd' : 'posix'
}

// 首字符不能是 @（PowerShell 的 @name 是 splatting）或 =（zsh 把 =cmd 展开成路径）
const SAFE = /^(?![@=])[\w./:@+=-]+$/
/** 运行器多允许一个反斜杠（.\mvnw.cmd） */
const SAFE_RUNNER = /^(?![@=])[\w./\\:@+=-]+$/

/** any 终端里值含这些就不能放进双引号（bash 会展开 $ ` ! 和反斜杠，PowerShell 把弯双引号当引号） */
const NOT_IN_DOUBLE = /[\x24\x60\x22!\\\u201C-\u201E]/
/** PowerShell 调 .bat / .cmd 时按旧规则传参（不含空格的参数去掉引号交给 cmd），这些字符会被 cmd 当命令分隔 / 展开 */
const BATCH_UNSAFE = /[&|<>^%\x22]/

/**
 * 按终端加引号；只有含特殊字符才加。
 * cmd 里 % 在双引号内也会展开、没法转义，直接拒绝（TaskCommandError）；! 只在 cmd /V:ON 下展开，终端不是这么启动的，不处理。
 * batch：这个值会传给 .bat / .cmd（Gradle、.cmd 运行器）。PowerShell 下含 BATCH_UNSAFE 的值没法安全传，同样拒绝。
 * Windows PowerShell 5.1 下含 " 的值也拒绝
 */
export function quote(value: string, kind: ShellKind, safe = SAFE, batch = false): string {
  if (kind === 'cmd' && value.includes('%')) throw new TaskCommandError(value)
  if (kind === 'ps5' && value.includes('"')) throw new TaskCommandError(value, 'psQuote')
  if (batch && isPowerShell(kind) && BATCH_UNSAFE.test(value)) throw new TaskCommandError(value, 'psBatch')
  // cmd 里反斜杠是路径分隔符，不需要引号
  if ((kind === 'cmd' ? SAFE_RUNNER : safe).test(value)) return value
  if (kind === 'cmd') return `"${value.replaceAll('"', '""')}"`
  if (kind === 'any' && value.includes("'") && !NOT_IN_DOUBLE.test(value.replaceAll("'", ''))) return `"${value}"`
  // PowerShell 把 U+2018–U+201B 也当单引号，都要双写
  if (isPowerShell(kind) || kind === 'any') return `'${value.replace(/[\u0027\u2018-\u201B]/g, m => m + m)}'`
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** 运行器：项目里的文件加 ./（.\）前缀，PowerShell 里带前缀或引号时前面写 & */
function runnerText(runner: string | null, local: boolean, kind: ShellKind, batch: boolean): string {
  if (!runner) return ''
  let text = runner
  let prefixed = false
  const bare = runner.replace(/^\.[/\\]/, '')
  if (local && !/[/\\]/.test(bare)) {
    text = `${kind === 'posix' || kind === 'any' ? './' : '.\\'}${bare}`
    prefixed = true
  }
  const quoted = quote(text, kind, SAFE_RUNNER, batch)
  return isPowerShell(kind) && (prefixed || quoted !== text) ? `& ${quoted}` : quoted
}

/** 扩展任务在终端里跑的命令；shell 是终端程序，不知道时用 any 的引号规则 */
export function extTaskCommand(group: RunTaskGroup, task: RunTask, shell?: string): string {
  const ext = group.ext
  if (!ext) return ''
  const kind = shellKind(shell)
  // 运行器是 .bat / .cmd 时，PowerShell 调它会按旧规则传参：名字、目录、文件都不能带 & | < > ^ % "（拿不到文件系统，没写扩展名的 mvn 之类检测不到）
  const batch = !!ext.runner && ext.command.includes('{runner}') && /\.(cmd|bat)$/i.test(ext.runner)
  const q = (value: string): string => quote(value, kind, SAFE, batch)
  // 一遍替换：替进去的文字不再被扫描
  const fill = (template: string, values: Record<string, string>): string =>
    template.replace(/\{(name|runner|dir|file)\}/g, (_, key: string) => values[key] ?? '')
  const command = fill(ext.command, {
    name: q(task.name),
    runner: runnerText(ext.runner, ext.runnerLocal, kind, batch),
    dir: q(group.dir || '.'),
    file: q(group.file),
  })
  const cwd = fill(ext.cwd, { name: task.name, runner: ext.runner ?? '', dir: group.dir || '.', file: group.file })
  if (cwd === '' || cwd === '.') return command
  const target = quote(kind === 'cmd' ? cwd.replaceAll('/', '\\') : cwd, kind)
  if (kind === 'cmd') return `cd /d ${target} && ${command}`
  if (isPowerShell(kind)) return `Set-Location -LiteralPath ${target}; if ($?) { ${command} }`
  return `cd ${target} && ${command}`
}
