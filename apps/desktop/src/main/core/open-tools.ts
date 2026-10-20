// 「打开方式」里 VS Code 一类以外的程序（GitHub #12，docs/ui/open-with.md）：JetBrains 的 IDE，和文件资源管理器、
// Git Bash、终端这些只能打开文件夹的程序。只认本机装了的；找的地方：开始菜单和桌面的快捷方式、常见安装目录、PATH。
// 检测不开任何进程：Windows 上开进程是在主线程上同步做的，被安全软件拖慢时整个应用会卡住。
import { spawn } from 'node:child_process'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import type { OpenTool, OpenToolId } from '../../shared/types/workspace'
import type { ShortcutTarget } from './shortcuts'

/** JetBrains 的 IDE：bin 目录里的启动程序 → 显示名 */
export const JETBRAINS = [
  { exe: 'idea64.exe', cmd: 'idea', name: 'IntelliJ IDEA' },
  { exe: 'webstorm64.exe', cmd: 'webstorm', name: 'WebStorm' },
  { exe: 'pycharm64.exe', cmd: 'pycharm', name: 'PyCharm' },
  { exe: 'goland64.exe', cmd: 'goland', name: 'GoLand' },
  { exe: 'clion64.exe', cmd: 'clion', name: 'CLion' },
  { exe: 'phpstorm64.exe', cmd: 'phpstorm', name: 'PhpStorm' },
  { exe: 'rider64.exe', cmd: 'rider', name: 'Rider' },
  { exe: 'rubymine64.exe', cmd: 'rubymine', name: 'RubyMine' },
  { exe: 'rustrover64.exe', cmd: 'rustrover', name: 'RustRover' },
  { exe: 'datagrip64.exe', cmd: 'datagrip', name: 'DataGrip' },
  { exe: 'dataspell64.exe', cmd: 'dataspell', name: 'DataSpell' },
  { exe: 'studio64.exe', cmd: 'studio', name: 'Android Studio' },
] as const

/** 启动程序的文件名 → 哪个 IDE：Windows 的 idea64.exe，macOS / Linux 的 idea、idea.sh */
export const productOf = (path: string): (typeof JETBRAINS)[number] | undefined => {
  const file = basename(path).toLowerCase()
  return JETBRAINS.find(j => j.exe === file || j.cmd === file || `${j.cmd}.sh` === file)
}

export interface JetBrainsFound {
  path: string
  name: string
  /** 从快捷方式名或安装目录名里看出的版本（如 2026.2.1）；看不出时省略，之后再读 exe 的版本信息 */
  version?: string
  source: 'shortcut' | 'location' | 'path'
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
/** 应用执行别名（WindowsApps 里的 pwsh.exe、wt.exe）stat 会报 EACCES，lstat 能看到 */
const isFileOrAlias = async (path: string): Promise<boolean> => {
  if (await isFile(path)) return true
  try {
    return (await lstat(path)).isSymbolicLink()
  } catch {
    return false
  }
}
const isDir = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
const subdirs = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(dir, d.name))
  } catch {
    return []
  }
}

/** 产品名和版本：版本从快捷方式名或安装目录名（如「IntelliJ IDEA 2026.2.1」）里取 */
export function jetbrainsName(exePath: string, displayName?: string): { name: string; version?: string } {
  const name = productOf(exePath)?.name ?? basename(exePath, '.exe')
  const version = (s: string | undefined): string | undefined =>
    s?.toLowerCase().startsWith(name.toLowerCase()) ? /\b(\d{4}\.\d+(?:\.\d+)?)\b/.exec(s)?.[1] : undefined
  return { name, version: version(displayName) ?? version(basename(dirname(dirname(exePath)))) }
}

/**
 * Toolbox 设置里改过的安装目录（.settings.json 的 install_location，GitHub #30）：没改过、没装 Toolbox、读不出来都返回 null。
 * 只读文件，不开进程。
 */
