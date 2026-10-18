import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import type { TerminalProfile, TerminalProfileInput } from '../../shared/types/terminal'

// 这一层的检测全部异步，也不起 where.exe / which：Windows 上开进程是主线程同步做的，被安全软件拖慢时整个应用卡住
// （编辑器检测同理，见 core/editors.ts）。只有在 PATH、常见目录都找不到 PowerShell 7 时才会异步起一次 powershell.exe。
async function usable(path: string): Promise<boolean> {
  // Windows Store 的执行别名可能排在 PATH 前面但 stat 不了，当作没有，找下一个
  try {
    if (!(await stat(path)).isFile()) return false
    if (process.platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 按 PATH（Windows 上再按 PATHEXT）逐目录找 */
async function onPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const suffixes =
    process.platform === 'win32' && !extname(name)
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const dir of dirs)
    for (const suffix of suffixes) {
      const path = join(dir, name + suffix)
      if (await usable(path)) return path
    }
  return null
}

export async function executable(value: string): Promise<string | null> {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) return null
  if (isAbsolute(value)) return (await usable(value)) ? value : null
  return onPath(value)
}

/** 依次找，返回第一个存在的 */
async function firstExecutable(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    const found = await executable(path)
    if (found) return found
  }
  return null
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    )
  })
}

