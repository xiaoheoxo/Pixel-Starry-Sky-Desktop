// 「任务」视图的纯逻辑：拼命令、跑完退出的后缀、状态推导、筛选。不碰 window / localStorage（docs/ui/coding-tasks.md §3、§4）
import type {
  GradleListedTask,
  GradleProperty,
  RunTask,
  RunTaskGroup,
  RunTaskState,
} from '../../../../../shared/types/project-tools'
import type { TerminalRecord } from '../../../../../shared/types/terminal'
import { extTaskCommand, quote, shellKind, shellName, TaskCommandError } from './extCommand'

// 扩展任务的命令拼装在 extCommand.ts（不引用扩展 store，node 测试能直接用）；shellName 也放在那里，这里原样再导出
export { shellName, TaskCommandError }

/**
 * Gradle 的命令（docs/ui/coding-tasks.md §9.3）：有 wrapper 用 ./gradlew（PowerShell 自己会找 gradlew.bat，cmd 要写 .\gradlew.bat），
 * 构建不在工作区根时加 -p；根项目只写任务名，子项目写全路径。目录、wrapper 路径、任务路径都按终端加引号
 */
function gradleCommand(group: RunTaskGroup, task: RunTask, shell: string | undefined): string {
  const g = group.gradle!
  const kind = shellKind(shell)
  // gradle / gradlew 在 Windows 上是 .bat：PowerShell 调它会按旧规则传参，含 & | < > ^ % " 的值没法安全传
  const q = (value: string): string => quote(value, kind, undefined, true)
  let runner = 'gradle'
  if (g.wrapper) {
    const path =
      kind === 'cmd'
        ? `.\\${g.buildDir ? g.buildDir.replaceAll('/', '\\') + '\\' : ''}gradlew.bat`
        : `./${g.buildDir ? g.buildDir + '/' : ''}gradlew`
    const quoted = q(path)
    // PowerShell 里带引号的路径要用 & 才会执行
    runner = (kind === 'pwsh' || kind === 'ps5') && quoted !== path ? `& ${quoted}` : quoted
  }
  const dir = g.buildDir ? ` -p ${q(g.buildDir)}` : ''
  return `${runner}${dir} ${q(g.project === ':' ? task.name : `${g.project}:${task.name}`)}`
}

/**
 * 在终端里跑这个任务的命令；子文件夹用工具自己的目录参数，不 cd。
 * shell 是终端程序，决定引号写法（extCommand.quote）：PowerShell / sh 单引号，cmd 双引号，不知道时单引号（含 ' 按 PowerShell 双写）。
 * cmd 下目录或任务名含 % 时抛 TaskCommandError
 */
export function taskCommand(group: RunTaskGroup, task: RunTask, shell?: string): string {
  if (group.kind === 'gradle' && group.gradle) return gradleCommand(group, task, shell)
  if (group.kind === 'ext' && group.ext) return extTaskCommand(group, task, shell)
  const kind = shellKind(shell)
  const q = (value: string): string => quote(value, kind)
  const dir = group.dir
  if (group.kind === 'make') return dir ? `make -C ${q(dir)} ${q(task.name)}` : `make ${q(task.name)}`
  if (group.kind === 'cargo')
    return dir ? `cargo ${q(task.name)} --manifest-path ${q(`${dir}/Cargo.toml`)}` : `cargo ${q(task.name)}`
  const manager = group.manager ?? 'npm'
  if (!dir) return `${manager} run ${q(task.name)}`
  const flag = manager === 'pnpm' ? '--dir' : manager === 'npm' ? '--prefix' : '--cwd'
  return `${manager} ${flag} ${q(dir)} run ${q(task.name)}`
}

const POWERSHELL_EXIT = '; $ok=$?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $ok) { exit 1 }; exit 0'

/** 命令后面接的「跑完就退出、带上命令的退出码」；程序名不认识（含远程）时按 POSIX shell 处理 */
export function exitSuffix(program: string | undefined): string {
  const name = shellName(program)
  // 只写 exit $LASTEXITCODE 时，命令找不到（如没装 task）或 cmdlet 出错会退出码 0、显示成功；所以先记下 $?，
  // 程序给了非 0 退出码就用它，否则按 $? 判断成败
  if (name === 'powershell' || name === 'pwsh') return POWERSHELL_EXIT
  if (name === 'cmd') return ' && exit 0 || exit 1'
  if (name === 'fish') return '; exit $status'
  return '; exit $?'
}

export type TaskStatusKind = 'idle' | 'running' | 'stopping' | 'ok' | 'failed' | 'stopped'
export interface TaskStatus {
  kind: TaskStatusKind
  /** 失败时的退出码；不知道为 null */
  code: number | null
}
export const IDLE: TaskStatus = { kind: 'idle', code: null }

/** 这次运行在界面里记下的几件事（store.ts 的 Run），taskStatus 据此在终端记录之上推状态 */
export interface RunFlags {
  /** 点了停止，但这个 shell 没有提示符标记可等：直接算已停止（旧行为） */
  stopped?: boolean
  /** 点了停止，等提示符回来才算已停止 */
  stopping?: boolean
  /** 命令写进终端之后，提示符回来了（Ctrl+C 中止了整行，exit 后缀没执行）；code 是标记里的退出码，不知道为 null */
  ended?: { code: number | null } | null
}