export async function toolboxInstallLocation(settingsFile: string): Promise<string | null> {
  try {
    const value = (JSON.parse(await readFile(settingsFile, 'utf8')) as { install_location?: unknown }).install_location
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/** Toolbox 的设置文件在哪 */
function toolboxSettingsFile(): string | null {
  if (process.platform === 'win32')
    return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'JetBrains', 'Toolbox', '.settings.json') : null
  const home = homedir()
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', '.settings.json')
    : join(home, '.local', 'share', 'JetBrains', 'Toolbox', '.settings.json')
}

/** 装在某个目录下的 IDE 的 bin 目录：新版 Toolbox / 自己解压的 <目录>\<IDE>\bin，旧版 Toolbox 的 apps\<产品>\ch-0\<版本>\bin */
async function binsUnder(root: string): Promise<string[]> {
  const bins = (await subdirs(root)).map(ide => join(ide, 'bin'))
  for (const app of await subdirs(join(root, 'apps')))
    for (const channel of await subdirs(app)) for (const build of await subdirs(channel)) bins.push(join(build, 'bin'))
  return bins
}

/** 本机装了的 JetBrains IDE（同一个 exe 只留一个，快捷方式指着的优先） */
export async function detectJetBrains(shortcuts: ShortcutTarget[] = []): Promise<JetBrainsFound[]> {
  if (process.platform !== 'win32') return detectJetBrainsPosix()
  const candidates: JetBrainsFound[] = shortcuts
    .filter(s => productOf(s.target))
    .map(s => ({ path: s.target, name: s.name, source: 'shortcut' as const }))
  const bins: string[] = []
  const local = process.env.LOCALAPPDATA
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((p): p is string => !!p)
  const drives: string[] = []
  for (let drive = 65; drive <= 90; drive++) drives.push(`${String.fromCharCode(drive)}:\\`)
  for (const drive of drives) roots.push(join(drive, 'Program Files'))
  // 独立安装：<Program Files>\JetBrains\<IDE 版本>\bin；Android Studio：<Program Files>\Android\Android Studio\bin
  for (const root of new Set(roots)) {
    for (const ide of await subdirs(join(root, 'JetBrains'))) bins.push(join(ide, 'bin'))
    bins.push(join(root, 'Android', 'Android Studio', 'bin'))
  }
  // 装在盘根目录（D:\JetBrains\<IDE 版本>\bin，自定义安装目录或解压版，GitHub #30）
  for (const drive of drives) for (const ide of await subdirs(join(drive, 'JetBrains'))) bins.push(join(ide, 'bin'))
  // Toolbox 设置里改过安装目录
  const settings = toolboxSettingsFile()
  const custom = settings ? await toolboxInstallLocation(settings) : null
  if (custom) bins.push(...(await binsUnder(custom)))
  if (local) {
    // Toolbox 2.x 装在 %LOCALAPPDATA%\Programs\<IDE>\bin；老版本在 Toolbox\apps\<产品>\ch-0\<版本>\bin
    for (const ide of await subdirs(join(local, 'Programs'))) bins.push(join(ide, 'bin'))
    for (const app of await subdirs(join(local, 'JetBrains', 'Toolbox', 'apps')))
      for (const channel of await subdirs(app))
        for (const build of await subdirs(channel)) bins.push(join(build, 'bin'))
  }
  const inPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const bin of bins)
    for (const j of JETBRAINS) candidates.push({ path: join(bin, j.exe), name: '', source: 'location' })
  for (const bin of inPath)
    for (const j of JETBRAINS) candidates.push({ path: join(bin, j.exe), name: '', source: 'path' })
  const checked = await Promise.all(candidates.map(async c => ((await isFile(c.path)) ? c : null)))
  const out: JetBrainsFound[] = []
  for (const c of checked) {
    if (!c) continue
    const path = resolve(c.path)
    if (out.some(o => o.path.toLowerCase() === path.toLowerCase())) continue
    out.push({ ...c, path, ...jetbrainsName(path, c.name || undefined) })
  }
  return out
}

/**
 * macOS：/Applications、~/Applications 里的 <IDE>.app（Contents/MacOS/<命令>）；
 * macOS / Linux：Toolbox 生成的启动脚本、PATH 上的命令、Linux 常见的 /opt、snap 安装位置
 */
