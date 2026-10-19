import type { ExtTaskTemplateWire, SessionRecord } from '@pixelsky/protocol'
import type { WorkspaceRef } from '../shared/types/workspace'
import type {
  ManualTask,
  TaskState,
  ServiceDefinition,
  ServiceInput,
  EnvironmentState,
  RunTaskState,
  GradleListedTask,
  ProjectCopy,
  CopyInput,
  CopyPreview,
  GitCommitContext,
  GitCommitDetail,
  GitCommitScope,
  GitCompareResult,
  GitCompareTarget,
  GitHistoryAction,
  GitDiffInput,
  GitLogPage,
  GitLogQuery,
  GitRefs,
  GitStatus,
  GitDiff,
  GitBranch,
  GitResult,
  GitPaths,
  GitPullMode,
} from '../shared/types/project-tools'

export interface ProjectToolsBridge {
  searchTasks(text: string, projectId: string | null): Promise<ManualTask[]>
  /** 固定到左侧栏 / 取消固定（docs/ui/files-search-terminal-pins.md §5） */
  pinTask(id: string, pinned: boolean): Promise<ManualTask>
  /** 当前机器上所有已固定的任务 */
  pinnedTasks(): Promise<ManualTask[]>
  /** 当前机器上所有项目的任务（任务看板） */
  allTasks(): Promise<ManualTask[]>
  tasks(projectId: string): Promise<TaskState>
  createTask(projectId: string, input: Partial<ManualTask>): Promise<ManualTask>
  updateTask(id: string, patch: Partial<ManualTask>): Promise<ManualTask>
  deleteTask(id: string): Promise<void>
  reorderTasks(projectId: string, ids: string[]): Promise<void>
  environment(ref: WorkspaceRef, force?: boolean): Promise<EnvironmentState>
  /** 代码模式左栏「任务」：项目里能跑的命令（docs/ui/coding-tasks.md） */
  /** templates：扩展提供的任务模板，主进程（或远程运行时）再校验一遍 */
  runTasks(ref: WorkspaceRef, templates?: ExtTaskTemplateWire[]): Promise<RunTaskState>
  /** Gradle 完整任务列表：在构建根目录跑 `gradlew tasks --all`（docs/ui/coding-tasks.md §9.2） */
  gradleTasks(ref: WorkspaceRef, buildDir: string): Promise<GradleListedTask[]>
  gradleTasksCancel(ref: WorkspaceRef, buildDir: string): Promise<void>
  services(ref: WorkspaceRef): Promise<ServiceDefinition[]>
  saveService(ref: WorkspaceRef, input: ServiceInput): Promise<ServiceDefinition>
  deleteService(id: string): Promise<void>
  startService(id: string): Promise<ServiceDefinition>
  stopService(id: string, force?: boolean): Promise<void>
  restartService(id: string): Promise<ServiceDefinition>
  portStatus(port: number): Promise<{ occupied: boolean; pid: string | null; suggested: number }>
  copies(projectId: string): Promise<ProjectCopy[]>
  branches(projectId: string): Promise<string[]>
  previewCopy(projectId: string, input: CopyInput): Promise<CopyPreview>
  createCopy(projectId: string, input: CopyInput): Promise<ProjectCopy>
  openCopy(id: string): Promise<SessionRecord>
  removeCopy(id: string, force?: boolean): Promise<void>
  forgetCopy(id: string): Promise<void>
  chooseDirectory(): Promise<string | null>
  openPath(ref: WorkspaceRef): Promise<void>
  revealCopy(id: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** recheck：重新确认仓库根再读（Git 页的刷新按钮） */
  gitStatus(ref: WorkspaceRef, opts?: { recheck?: boolean }): Promise<GitStatus>
  gitDiff(ref: WorkspaceRef, input: GitDiffInput): Promise<GitDiff>
  gitBranches(ref: WorkspaceRef): Promise<GitBranch[]>
  gitStage(ref: WorkspaceRef, paths: GitPaths): Promise<GitResult>
  gitUnstage(ref: WorkspaceRef, paths: GitPaths): Promise<GitResult>
  gitDiscard(ref: WorkspaceRef, input: { paths: string[]; untracked: string[] } | 'all'): Promise<GitResult>
  gitCommit(ref: WorkspaceRef, input: { message: string; all: boolean; push: boolean }): Promise<GitResult>
  /** AI 写提交信息要发给模型的改动（docs/ui/ai-commit-codex-warnings-history.md §2.2）；界面不直接用，主进程按项目所在机器取 */
  gitCommitContext(ref: WorkspaceRef, input: { scope: GitCommitScope }): Promise<GitCommitContext>
  gitPull(ref: WorkspaceRef, mode: GitPullMode): Promise<GitResult>
  gitPush(ref: WorkspaceRef, input: { publish: boolean }): Promise<GitResult>
  gitFetch(ref: WorkspaceRef): Promise<GitResult>
  gitSwitch(ref: WorkspaceRef, input: { branch: string; remote: boolean }): Promise<GitResult>
  /** start：在这个提交上新建（docs/ui/git-panel.md §9.6），switch 为真时切过去 */
  gitCreateBranch(ref: WorkspaceRef, input: { name: string; start?: string; switch?: boolean }): Promise<GitResult>
  gitOperation(ref: WorkspaceRef, action: 'abort' | 'continue'): Promise<GitResult>
  /** 提交历史（docs/ui/git-panel.md §9） */
  gitLog(ref: WorkspaceRef, query: GitLogQuery): Promise<GitLogPage>
  gitRefs(ref: WorkspaceRef): Promise<GitRefs>
  gitShow(ref: WorkspaceRef, hash: string): Promise<GitCommitDetail>
  gitCompare(ref: WorkspaceRef, target: GitCompareTarget): Promise<GitCompareResult>
  /** 历史里会改动仓库的操作（§9.6 第二期） */
  gitHistoryAction(ref: WorkspaceRef, action: GitHistoryAction): Promise<GitResult>
  onChange(cb: () => void): () => void
}