/** Ctrl+C 打断的退出码：bash / zsh 的 128+SIGINT，Windows 的 STATUS_CONTROL_C_EXIT（有符号 / 无符号两种写法） */
const INTERRUPTED = new Set([130, -1073741510, 3221225786])

/** 提示符回来了的结果：点了停止 / 被 Ctrl+C 打断 / 退出码未知 都算已停止；0 成功；其余失败 */
function endedStatus(code: number | null, stopping: boolean): TaskStatus {
  if (stopping || code === null || INTERRUPTED.has(code)) return { kind: 'stopped', code: null }
  return code === 0 ? { kind: 'ok', code: null } : { kind: 'failed', code }
}

/**
 * 终端记录 → 任务状态。任务命令后面有 exit 后缀，正常跑完 shell 会退出（看 record）；
 * 被 Ctrl+C 中止时 shell 留在提示符，靠提示符标记（flags.ended）知道结束了。
 * 没有标记的 shell 只有 stopped（发过 Ctrl+C）压过「终端还在跑」（已退出的除外：退出码说了算）。标记判定过结束的以标记为准，之后 shell 再退出也不改
 */
export function taskStatus(record: TerminalRecord | undefined, flags: RunFlags = {}): TaskStatus {
  if (!record) return IDLE
  // 已经按提示符标记判定结束的，之后用户在终端里再 exit 也不改判
  if (flags.ended && record.status !== 'error') return endedStatus(flags.ended.code, !!flags.stopping)
  if (record.status === 'exited')
    return record.exitCode === 0 ? { kind: 'ok', code: null } : { kind: 'failed', code: record.exitCode ?? null }
  if (flags.stopped) return { kind: 'stopped', code: null }
  if (record.status === 'error') return { kind: 'failed', code: null }
  if (record.status !== 'running' && record.status !== 'starting') return IDLE
  if (flags.stopping) return { kind: 'stopping', code: null }
  return { kind: 'running', code: null }
}

/** 终端名：Gradle 子项目的任务写全路径（:fabric:runClient），其余就是任务名 */
export const taskTitle = (group: RunTaskGroup, task: RunTask): string =>
  group.gradle && group.gradle.project !== ':' ? `${group.gradle.project}:${task.name}` : task.name

/** 任务在内存里的键（同一工作区内唯一） */
/** 组的标识：普通组就是文件；扩展组再带上扩展 + 模板，免得两个扩展对同一个文件出的组撞键 */
export const groupKey = (group: RunTaskGroup): string =>
  group.kind === 'ext' && group.ext ? `${group.file}\u0001${group.ext.packKey}/${group.ext.templateId}` : group.file

export const taskKey = (group: RunTaskGroup, task: RunTask): string => `${groupKey(group)}\u0000${task.name}`

/** 按任务名、命令、所在文件夹 / 文件筛选；组里没有任务命中就去掉这一组 */
export function filterGroups(groups: readonly RunTaskGroup[], query: string): RunTaskGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...groups]
  const result: RunTaskGroup[] = []
  for (const group of groups) {
    const place = `${group.dir} ${group.file}`.toLowerCase()
    const tasks = group.tasks.filter(
      t =>
        place.includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.detail.toLowerCase().includes(q) ||
        !!t.category?.toLowerCase().includes(q) ||
        !!t.description?.toLowerCase().includes(q),
    )
    // Gradle 的属性按键和值筛（密的值不参与）
    const properties = group.gradle?.properties?.filter(
      p => p.key.toLowerCase().includes(q) || (!p.secret && p.value.toLowerCase().includes(q)),
    )
    if (tasks.length || properties?.length)
      result.push(group.gradle ? { ...group, tasks, gradle: { ...group.gradle, properties } } : { ...group, tasks })
  }
  return result
}

/** 根目录的组默认展开，其余收起；overrides 是用户手动改过的（true = 收起） */
export function isCollapsed(group: RunTaskGroup, overrides: Readonly<Record<string, boolean>>): boolean {
  return overrides[groupKey(group)] ?? group.dir !== ''
}

/** Gradle 里默认收起的分组（§9.3） */
const QUIET_CATEGORIES = new Set([
  'help',
  'other',
  'verification',
  'documentation',
  'publishing',
  'distribution',
  'build setup',
  'ide',
])
/** 「属性」节点当作一个分组，名字不会和 Gradle 的分组重名 */
export const PROPERTIES = '\u0001properties'
/** Gradle 分组 / 属性节点展开状态的键 */
export const categoryKey = (group: RunTaskGroup, category: string): string => `${groupKey(group)}\u0000${category}`
export function isCategoryCollapsed(
  group: RunTaskGroup,
  category: string,
  overrides: Readonly<Record<string, boolean>>,
): boolean {
  return overrides[categoryKey(group, category)] ?? (category === PROPERTIES || QUIET_CATEGORIES.has(category))
}
/** Gradle 组里的分组，按第一次出现的顺序 */
export const categoriesOf = (group: RunTaskGroup): string[] => [...new Set(group.tasks.map(t => t.category || 'other'))]