async function detectJetBrainsPosix(): Promise<JetBrainsFound[]> {
  const home = homedir()
  const candidates: JetBrainsFound[] = []
  const add = (path: string, source: JetBrainsFound['source'], name = ''): void => {
    candidates.push({ path, name, source })
  }
  if (process.platform === 'darwin') {
    for (const root of ['/Applications', join(home, 'Applications')]) {
      let apps: string[] = []
      try {
        apps = await readdir(root)
      } catch {
        continue
      }
      for (const j of JETBRAINS)
        for (const app of apps.filter(a => a.startsWith(j.name) && a.endsWith('.app')))
          add(join(root, app, 'Contents', 'MacOS', j.cmd), 'location', app.replace(/\.app$/, ''))
    }
  } else {
    for (const dir of [...(await subdirs('/opt')), ...(await subdirs(join(home, '.local', 'share', 'JetBrains')))])
      for (const j of JETBRAINS) add(join(dir, 'bin', `${j.cmd}.sh`), 'location', basename(dir))
    for (const j of JETBRAINS) add(join('/snap/bin', j.cmd), 'location')
  }
  const toolbox =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts')
      : join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts')
  for (const j of JETBRAINS) add(join(toolbox, j.cmd), 'location')
  // Toolbox 设置里改过安装目录（GitHub #30）：macOS 是里面的 <IDE>.app，Linux 是 <IDE>/bin/<命令>.sh
  const settings = toolboxSettingsFile()
  const custom = settings ? await toolboxInstallLocation(settings) : null
  if (custom) {
    if (process.platform === 'darwin') {
      for (const app of (await subdirs(custom)).filter(a => a.endsWith('.app')))
        for (const j of JETBRAINS.filter(j => basename(app).startsWith(j.name)))
          add(join(app, 'Contents', 'MacOS', j.cmd), 'location', basename(app).replace(/\.app$/, ''))
    } else
      for (const bin of await binsUnder(custom))
        for (const j of JETBRAINS) add(join(bin, `${j.cmd}.sh`), 'location', basename(dirname(bin)))
  }
  for (const bin of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const j of JETBRAINS) add(join(bin, j.cmd), 'path')
  const out: JetBrainsFound[] = []
  for (const c of candidates) {
    if (!(await isFile(c.path)) || out.some(o => o.path === c.path)) continue
    out.push({ ...c, ...jetbrainsName(c.path, c.name || undefined) })
  }
  return out
}

const first = async (paths: string[], check = isFile): Promise<string | null> => {
  for (const path of paths) if (await check(path)) return path
  return null
}

