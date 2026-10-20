import { spawn } from 'node:child_process'
import { readFile, readdir, mkdir, writeFile, rename, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, join, posix, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { logger } from '@pixelsky/engine'
import type { EditorItem, EditorKind, EditorState, OpenTool, WorkspaceRef } from '../../shared/types/workspace'
import { locateFolder, workspacePath, type TargetResolver } from './workspace-files'
import { detectJetBrains, detectTools, jetbrainsName, launchTool, productOf } from './open-tools'
import { exeVersion } from './exe-version'
import { findShortcuts } from './shortcuts'

const perf = logger('perf')
/** 检测超过这么久就记一条，看慢在哪 */
const SLOW_DETECT_MS = 2000

export const EDITORS = [
  {
    id: 'vscode',
    name: 'VS Code',
    exe: 'Code.exe',
    dir: 'Microsoft VS Code',
    command: 'code',
    app: 'Visual Studio Code',
  },
  { id: 'cursor', name: 'Cursor', exe: 'Cursor.exe', dir: 'cursor', command: 'cursor', app: 'Cursor' },
  { id: 'windsurf', name: 'Windsurf', exe: 'Windsurf.exe', dir: 'Windsurf', command: 'windsurf', app: 'Windsurf' },
  { id: 'trae-cn', name: 'Trae CN', exe: 'Trae CN.exe', dir: 'Trae CN', command: 'trae-cn', app: 'Trae CN' },
  { id: 'trae', name: 'Trae', exe: 'Trae.exe', dir: 'Trae', command: 'trae', app: 'Trae' },
] as const

/**
 * macOS / Linux 上找的是编辑器自带的命令行（code、cursor 等脚本，参数和 Windows 的 exe 一样）：
 * macOS 在 <应用>.app/Contents/Resources/app/bin 里，Linux 在 PATH、/usr/share/<目录>/bin、snap 里
 */
export function posixEditorPaths(
  kind: (typeof EDITORS)[number],
  platform: NodeJS.Platform,
  home: string,
  pathDirs: string[],
): { path: string; source: 'location' | 'path' }[] {
  const located =
    platform === 'darwin'
      ? ['/Applications', posix.join(home, 'Applications')].map(root =>
          posix.join(root, `${kind.app}.app`, 'Contents', 'Resources', 'app', 'bin', kind.command),
        )
      : [
          posix.join('/usr/share', kind.command, 'bin', kind.command),
          posix.join('/opt', kind.app, 'bin', kind.command),
          posix.join('/opt', kind.command, 'bin', kind.command),
          posix.join('/snap/bin', kind.command),
        ]
  return [
    ...located.map(path => ({ path, source: 'location' as const })),
    ...pathDirs.map(dir => ({ path: posix.join(dir, kind.command), source: 'path' as const })),
  ]
}
interface Prefs {
  defaultId: string | null
  openWith: string
  window: 'reuse' | 'new'
  custom: EditorItem[]
  /** 「打开方式」按钮直接点时用哪个（GitHub #12） */
  workspaceId: string | null
}
const DEFAULTS: Prefs = { defaultId: null, openWith: 'app', window: 'reuse', custom: [], workspaceId: null }
const KINDS = [...EDITORS.map(e => e.id), 'jetbrains', 'custom']
/** <应用>.app 里能启动的程序：VS Code 一类用 Contents/Resources/app/bin/<命令>，其余用 Contents/MacOS 里和应用同名的程序 */
async function macAppProgram(app: string, kind: EditorKind): Promise<string | null> {
  const builtin = EDITORS.find(e => e.id === kind)
  const root = app.replace(/\/$/, '')
  if (builtin) {
    const cli = join(root, 'Contents', 'Resources', 'app', 'bin', builtin.command)
    if (await exists(cli)) return cli
  }
  try {
    const names = await readdir(join(root, 'Contents', 'MacOS'))
    const stem = root.replace(/^.*\//, '').replace(/\.app$/, '')
    const name = names.find(n => n === stem) ?? names[0]
    return name ? join(root, 'Contents', 'MacOS', name) : null
  } catch {
    return null
  }
}
const exists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function editorArgs(
  mode: EditorItem['mode'],
  windowMode: EditorState['window'],
  root: string,
  file?: string,
  line?: number,
  column?: number,
): string[] {
  if (mode === 'folder') return [file ?? root]
  const position = (): void => {
    if (
      line !== undefined &&
      (!Number.isInteger(line) ||
        line <= 0 ||
        line > 10000000 ||
        (column !== undefined && (!Number.isInteger(column) || column <= 0 || column > 10000000)))
    )
      throw new Error('文件行列不正确')
  }
  // JetBrains：项目目录在前，文件前面跟 --line / --column（项目没开时一起打开）
  if (mode === 'jetbrains') {
    if (!file) return [root]
    position()
    return [root, ...(line !== undefined ? ['--line', String(line), '--column', String(column ?? 1)] : []), file]
  }
  const args = [windowMode === 'new' ? '--new-window' : '--reuse-window']
  if (file) {
    args.push(root)
    if (line !== undefined) {
      if (
        !Number.isInteger(line) ||
        line <= 0 ||
        line > 10000000 ||
        (column !== undefined && (!Number.isInteger(column) || column <= 0 || column > 10000000))
      )
        throw new Error('文件行列不正确')
      args.push('--goto', `${file}:${line}:${column ?? 1}`)
    } else args.push(file)
  } else args.push(root)
  return args
}

export class Editors {
  private prefs: Prefs = { ...DEFAULTS, custom: [] }
  private items: EditorItem[] = []
  private tools: OpenTool[] = []
  private checkedAt = 0
  private detecting: Promise<EditorState> | null = null
  private saving: Promise<void> = Promise.resolve()
  constructor(
    private directory: string,
    private target: TargetResolver,
    private getIcon?: (path: string) => Promise<string | undefined>,
  ) {}
  async init(): Promise<void> {
    try {
      const p = JSON.parse(await readFile(join(this.directory, 'editor-settings.json'), 'utf8'))
      this.prefs = {
        defaultId: typeof p.defaultId === 'string' ? p.defaultId : null,
        openWith: typeof p.openWith === 'string' ? p.openWith : 'app',
        window: p.window === 'new' ? 'new' : 'reuse',
        workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : null,
        custom: Array.isArray(p.custom)
          ? p.custom
              .filter(
                (e: EditorItem) =>
                  e &&
                  typeof e.id === 'string' &&
                  typeof e.name === 'string' &&
                  typeof e.path === 'string' &&
                  KINDS.includes(e.kind) &&
                  ['code', 'folder', 'jetbrains'].includes(e.mode),
              )
              .map((e: EditorItem) => ({ ...e, available: false, manual: true, source: 'manual' }))
          : [],
      }
    } catch {
      /* 未配置或文件损坏使用默认值 */
    }
  }
  private snapshot(): EditorState {
    return {
      items: this.items.map(e => ({ ...e })),
      defaultId: this.prefs.defaultId,
      openWith: this.prefs.openWith,
      window: this.prefs.window,
      checkedAt: this.checkedAt,
      tools: this.tools.map(t => ({ ...t })),
      workspaceId: this.prefs.workspaceId,
    }
  }
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.prefs, null, 2)
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const file = join(this.directory, 'editor-settings.json')
        await writeFile(file + '.tmp', snapshot)
        await rename(file + '.tmp', file)
      })
    return this.saving
  }
  async state(force = false): Promise<EditorState> {
    if (this.detecting) return this.detecting
    if (!force && this.checkedAt && Date.now() - this.checkedAt < 60000) return this.snapshot()
    this.detecting = this.detect()
    try {
      return await this.detecting
    } finally {
      this.detecting = null
    }
  }
  /** 打开程序、改默认值时用现有结果，不因为过了 60 秒先重新检测；一次都没检测过才等检测 */
  private current(): Promise<EditorState> {
    return this.checkedAt ? Promise.resolve(this.snapshot()) : this.state()
  }
  /**
   * 检测不开任何进程（docs/ui/open-with.md）：Windows 上开进程是在主线程上同步做的，被安全软件拖慢时整个应用卡住。
   * 装在别处（如 D 盘）的程序靠开始菜单和桌面的快捷方式找，版本直接读 exe 里的版本信息。
   */
  protected async detect(): Promise<EditorState> {
    const started = performance.now()
    const found: EditorItem[] = []
    const shortcuts = await findShortcuts().catch(() => [])
    const toolsPromise = detectTools(shortcuts).catch(() => [] as OpenTool[])
    const jetbrainsPromise = detectJetBrains(shortcuts).catch(() => [])
    for (const manual of this.prefs.custom)
      found.push({ ...manual, available: await exists(manual.path), manual: true, source: 'manual' })
    await Promise.all(
      EDITORS.map(async kind => {
        const linked = shortcuts
          .filter(s => basename(s.target).toLowerCase() === kind.exe.toLowerCase())
          .map(s => s.target)
        const locations = [
          ...[process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
            .filter((p): p is string => !!p)
            .flatMap(p => [join(p, 'Programs', kind.dir, kind.exe), join(p, kind.dir, kind.exe)]),
        ]
        if (process.platform === 'win32')
          for (let drive = 65; drive <= 90; drive++) {
            const root = `${String.fromCharCode(drive)}:\\`
            locations.push(
              join(root, kind.dir, kind.exe),
              join(root, 'Program Files', kind.dir, kind.exe),
              join(root, 'Program Files (x86)', kind.dir, kind.exe),
            )
          }
        const inPath: string[] = []
        for (const bin of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
          inPath.push(resolve(bin, '../../..', kind.exe), resolve(bin, '..', kind.exe), join(bin, kind.exe))
        }
        const candidates =
          process.platform === 'win32'
            ? [
                ...linked.map(path => ({ path, source: 'shortcut' as const })),
                ...locations.map(path => ({ path, source: 'location' as const })),
                ...inPath.map(path => ({ path, source: 'path' as const })),
              ]
            : posixEditorPaths(
                kind,
                process.platform,
                homedir(),
                (process.env.PATH ?? '').split(delimiter).filter(Boolean),
              )
        const checks = await Promise.all(candidates.map(async c => ({ ...c, available: await exists(c.path) })))
        for (const candidate of checks.filter(c => c.available)) {
          // macOS / Linux 上 /usr/local/bin/code 是指向应用里命令行的链接：按实际位置去重
          const path = process.platform === 'win32' ? resolve(candidate.path) : await realpath(candidate.path),
            normalized = path.toLowerCase()
          if (found.some(e => e.path.toLowerCase() === normalized)) continue
          const id = found.some(e => e.id === kind.id)
            ? `${kind.id}:${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`
            : kind.id
          found.push({
            id,
            kind: kind.id,
            name: kind.name,
            path,
            source: candidate.source,
            mode: 'code',
            available: true,
            manual: false,
          })
        }
      }),
    )
    for (const ide of await jetbrainsPromise) {
      const normalized = ide.path.toLowerCase()
      if (found.some(e => e.path.toLowerCase() === normalized)) continue
      const stem = ide.path
        .replace(/^.*[\\/]/, '')
        .replace(/64\.exe$/i, '')
        .toLowerCase()
      const id = found.some(e => e.id === `jetbrains:${stem}`)
        ? `jetbrains:${stem}:${createHash('sha256').update(normalized).digest('hex').slice(0, 12)}`
        : `jetbrains:${stem}`
      found.push({
        id,
        kind: 'jetbrains',
        name: ide.name,
        version: ide.version,
        path: ide.path,
        source: ide.source,
        mode: 'jetbrains',
        available: true,
        manual: false,
      })
    }
    this.tools = await toolsPromise
    if (this.prefs.defaultId && !found.some(e => e.id === this.prefs.defaultId)) {
      const old = this.items.find(e => e.id === this.prefs.defaultId)
      const builtin = EDITORS.find(e => e.id === this.prefs.defaultId)
      if (old || builtin)
        found.push(
          old
            ? { ...old, available: false }
            : {
                id: builtin!.id,
                kind: builtin!.id,
                name: builtin!.name,
                mode: 'code',
                path: '',
                available: false,
                manual: false,
              },
        )
    }
    await Promise.all(
      found.map(async item => {
        if (!item.available) return
        // JetBrains 的 exe 版本信息是构建号（262.9437.185.0-IU），用快捷方式名或安装目录名里的版本（2026.2.1）
        if (process.platform === 'win32' && !(item.kind === 'jetbrains' && item.version))
          item.version = (await exeVersion(item.path)) ?? item.version
        if (this.getIcon) item.icon = await this.getIcon(item.path).catch(() => undefined)
      }),
    )
    const rank = (e: EditorItem): number =>
      e.source === 'shortcut' ? 0 : e.source === 'manual' ? 1 : e.source === 'location' ? 2 : 3
    this.items = found.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    this.checkedAt = Date.now()
    if (!this.prefs.defaultId && this.items.some(e => e.available)) {
      this.prefs.defaultId =
        this.items.find(e => e.kind === 'trae-cn' && e.source === 'shortcut' && e.available)?.id ??
        this.items.find(e => e.available)!.id
      await this.persist()
    }
    const ms = performance.now() - started
    if (ms > SLOW_DETECT_MS)
      perf.warn('编辑器检测很慢', {
        ms: Math.round(ms),
        shortcuts: shortcuts.length,
        items: this.items.length,
        tools: this.tools.length,
      })
    return this.snapshot()
  }
  async preferences(value: unknown): Promise<EditorState> {
    const patch = value as Partial<Prefs>
    if (!patch || typeof patch !== 'object') throw new Error('编辑器设置不正确')
    await this.current()
    if (patch.defaultId !== undefined) {
      if (patch.defaultId !== null && !this.items.some(e => e.id === patch.defaultId)) throw new Error('编辑器不存在')
      this.prefs.defaultId = patch.defaultId
    }
    if (patch.window !== undefined) {
      if (patch.window !== 'reuse' && patch.window !== 'new') throw new Error('窗口方式不正确')
      this.prefs.window = patch.window
    }
    if (patch.workspaceId !== undefined) {
      if (
        patch.workspaceId !== null &&
        !this.items.some(e => e.id === patch.workspaceId) &&
        !this.tools.some(t => t.id === patch.workspaceId)
      )
        throw new Error('打开方式不存在')
      this.prefs.workspaceId = patch.workspaceId
    }
    if (patch.openWith !== undefined) {
      if (patch.openWith !== 'app' && !this.items.some(e => e.id === patch.openWith)) throw new Error('打开方式不存在')
      this.prefs.openWith = patch.openWith
    }
    await this.persist()
    return this.snapshot()
  }
  async configure(kind: EditorKind, path: string, name?: string, mode?: 'code' | 'folder'): Promise<EditorState> {
    if (!KINDS.includes(kind)) throw new Error('未知编辑器')
    // macOS 选的是 .app：换成里面的命令行（VS Code 一类）或主程序
    if (process.platform === 'darwin' && /\.app\/?$/.test(path)) path = (await macAppProgram(path, kind)) ?? path
    if (!(await exists(path)) || (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe')))
      throw new Error('请选择编辑器的 exe 程序')
    // JetBrains（GitHub #30）：认 bin 里的启动程序（idea64.exe、pycharm64.exe…），名字和版本从文件名、安装目录名里看
    if (kind === 'jetbrains') {
      if (!productOf(path))
        throw new Error('请选择 JetBrains IDE 的启动程序（bin 里的 idea64.exe、pycharm64.exe 这类）')
      const { name: ideName, version } = jetbrainsName(path)
      const known = this.prefs.custom.find(e => e.kind === 'jetbrains' && e.path.toLowerCase() === path.toLowerCase())
      const ide: EditorItem = {
        id: known?.id ?? 'custom:' + randomUUID(),
        kind,
        name: ideName,
        ...(version ? { version } : {}),
        path,
        mode: 'jetbrains',
        available: true,
        manual: true,
      }
      this.prefs.custom = [...this.prefs.custom.filter(e => e.id !== ide.id), ide]
      await this.persist()
      return this.state(true)
    }
    const builtin = EDITORS.find(e => e.id === kind)
    const id = builtin?.id ?? 'custom:' + randomUUID()
    const item: EditorItem = {
      id,
      kind,
      name: builtin?.name ?? name?.trim().slice(0, 60) ?? '自定义编辑器',
      path,
      mode: builtin ? 'code' : mode === 'code' ? 'code' : 'folder',
      available: true,
      manual: true,
    }
    this.prefs.custom = [...this.prefs.custom.filter(e => e.id !== id), item]
    await this.persist()
    return this.state(true)
  }
  async remove(id: string): Promise<EditorState> {
    this.prefs.custom = this.prefs.custom.filter(e => e.id !== id)
    if (this.prefs.defaultId === id && id.startsWith('custom:')) this.prefs.defaultId = null
    if (this.prefs.openWith === id && id.startsWith('custom:')) this.prefs.openWith = 'app'
    await this.persist()
    return this.state(true)
  }
  async open(
    ref: WorkspaceRef,
    editorId?: string,
    path?: string,
    line?: number,
    column?: number,
  ): Promise<{ editor: string; target: string }> {
    if (editorId !== undefined && typeof editorId !== 'string') throw new Error('编辑器 ID 不正确')
    if (path !== undefined && typeof path !== 'string') throw new Error('文件路径不正确')
    // 附加文件夹里的文件（「::N/…」）：编辑器按那个文件夹打开（docs/ui/multi-root-projects.md §3.4）
    const at = locateFolder(this.target(ref), path ?? '')
    const project = await workspacePath(at.root, '', 'directory')
    // 文件树里对文件夹点「用外部编辑器打开」：把这个文件夹当作要打开的目录，不当文件
    let file = path ? await workspacePath(project, at.rel) : undefined
    let root = project
    if (file && (await stat(file)).isDirectory()) {
      root = file
      file = undefined
    } else if (file && !(await stat(file)).isFile()) throw new Error('目标不是普通文件')
    const state = await this.current()
    // 文件资源管理器、Git Bash、终端：只能打开整个文件夹（GitHub #12）
    const tool = !file ? state.tools.find(t => t.id === editorId) : undefined
    if (tool) {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      await launchTool(tool, root, env)
      return { editor: tool.name, target: root }
    }
    const editor = state.items.find(e => e.id === (editorId ?? state.defaultId))
    if (!editor) throw new Error('先选择默认编辑器')
    if (!editor.available || !editor.path || !(await exists(editor.path))) {
      this.checkedAt = 0
      throw new Error('默认编辑器不可用，请重新检测或指定路径')
    }
    await launch(editor.path, editorArgs(editor.mode, this.prefs.window, root, file, line, column))
    return { editor: editor.name, target: file ?? root }
  }

  /**
   * 用默认编辑器打开项目外的一个文件（上下文明细里的记忆文件，docs/ui/context-window.md §7）：
   * 不经过项目目录检查，调用方先确认这个路径可以打开。没有可用的默认编辑器时返回 null
   */
  async openFile(file: string): Promise<{ editor: string; target: string } | null> {
    const state = await this.current()
    const editor = state.items.find(e => e.id === state.defaultId)
    if (!editor?.available || !editor.path || !(await exists(editor.path))) return null
    const args =
      editor.mode === 'code' ? [this.prefs.window === 'new' ? '--new-window' : '--reuse-window', file] : [file]
    await launch(editor.path, args)
    return { editor: editor.name, target: file }
  }
}

/** 启动编辑器，不等它退出 */
async function launch(program: string, args: string[]): Promise<void> {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise<void>((done, fail) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, detached: true, stdio: 'ignore', env })
    child.once('error', e => fail(new Error('编辑器启动失败：' + e.message)))
    child.once('spawn', () => {
      child.unref()
      done()
    })
  })
}
