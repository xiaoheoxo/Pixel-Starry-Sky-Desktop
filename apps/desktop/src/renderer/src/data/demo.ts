// 演示数据的入口（AGENTS.md §5、docs/restructure.md §9.3）。
// 演示数据本身在 mock/，只由 main.tsx 在演示模式下动态加载后装进来；其它文件不导入 mock/，经 demo() 取用。
// 默认模式不加载 mock/（构建时它是单独的分块）。
import { useSyncExternalStore } from 'react'
import type {
  ArtifactResponse,
  ContextWindow,
  EngineCatalog,
  EngineConfig,
  FileChange,
  Item,
  NativeImportResult,
  NativeSessionDetail,
  NativeSessionSummary,
  RemoteCall,
  RewindPreview,
  SearchQuery,
  SearchResponse,
  SessionSnapshot,
  TaskOutput,
  UsageRecord,
} from '@pixelsky/protocol'
import type { MachineState, WorkspaceChoice } from '../../../shared/types/machines'
import type { AccountInfo, StoreCatalog } from '../../../shared/types/account'
import type { AccountBridge } from '../../../preload/account'
import type { ArtifactPreview } from '../../../shared/types/artifacts'
import type { PlatformGroupInfo } from '../../../shared/types/platform-catalog'
import type { ProvidersState } from '../../../shared/types/providers'
import type { BrowserState } from '../../../shared/types/project-browser'
import type {
  EnvironmentState,
  GitBranch,
  GitCommitDetail,
  GitCompareTarget,
  GitCompareResult,
  GitDiff,
  GitDiffInput,
  GitLogPage,
  GitLogQuery,
  GitRefs,
  GitStatus,
  ManualTask,
  ProjectCopy,
  TaskState,
  RunTaskState,
} from '../../../shared/types/project-tools'
import type { ExtStoreBridge } from '../../../preload/extstore'
import type { TerminalProfile } from '../../../shared/types/terminal'
import type { SessionStatusState } from '../../../shared/types/session-status'
import type { DirectoryListing, EditorState, FileDocument } from '../../../shared/types/workspace'
import type { InboxItem } from '@/features/panel/inbox/inboxModel'
import type { AppData, DemoSessionChange, EngineLite, Project } from './types'

/** 是否为演示模式（主进程根据环境变量 PIXELSKY_DEMO=1 或启动参数 --demo 传入） */
export const isDemo = typeof window !== 'undefined' && window.pixelsky?.demo === true

/** 演示模式下会话改动的内存存储（归档、删除、停止、改名、置底） */
export interface DemoSessions {
  get(): Record<string, DemoSessionChange>
  change(id: string, patch: Partial<DemoSessionChange>): void
  subscribe(listener: () => void): () => void
}

/** 会动的演示改一个会话：change 换掉条目，patch 同时改快照的其它字段（运行状态等） */
export type DemoUpdate = (
  sessionId: string,
  change: (items: Item[]) => Item[],
  patch?: Partial<Omit<SessionSnapshot, 'items'>>,
) => void

/** 演示模式的软件内付款（mock/checkout.ts）：假的桥方法，和会随到账变化的演示账号 */
export interface DemoCheckout {
  bridge: Pick<
    AccountBridge,
    | 'checkoutCreate'
    | 'checkoutGet'
    | 'checkoutVerify'
    | 'checkoutCancel'
    | 'checkoutPending'
    | 'checkoutOpenPayUrl'
    | 'checkoutOpenPayWindow'
    | 'checkoutClosePayWindow'
    | 'panelStatus'
    | 'panelVerify'
  >
  account(): AccountInfo
  subscribe(listener: () => void): () => void
}