/** 键盘上下移动用的可见行（组头 + 展开组里的任务；Gradle 组中间多「属性」和分组一层）；筛选时全部展开 */
export type TaskRow =
  | { type: 'group'; group: RunTaskGroup }
  | { type: 'category'; group: RunTaskGroup; category: string; count: number }
  | { type: 'prop'; group: RunTaskGroup; prop: GradleProperty }
  | { type: 'task'; group: RunTaskGroup; task: RunTask }
export function visibleRows(
  groups: readonly RunTaskGroup[],
  overrides: Readonly<Record<string, boolean>>,
  filtering: boolean,
): TaskRow[] {
  const rows: TaskRow[] = []
  for (const group of groups) {
    rows.push({ type: 'group', group })
    if (!filtering && isCollapsed(group, overrides)) continue
    if (group.kind !== 'gradle') {
      for (const task of group.tasks) rows.push({ type: 'task', group, task })
      continue
    }
    const properties = group.gradle?.properties ?? []
    if (properties.length) {
      rows.push({ type: 'category', group, category: PROPERTIES, count: properties.length })
      if (filtering || !isCategoryCollapsed(group, PROPERTIES, overrides))
        for (const prop of properties) rows.push({ type: 'prop', group, prop })
    }
    for (const category of categoriesOf(group)) {
      const tasks = group.tasks.filter(t => (t.category || 'other') === category)
      rows.push({ type: 'category', group, category, count: tasks.length })
      if (filtering || !isCategoryCollapsed(group, category, overrides))
        for (const task of tasks) rows.push({ type: 'task', group, task })
    }
  }
  return rows
}

/** 行的键（键盘焦点、data-task-row） */
export function rowKey(row: TaskRow): string {
  if (row.type === 'group') return `g:${groupKey(row.group)}`
  if (row.type === 'category') return `c:${categoryKey(row.group, row.category)}`
  if (row.type === 'prop') return `p:${groupKey(row.group)}\u0000${row.prop.key}`
  return `t:${taskKey(row.group, row.task)}`
}

// ---- Gradle 完整任务列表（§9.2）----
/** 一个构建的完整列表记录 */
export interface GradleFull {
  at: number
  /** 加载时构建文件的指纹 */
  stamp: string
  tasks: GradleListedTask[]
}
/** 构建的键：工作区根 + 构建文件夹 */
export const gradleBuildKey = (root: string, buildDir: string): string =>
  `${root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()}\u0000${buildDir}`

/** 有完整列表的构建：各组的任务换成列表里的（行号和构建文件里写的说明从推断的同名任务里拿，Gradle 的说明放 description） */
export function mergeGradleFull(state: RunTaskState, fulls: ReadonlyMap<string, GradleFull>): RunTaskState {
  if (!fulls.size) return state
  let changed = false
  const groups = state.groups.map(group => {
    const g = group.gradle
    const full = g && fulls.get(gradleBuildKey(state.root, g.buildDir))
    const listed = full ? full.tasks.filter(t => t.project === g!.project) : []
    if (!listed.length) return group
    changed = true
    const known = new Map(group.tasks.map(t => [t.name, t]))
    const tasks = listed.map(t => {
      const mine = known.get(t.name)
      return {
        name: t.name,
        detail: mine?.detail ?? '',
        line: mine?.line ?? null,
        category: t.category,
        description: t.description,
      }
    })
    return { ...group, tasks }
  })
  return changed ? { ...state, groups } : state
}

/** 组头显示的名字：子文件夹写文件夹，根目录写文件名 */
export const groupTitle = (group: RunTaskGroup): string => (group.dir ? group.dir : group.file)

/** 文件名是不是会产生任务（编辑器保存后要重新读）；extra 是扩展任务模板认的文件名 */
export function isTaskFile(path: string, extra?: ReadonlySet<string>): boolean {
  const name = path.replaceAll('\\', '/').split('/').pop() ?? ''
  return (
    !!extra?.has(name) ||
    name === 'package.json' ||
    name === 'Cargo.toml' ||
    /^(gnu)?makefile$/i.test(name) ||
    /^(build|settings)\.gradle(\.kts)?$/.test(name) ||
    name === 'gradle.properties' ||
    name === 'gradle-wrapper.properties'
  )
}

/** 编辑器里打开的文件是任务列表里的哪个组（package.json、build.gradle(.kts) 加 ▶）；root 是文件所在工作区根目录 */
export function gutterGroupForFile(state: RunTaskState | null, root: string, path: string): RunTaskGroup | null {
  if (!state) return null
  const norm = (v: string): string => v.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  if (norm(state.root) !== norm(root)) return null
  const file = norm(path).replace(/^\.\//, '')
  return state.groups.find(g => (g.kind === 'npm' || g.kind === 'gradle') && norm(g.file) === file) ?? null
}