/** Read installed locations without depending on the desktop process inheriting pwsh's PATH. */
export async function powerShell7(): Promise<string | null> {
  const fromPath = await executable('pwsh.exe')
  if (fromPath) return fromPath
  const folders = new Set(
    [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(
      (v): v is string => !!v,
    ),
  )
  const candidates = [...folders].map(folder => join(folder, 'PowerShell', '7', 'pwsh.exe'))
  if (process.env.LOCALAPPDATA)
    candidates.push(join(process.env.LOCALAPPDATA, 'Microsoft', 'PowerShell', '7', 'pwsh.exe'))
  const installed = await firstExecutable(candidates)
  if (installed) return installed
  const windowsShell = await executable(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  )
  if (!windowsShell) return null
  // Use an absolute Windows PowerShell path and a fixed, profile-free read script.
  // UTF-8 output preserves non-ASCII usernames and custom installation directories.
  const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $key = Get-Item -LiteralPath ($hive + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe')
    if ($key) { $key.GetValue('') }
    Get-ChildItem -Path ($hive + '\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions') | ForEach-Object {
      $version = Get-ItemProperty -LiteralPath $_.PSPath
      if ($version.SemanticVersion -match '^7\\.\\d+\\.\\d+$' -and $version.InstallLocation) { Join-Path $version.InstallLocation 'pwsh.exe' }
    }
  }
)
$valid = @($paths | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($valid.Count -eq 0) {
  $valid = @(Get-AppxPackage -Name Microsoft.PowerShell | Sort-Object { [version]$_.Version } -Descending | ForEach-Object { Join-Path $_.InstallLocation 'pwsh.exe' })
}
ConvertTo-Json -InputObject @($valid) -Compress
`
  try {
    const output = await run(windowsShell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ])
    const paths: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim())
    if (Array.isArray(paths))
      for (const path of paths) {
        if (typeof path !== 'string' || !isAbsolute(path)) continue
        const found = await executable(path)
        if (found) return found
      }
  } catch {
    /* Missing installation or metadata cannot make a profile available. */
  }
  return null
}
/** macOS / Linux：登录 shell（$SHELL）排第一，再是装了的 zsh / bash / fish / sh；都用登录模式，读得到用户的 PATH */
async function posixProfiles(): Promise<Omit<TerminalProfile, 'available'>[]> {
  const login = process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : null
  const shells = [
    { id: 'zsh', label: 'zsh', paths: ['/bin/zsh', '/usr/bin/zsh'] },
    { id: 'bash', label: 'bash', paths: ['/bin/bash', '/usr/bin/bash'] },
    { id: 'fish', label: 'fish', paths: ['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'] },
    { id: 'sh', label: 'sh', paths: ['/bin/sh'] },
  ]
  const found = (
    await Promise.all(
      shells.map(async s => {
        const command = await firstExecutable(s.paths)
        return command ? [{ id: s.id, label: s.label, command, args: s.id === 'sh' ? [] : ['-l'] }] : []
      }),
    )
  ).flat()
  const name = login?.split('/').pop() ?? ''
  const same = found.find(s => s.id === name)
  if (login && !same) found.unshift({ id: 'login', label: name || 'shell', command: login, args: ['-l'] })
  else if (same) found.splice(0, 0, ...found.splice(found.indexOf(same), 1))
  return found.length ? found : [{ id: 'sh', label: 'sh', command: '/bin/sh', args: [] }]
}

/** 查每个 Shell 程序在不在，命令换成找到的完整路径 */
function probe(profiles: Omit<TerminalProfile, 'available'>[]): Promise<TerminalProfile[]> {
  return Promise.all(
    profiles.map(async profile => {
      const command = await executable(profile.command)
      return { ...profile, command: command ?? profile.command, available: !!command }
    }),
  )
}

/** 自定义 Shell 的可用性（不重新检测内置的） */
export function probeCustom(custom: TerminalProfile[]): Promise<TerminalProfile[]> {
  return probe(custom)
}

/** 系统自带 / 常见的 Shell，不含用户自定义的 */
export async function detectBuiltin(): Promise<TerminalProfile[]> {
  if (process.platform !== 'win32') return probe(await posixProfiles())
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const [pwsh, git] = await Promise.all([
    powerShell7(),
    firstExecutable([
      join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ]),
  ])
  return probe([
    { id: 'pwsh', label: 'PowerShell 7', command: pwsh ?? 'pwsh.exe', args: ['-NoLogo'] },
    {
      id: 'powershell',
      label: 'Windows PowerShell',
      command: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo'],
    },
    { id: 'cmd', label: 'cmd', command: process.env.ComSpec ?? 'cmd.exe', args: ['/d'] },
    ...(git ? [{ id: 'git-bash', label: 'Git Bash', command: git, args: ['--login', '-i'] }] : []),
  ])
}

export async function detectProfiles(custom: TerminalProfile[] = []): Promise<TerminalProfile[]> {
  const [builtin, extra] = await Promise.all([detectBuiltin(), probeCustom(custom)])
  return [...builtin, ...extra]
}
export function terminalTitle(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value.trim()].length > 120 ||
    // eslint-disable-next-line no-control-regex -- 故意匹配控制字符，拒绝包含换行等控制字符的名称
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error('终端名称需为 1–120 个字符，不能包含换行')
  return value.trim()
}
export function profileInput(value: TerminalProfileInput): TerminalProfileInput {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.command !== 'string' ||
    !value.command.trim() ||
    value.command.length > 4096 ||
    /[\r\n\0]/.test(value.command)
  )
    throw new Error('Shell 程序路径不正确')
  if (
    !Array.isArray(value.args) ||
    value.args.length > 64 ||
    value.args.some(v => typeof v !== 'string' || v.length > 8192 || v.includes('\0'))
  )
    throw new Error('Shell 参数必须是字符串数组')
  if (value.id !== undefined && (typeof value.id !== 'string' || !value.id.startsWith('custom-')))
    throw new Error('只能修改自定义 Shell')
  return { id: value.id, label: terminalTitle(value.label), command: value.command.trim(), args: [...value.args] }
}
export function terminalEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (
      typeof value !== 'string' ||
      /^(ELECTRON_|PIXELSKY_|NODE_OPTIONS$|NODE_PATH$|VSCODE_INSPECTOR_OPTIONS$|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$)/i.test(
        key,
      )
    )
      continue
    env[key] = value
  }
  env.TERM = 'xterm-256color'
  // 从程序坞 / Finder 启动的没有 LANG，zsh / bash 显示中文会乱
  if (process.platform === 'darwin' && !env.LANG && !env.LC_ALL) env.LANG = 'en_US.UTF-8'
  return env
}