/** 全部演示数据。新增演示内容先在这里加字段，再在 mock/index.ts 填上 */
export interface DemoSource {
  /** 侧边栏、对话、输入框等界面数据（与 data/empty.ts 同形） */
  appData: AppData
  account: AccountInfo
  /** 设置 → 账号里的订阅套餐、充值（形状同云端 /v1/platform/store） */
  store: StoreCatalog
  /** 软件内付款的假桥和会随到账变化的演示账号（mock/checkout.ts，docs/ui/in-app-payment.md §6.10） */
  checkout: DemoCheckout
  platformGroups: PlatformGroupInfo[]
  /** 自定义 API 的两条假接口 */
  providers: ProvidersState
  engines: {
    status: EngineLite[]
    catalog: EngineCatalog
    /** Codex 的模型目录（③ ChatGPT 授权列的模型，docs/ui/model-channels.md） */
    codexCatalog: EngineCatalog
    config: EngineConfig
  }
  artifacts: {
    response: ArtifactResponse
    change(itemId: string, path: string): FileChange | null
    preview(path: string): ArtifactPreview
  }
  context: ContextWindow
  files: {
    contents: Record<string, string>
    editorState: EditorState
    directory(path: string): DirectoryListing
    document(path: string): FileDocument
  }
  git: {
    status: GitStatus
    branches: GitBranch[]
    diff(path: string): GitDiff
    /** 提交历史（docs/ui/git-panel.md §9） */
    history: {
      refs: GitRefs
      log(query: GitLogQuery): GitLogPage
      show(hash: string): GitCommitDetail
      compare(target: GitCompareTarget): GitCompareResult
      diff(input: Extract<GitDiffInput, { area: 'commit' }>): GitDiff
    }
  }
  inbox: InboxItem[]
  /** 侧栏对话状态图标用的演示数据：文件夹没了、关联的 PR（docs/ui/sidebar-status-icons.md） */
  sessionStatus?: SessionStatusState
  /** 扩展商店（设置 › 扩展 › 发现）：假的预加载桥（带一份演示目录）和已经装好的扩展 id */
  extStore: { bridge: ExtStoreBridge; installed: string[] }
  /** 演示用的云端机器（顶栏「本机 | 云端」），machines/store.ts 演示时用它当初始状态 */
  machines?: MachineState
  /** 演示时某台机器（WSL）自己的项目和工作区；没有的机器沿用 appData.projects */
  machineProjects?: Record<string, Array<Project & { path: string }>>
  machineWorkspaces?: (machineId: string) => WorkspaceChoice[]
  projectTools: {
    tasks: TaskState
    /** 左栏「任务」：项目里能跑的命令（docs/ui/coding-tasks.md） */
    runTasks: RunTaskState
    environment: EnvironmentState
    copies: ProjectCopy[]
    browser: BrowserState
  }
  /** 任务看板的演示任务（几个演示项目都有，docs/ui/task-board.md §7）；now 是打开看板的时间 */
  boardTasks(now: number): ManualTask[]
  remoteCalls(now: number): RemoteCall[]
  usageRecords(now: number): UsageRecord[]
  search: { projects: Array<{ id: string; name: string }>; run(query: SearchQuery): SearchResponse }
  terminal: { profiles: TerminalProfile[]; output: string }
  sessions: DemoSessions
  /** 用真实对话组件显示的演示会话（docs/ui/demo-conversation.md）：会话快照、子智能体记录、后台任务输出 */
  conversations: {
    snapshots: Record<string, SessionSnapshot>
    subagentTranscript(sessionId: string, agentId: string): Item[]
    taskOutput(sessionId: string, taskId: string): TaskOutput
    /** 回退前的代码检查（docs/ui/rewind-fork-sidechat.md §1） */
    rewindPreview(sessionId: string, itemId: string, firstUserId: string | null): RewindPreview
    /** 旁聊回答（§3） */
    sideAnswer(question: string): string
    /** 接着终端里的 Claude Code / Codex 会话（docs/ui/claude-resume.md、codex-resume.md；按引擎各一份）：第一步的列表、第二步补的尾部信息、导入（只是跳到一个现成的展示对话） */
    nativeSessions: {
      list(projectId: string, engine?: 'claude' | 'codex'): NativeSessionSummary[]
      details(ids: readonly string[], engine?: 'claude' | 'codex'): NativeSessionDetail[]
      import(nativeId: string, mode: 'inplace' | 'copy', engine?: 'claude' | 'codex'): NativeImportResult
    }
    /** 会动的演示（压缩上下文、当前步骤循环播放，docs/ui/compaction.md）：update 换掉某个会话的条目，patch 改运行状态等 */
    animate?(update: DemoUpdate): void
  }
}

let source: DemoSource | null = null

/** 由 main.tsx 在演示模式下、界面加载之前调用一次 */
export function installDemo(demo: DemoSource): void {
  source = demo
}

/** 演示数据；只在 isDemo 为真的分支里调用 */
export function demo(): DemoSource {
  if (!source) throw new Error('演示数据还没有加载')
  return source
}

const NO_CHANGES: Record<string, DemoSessionChange> = {}
const noSubscribe = (): (() => void) => () => {}
const noChanges = (): Record<string, DemoSessionChange> => NO_CHANGES

/** 演示模式下的会话改动；不是演示模式时始终是空对象 */
export function useDemoSessionChanges(): Record<string, DemoSessionChange> {
  const sessions = source?.sessions
  return useSyncExternalStore(sessions?.subscribe ?? noSubscribe, sessions?.get ?? noChanges)
}

/** 当前的演示会话改动（非 hook）；不是演示模式时是空对象 */
export function demoSessionChanges(): Record<string, DemoSessionChange> {
  return source?.sessions.get() ?? NO_CHANGES
}
