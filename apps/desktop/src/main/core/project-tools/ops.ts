// 项目工具（docs/ui/project-tools.md、git-panel.md）：本机与远端共用的操作表。
// 选择文件夹、打开目录、打开网址只在本机（workspace/project-tools-ipc.ts）
import { isAbsolute, relative } from 'node:path'
import type { WorkspaceChoice } from '../../../shared/types/machines'
import type { CopyInput, ManualTask, ServiceInput } from '../../../shared/types/project-tools'
import type { OpTable } from '../ops'
import { workspaceRef } from '../workspace-files'
import { gitWorktrees, samePath, value, type GitWorktree, type ToolsHost } from './common'
import type { GitTools } from './git'
import { cancelGradleTasks, listGradleTasks } from './gradle-run'
import { readRunTasks } from './run-tasks'
import { portStatus } from './services'
import type { ProjectTools } from './tools'

/** 只认会话的目标（{ sessionId }） */
function sessionOf(ref: unknown): string {
  const r = workspaceRef(ref)
  if (!r.sessionId) throw new Error('缺少会话')
  return r.sessionId
}

export interface ToolsOpContext {
  host: ToolsHost
  tools: ProjectTools
}

export const PROJECT_TOOL_OPS = {
  'projectTools:searchTasks': (c, text, projectId) => {
    const query = value(text, 200).toLocaleLowerCase().split(/\s+/).filter(Boolean)
    if (!query.length) return []
    return c.tools.tasks.store.data.tasks
      .filter(task => {
        if (projectId !== null && task.projectId !== projectId) return false
        try {
          c.host.resolve({ projectId: task.projectId })
        } catch {
          return false
        }
        return query.every(term =>
          (task.title + '\n' + task.note + '\n' + task.tags.join(' ')).toLocaleLowerCase().includes(term),
        )
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20)
  },
  'projectTools:tasks': (c, id) => c.tools.tasks.state(value(id, 200, true)),
  'projectTools:createTask': (c, id, input) => c.tools.tasks.create(value(id, 200, true), input as Partial<ManualTask>),
  'projectTools:updateTask': (c, id, input) => c.tools.tasks.update(value(id, 200, true), input as Partial<ManualTask>),
  // 事项派出去的卡片变了：频道服务调（docs/ui/channels-collab-v2.md §9）
  'projectTools:syncIssue': (c, id, input) =>
    c.tools.tasks.syncIssue(value(id, 200, true), input as { link: unknown; status?: unknown; fresh?: boolean }),
  'projectTools:deleteTask': (c, id) => c.tools.tasks.remove(value(id, 200, true)),
  'projectTools:pinTask': (c, id, pinned) => c.tools.tasks.pin(value(id, 200, true), pinned === true),
  'projectTools:pinnedTasks': c => c.tools.tasks.pinned(),
  'projectTools:allTasks': c => c.tools.tasks.all(),
  'projectTools:reorderTasks': (c, id, ids) => c.tools.tasks.reorder(value(id, 200, true), ids as string[]),
  'projectTools:environment': (c, ref, force) => c.tools.services.environment(workspaceRef(ref), force === true),
  'projectTools:runTasks': (c, ref, templates) => readRunTasks(c.host.resolve(workspaceRef(ref)).path, templates),
  'projectTools:gradleTasks': (c, ref, buildDir) =>
    listGradleTasks(c.host.resolve(workspaceRef(ref)).path, value(buildDir, 500)),
  'projectTools:gradleTasksCancel': (c, ref, buildDir) =>
    cancelGradleTasks(c.host.resolve(workspaceRef(ref)).path, value(buildDir, 500)),
  'projectTools:services': (c, ref) => c.tools.services.list(workspaceRef(ref)),
  'projectTools:saveService': (c, ref, input) => c.tools.services.save(workspaceRef(ref), input as ServiceInput),
  'projectTools:deleteService': (c, id) => c.tools.services.remove(value(id, 200, true)),
  'projectTools:startService': (c, id) => c.tools.services.start(value(id, 200, true)),
  'projectTools:stopService': (c, id, force) => c.tools.services.stop(value(id, 200, true), force === true),
  'projectTools:restartService': (c, id) => c.tools.services.restart(value(id, 200, true)),
  'projectTools:portStatus': (_c, port) => portStatus(Number(port)),
  // 产出检查（docs/ui/channels-collab-v2.md §8）：第一个参数是项目或会话，按它路由到所在的机器
  'projectTools:checkPlan': (c, ref) => c.tools.checks.plan(workspaceRef(ref)),
  'projectTools:saveCheckConfig': (c, ref, config) => {
    const r = workspaceRef(ref)
    return c.tools.checks.saveConfig(c.host.resolve(r).projectId, config)
  },
  'projectTools:runChecks': (c, ref, opts) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { files?: unknown; when?: unknown }
    const files = Array.isArray(o.files)
      ? o.files.filter((f): f is string => typeof f === 'string').slice(0, 500)
      : null
    return c.tools.checks.run(workspaceRef(ref), { files, when: o.when === 'channel' ? 'channel' : 'session' })
  },
  'projectTools:sessionChecks': (c, ref) => c.tools.checks.sessionEnabled(sessionOf(ref)),
  'projectTools:setSessionChecks': (c, ref, on) => c.tools.checks.setSession(sessionOf(ref), on === true),
  'projectTools:copies': (c, id) => c.tools.copies.list(value(id, 200, true)),
  'projectTools:branches': (c, id) => c.tools.copies.branches(value(id, 200, true)),
  'projectTools:previewCopy': (c, id, input) => c.tools.copies.preview(value(id, 200, true), input as CopyInput),
  'projectTools:createCopy': (c, id, input) => c.tools.copies.create(value(id, 200, true), input as CopyInput),
  'projectTools:openCopy': (c, id) => c.tools.copies.open(value(id, 200, true)),
  'projectTools:removeCopy': (c, id, force) => c.tools.copies.remove(value(id, 200, true), force === true),
  'projectTools:forgetCopy': (c, id) => c.tools.copies.forget(value(id, 200, true)),
  'projectTools:gitStatus': (c, ref, opts) => {
    const o = opts as { recheck?: unknown; stats?: unknown } | undefined
    return c.tools.git.status(workspaceRef(ref), false, o?.recheck === true, o?.stats === true)
  },
  'projectTools:gitDiff': (c, ref, input) =>
    c.tools.git.diff(workspaceRef(ref), input as Parameters<GitTools['diff']>[1]),
  'projectTools:gitBranches': (c, ref) => c.tools.git.branches(workspaceRef(ref)),
  'projectTools:gitStage': (c, ref, paths) => c.tools.git.stage(workspaceRef(ref), paths),
  'projectTools:gitUnstage': (c, ref, paths) => c.tools.git.unstage(workspaceRef(ref), paths),
  'projectTools:gitDiscard': (c, ref, input) => c.tools.git.discard(workspaceRef(ref), input),
  // 改动按模块分组、加入 .gitignore（docs/ui/git-panel.md §10）
  'projectTools:gitModules': (c, ref) => c.tools.git.modules(workspaceRef(ref)),
  'projectTools:gitIgnore': (c, ref, input) => c.tools.git.ignore(workspaceRef(ref), input),
  'projectTools:gitCommit': (c, ref, input) => c.tools.git.commit(workspaceRef(ref), input),
  'projectTools:gitCommitContext': (c, ref, input) => c.tools.git.commitContext(workspaceRef(ref), input),
  'projectTools:gitPull': (c, ref, mode) => c.tools.git.pull(workspaceRef(ref), mode),
  'projectTools:gitPush': (c, ref, input) => c.tools.git.push(workspaceRef(ref), input),
  'projectTools:gitFetch': (c, ref) => c.tools.git.fetch(workspaceRef(ref)),
  'projectTools:gitSwitch': (c, ref, input) => c.tools.git.switchBranch(workspaceRef(ref), input),
  'projectTools:gitCreateBranch': (c, ref, input) => c.tools.git.createBranch(workspaceRef(ref), input),
  'projectTools:gitOperation': (c, ref, action) => c.tools.git.operation(workspaceRef(ref), action),
  'projectTools:gitLog': (c, ref, query) => c.tools.git.log(workspaceRef(ref), query),
  'projectTools:gitRefs': (c, ref) => c.tools.git.refs(workspaceRef(ref)),
  'projectTools:gitShow': (c, ref, hash) => c.tools.git.show(workspaceRef(ref), hash),
  'projectTools:gitCompare': (c, ref, kind) => c.tools.git.compare(workspaceRef(ref), kind),
  'projectTools:gitHistoryAction': (c, ref, input) => c.tools.git.historyAction(workspaceRef(ref), input),
} satisfies OpTable<ToolsOpContext>