/** 文件资源管理器、Git Bash、Windows Terminal、PowerShell：只列装了的（文件资源管理器一直有） */
export async function detectTools(shortcuts: ShortcutTarget[] = []): Promise<OpenTool[]> {
  if (process.platform === 'darwin') {
    const tools: OpenTool[] = [
      { id: 'explorer', name: 'Finder', path: '' },
      { id: 'terminal', name: 'Terminal', path: '' },
    ]
    for (const root of ['/Applications', join(homedir(), 'Applications')])
      if (await isDir(join(root, 'iTerm.app'))) {
        tools.push({ id: 'iterm', name: 'iTerm', path: join(root, 'iTerm.app') })
        break
      }
    return tools
  }
  if (process.platform !== 'win32') {
    const tools: OpenTool[] = [{ id: 'explorer', name: 'Files', path: '' }]
    const pathDirs = (process.env.PATH ?? '/usr/bin').split(delimiter).filter(Boolean)
    // 当前桌面自带的终端优先，没有就用 Debian 系的 x-terminal-emulator
    const kde = (process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().includes('kde')
    const names = kde
      ? ['konsole', 'gnome-terminal', 'x-terminal-emulator', 'xterm']
      : ['gnome-terminal', 'konsole', 'xfce4-terminal', 'x-terminal-emulator', 'xterm']
    for (const name of names) {
      const found = await first(pathDirs.map(d => join(d, name)))
      if (found) {
        tools.push({ id: 'terminal', name: TERMINAL_NAMES[name] ?? name, path: found })
        break
      }
    }
    return tools
  }
  const windir = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const local = process.env.LOCALAPPDATA ?? ''
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((p): p is string => !!p)
  const tools: OpenTool[] = [{ id: 'explorer', name: '文件资源管理器', path: join(windir, 'explorer.exe') }]
  const bash = await first([
    ...shortcuts.filter(s => basename(s.target).toLowerCase() === 'git-bash.exe').map(s => s.target),
    ...programFiles.map(p => join(p, 'Git', 'git-bash.exe')),
    ...(local ? [join(local, 'Programs', 'Git', 'git-bash.exe')] : []),
    // PATH 里的 Git\cmd、Git\bin、Git\mingw64\bin
    ...pathDirs.flatMap(d => [resolve(d, '..', 'git-bash.exe'), resolve(d, '..', '..', 'git-bash.exe')]),
  ])
  if (bash) tools.push({ id: 'git-bash', name: 'Git Bash', path: bash })
  const wt = await first(
    [...(local ? [join(local, 'Microsoft', 'WindowsApps', 'wt.exe')] : []), ...pathDirs.map(d => join(d, 'wt.exe'))],
    isFileOrAlias,
  )
  if (wt) tools.push({ id: 'windows-terminal', name: 'Windows Terminal', path: wt })
  const pwsh = await first(
    [
      ...programFiles.map(p => join(p, 'PowerShell', '7', 'pwsh.exe')),
      ...(local ? [join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
      ...pathDirs.map(d => join(d, 'pwsh.exe')),
    ],
    isFileOrAlias,
  )
  if (pwsh) tools.push({ id: 'pwsh', name: 'PowerShell 7', path: pwsh })
  else {
    const ps = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (await isFile(ps)) tools.push({ id: 'powershell', name: 'Windows PowerShell', path: ps })
  }
  return tools
}

const TERMINAL_NAMES: Record<string, string> = {
  'gnome-terminal': 'GNOME Terminal',
  konsole: 'Konsole',
  'xfce4-terminal': 'Xfce Terminal',
  'x-terminal-emulator': 'Terminal',
  xterm: 'xterm',
}

/** Linux 各终端指定起始目录的参数；x-terminal-emulator 不知道指向哪个，只靠工作目录 */
export function linuxTerminalArgs(path: string, root: string): string[] {
  const name = basename(path)
  if (name === 'gnome-terminal' || name === 'xfce4-terminal') return [`--working-directory=${root}`]
  if (name === 'konsole') return ['--workdir', root]
  return []
}

/** 打开文件夹的命令行：Git Bash 用 --cd，Windows Terminal 用 -d，PowerShell 在新窗口里停在这个目录 */
export function toolCommand(tool: OpenTool, root: string): { file: string; args: string[]; console: boolean } {
  const ids: Record<OpenToolId, () => { file: string; args: string[]; console: boolean }> = {
    explorer: () =>
      process.platform === 'win32'
        ? { file: tool.path || 'explorer.exe', args: [root], console: false }
        : { file: process.platform === 'darwin' ? 'open' : 'xdg-open', args: [root], console: false },
    terminal: () =>
      process.platform === 'darwin'
        ? { file: 'open', args: ['-a', 'Terminal', root], console: false }
        : { file: tool.path, args: linuxTerminalArgs(tool.path, root), console: false },
    iterm: () => ({ file: 'open', args: ['-a', tool.path || 'iTerm', root], console: false }),
    'git-bash': () => ({ file: tool.path, args: [`--cd=${root}`], console: false }),
    'windows-terminal': () => ({ file: tool.path, args: ['-d', root], console: false }),
    pwsh: () => ({ file: tool.path, args: ['-NoExit', '-WorkingDirectory', root], console: true }),
    powershell: () => ({ file: tool.path, args: ['-NoExit'], console: true }),
  }
  return ids[tool.id]()
}

/**
 * 启动这些程序的参数。它们都要弹出自己的窗口，不能带 windowsHide：带了资源管理器会打开一个看不见的窗口
 * （2026-10-20 实测，Shell 窗口列表里 visible = False），Git Bash、Windows Terminal 同理；
 * PowerShell 是控制台程序，detached 才会有自己的窗口
 */
export function launchOptions(root: string, env: NodeJS.ProcessEnv) {
  return { cwd: root, shell: false, windowsHide: false, detached: true, stdio: 'ignore' as const, env }
}

export function launchTool(tool: OpenTool, root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const { file, args } = toolCommand(tool, root)
  return new Promise((done, fail) => {
    const child = spawn(file, args, launchOptions(root, env))
    child.once('error', e => fail(new Error(`${tool.name} 启动失败：${e.message}`)))
    child.once('spawn', () => {
      child.unref()
      done()
    })
  })
}