/**
 * 新建会话时可选的工作区：项目本身 + 它的 Git 副本（docs/ui/machines-workspaces.md）。
 * 列表只显示名称、路径、分支，所以只跑一条 `git worktree list`：项目和副本的分支、副本还在不在都从这里来，
 * 不再逐个跑 git status / rev-list（issue #11：每次打开都要等半秒以上，副本越多越慢）。
 */
export async function listWorkspaces(c: ToolsOpContext, projectId: string) {
  const target = c.host.resolve({ projectId })
  const trees = await gitWorktrees(target.path)
  /** 项目是这个工作树里的子目录 */
  const inside = (tree: GitWorktree) => {
    const rel = relative(tree.path, target.path)
    return !rel.startsWith('..') && !isAbsolute(rel)
  }
  const main = trees && (trees.find(t => samePath(t.path, target.path)) ?? trees.find(inside) ?? trees[0])
  const copies = trees ? c.tools.copies.store.data.copies.filter(copy => copy.projectId === projectId) : []
  return [
    { projectId, name: target.name, path: target.path, copyId: null, branch: main?.branch ?? null, error: null },
    ...copies.map(copy => {
      const tree = trees!.find(t => samePath(t.path, copy.path))
      return {
        projectId,
        name: copy.name,
        path: copy.path,
        copyId: copy.id,
        branch: tree?.branch ?? copy.branch,
        error: tree && !samePath(copy.path, target.path) ? null : '工作树不存在或不是 Git 工作树',
      }
    }),
  ]
}

/** 在选中的工作区里新建会话 */
export function openWorkspace(c: ToolsOpContext, choice: WorkspaceChoice) {
  if (choice.copyId) {
    const copy = c.tools.copies.get(choice.copyId)
    if (copy.projectId !== choice.projectId) throw new Error('副本不属于项目')
    return c.tools.copies.open(choice.copyId)
  }
  const target = c.host.resolve({ projectId: choice.projectId })
  return c.host.create(choice.projectId, target.path)
}
