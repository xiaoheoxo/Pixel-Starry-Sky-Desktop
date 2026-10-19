// 引擎接口（docs/engines.md §3、§5）：本机与远端共用的操作表，参数先校验再交给 EngineHost。
// 「添加项目」（本机弹对话框）和「导出用量」（本机弹保存框）不在表里，见 engine/ipc.ts / machines/remote-runtime.ts
import { searchQuery, type EngineHost } from '@pixelsky/engine'
import type {
  ApprovalDecision,
  InterruptOptions,
  QueueMove,
  RewindOptions,
  SessionRecord,
  SessionSettings,
  SideTurn,
} from '@pixelsky/protocol'
import type { SessionPatch } from '../../../shared/types/engine'
import { artifactRef, engineConfigPatch, engineId, int, mcpOp, str, usageListQuery, usageQuery, value } from '../args'
import type { OpTable } from '../ops'
import type { ToolsHost } from '../project-tools/common'
import type { SearchRegistry } from '../search-registry'
import { workspaceRef } from '../workspace-files'
import { readArtifact } from '../artifact-files'
import { itemDetail, sessionTail, tailOptions } from './tail'

export interface EngineOpContext {
  host: EngineHost
  /** 调用方：搜索 / 产物扫描按它分桶（本机是窗口，远端是桌面端） */
  owner: string
  searches: SearchRegistry
  scans: SearchRegistry
  tools: ToolsHost
  /** 新会话绑定到副本时取副本路径；项目工具还没初始化时返回 undefined */
  copyPath(projectId: string, copyId: string): Promise<string | undefined>
  /** 修改会话设置之前（远端：先向桌面端取平台环境变量） */
  beforeUpdate?(record: SessionRecord): Promise<void>
}

/** 回退选项；旧调用方不传时只回退对话 */
function rewindOptions(raw: unknown): RewindOptions {
  if (raw === undefined) return { conversation: true, code: false }
  const o = (raw ?? {}) as Record<string, unknown>
  return { conversation: o.conversation === true, code: o.code === true }
}

/** 队列调序目标：有限数字是旧版手机的「挪到第几位」；{ before: 非空消息 id | null } 是新形态；别的一律报参数错误，不悄悄当成第 0 位 */
export function queueMove(raw: unknown): QueueMove {
  if (typeof raw === 'number' && Number.isFinite(raw)) return int(raw, 0, 100_000)
  if (typeof raw === 'object' && raw !== null && 'before' in raw) {
    const before = (raw as { before: unknown }).before
    if (before === null) return { before: null }
    if (typeof before === 'string' && before) return { before }
  }
  throw new Error('参数错误：queueMove 目标必须是数字或 { before: 消息 id | null }')
}

function interruptOptions(raw: unknown): InterruptOptions {
  return (raw as { background?: unknown } | null)?.background === true ? { background: true } : {}
}

/** 旁聊之前的问答：最多 20 轮，每段最多 20000 字 */
function sideHistory(raw: unknown): SideTurn[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(-20).flatMap(t => {
    const o = (t ?? {}) as Record<string, unknown>
    return typeof o.question === 'string' && typeof o.answer === 'string'
      ? [{ question: o.question.slice(0, 20_000), answer: o.answer.slice(0, 20_000) }]
      : []
  })
}

/** 导入引擎自己的会话时新对话用的设置：逐个挑字段，别的一律丢掉（本机和远端共用） */
function nativeImportOptions(raw: unknown): {
  mode: 'inplace' | 'copy'
  settings: Partial<SessionSettings>
  token?: string
} {
  const o = (raw ?? {}) as Record<string, unknown>
  const s = (o.settings ?? {}) as Record<string, unknown>
  const settings: Partial<SessionSettings> = {}
  if (typeof s.model === 'string' || s.model === null) settings.model = s.model
  if (s.platform && typeof s.platform === 'object') settings.platform = s.platform as SessionSettings['platform']
  else if (s.platform === null) settings.platform = null
  if (s.provider && typeof s.provider === 'object') settings.provider = s.provider as SessionSettings['provider']
  else if (s.provider === null) settings.provider = null
  if (typeof s.effort === 'string' || s.effort === null) settings.effort = s.effort as SessionSettings['effort']
  if (typeof s.permissionMode === 'string')
    settings.permissionMode = s.permissionMode as SessionSettings['permissionMode']
  if (typeof s.ultracode === 'boolean') settings.ultracode = s.ultracode
  if (typeof s.fast === 'boolean') settings.fast = s.fast
  if (typeof s.thinkingSummaries === 'boolean') settings.thinkingSummaries = s.thinkingSummaries
  return {
    mode: o.mode === 'copy' ? 'copy' : 'inplace',
    settings,
    ...(typeof o.token === 'string' && o.token ? { token: o.token } : {}),
  }
}

const MODE_LABEL: Record<string, string> = { ask: '每步问我', edits: '自动改文件', plan: '只规划', full: '完全放行' }

/** 手机改了会话设置时留在会话里的那句话（只写真的变了的项）；都没变时返回 null */
export function mobileChangeNotice(before: SessionRecord | null, patch: SessionPatch): string | null {
  const parts: string[] = []
  const changed = <K extends 'permissionMode' | 'model' | 'effort' | 'thinkingSummaries'>(key: K): boolean =>
    patch[key] !== undefined && (!before || patch[key] !== before[key])
  if (changed('permissionMode'))
    parts.push(`模式改成了「${MODE_LABEL[patch.permissionMode!] ?? patch.permissionMode}」`)
  if (changed('model')) parts.push(`模型改成了「${patch.model ?? '引擎默认'}」`)
  if (changed('effort')) parts.push(`强度改成了「${patch.effort ?? '引擎默认'}」`)
  if (changed('thinkingSummaries')) parts.push(`思考摘要改成了「${patch.thinkingSummaries ? '开' : '关'}」`)
  return parts.length ? `手机把${parts.join('，把')}` : null
}

const SEARCH_CANCELLED = { results: [], cancelled: true, truncated: false, partial: false, sessionCount: 0 }
const SCAN_CANCELLED = { turns: [], delivered: [], outsideCount: 0, truncated: false, partial: false, cancelled: true }

export const ENGINE_OPS = {
  'engine:engines': (c, force) => c.host.engines(force === true, force === true),
  'engine:search': (c, raw) => {
    const q = searchQuery(raw)
    return c.searches.begin(
      c.owner,
      q.requestId,
      signal => c.host.search(q, signal),
      () => ({ requestId: q.requestId, ...SEARCH_CANCELLED }),
    )
  },
  'engine:cancelSearch': (c, id) => c.searches.cancel(c.owner, id),
  // 产物面板（docs/ui/artifacts-panel.md §5）：工作区按会话 / 项目解析，不信任调用方传来的路径
  'engine:artifacts': (c, input) => {
    const v = (input ?? {}) as { requestId?: unknown; sessionId?: unknown; projectId?: unknown; days?: unknown }
    const target = c.tools.resolve(workspaceRef(v.sessionId ? { sessionId: v.sessionId } : { projectId: v.projectId }))
    const requestId = Number(v.requestId)
    return c.scans.begin(
      c.owner,
      requestId,
      signal => c.host.artifacts({ requestId, projectId: target.projectId, days: v.days }, target.path, signal),
      () => ({ requestId, ...SCAN_CANCELLED }),
    )
  },
  'engine:artifactChange': (c, input) => {
    const v = artifactRef(input)
    return c.host.artifactItem(v.sessionId, str(v.itemId, 'itemId'))
  },
  'engine:artifactRead': async (c, input) => {
    const v = artifactRef(input)
    if (!(await c.host.recordedPath(v.sessionId, v.path))) throw new Error('只能打开 AI 改动记录里的文件')
    return readArtifact(v.path)
  },
  'engine:defaults': c => c.host.defaults(),
  'engine:config': c => c.host.engineConfig(),
  'engine:setConfig': (c, engine, patch) => c.host.setEngineConfig(engineId(engine), engineConfigPatch(patch)),
  'engine:setDefaultEngine': (c, engine) => c.host.setDefaultEngine(engineId(engine)),
  'engine:catalog': (c, engine, force) => c.host.engineCatalog(engineId(engine), force === true),
  'engine:update': (c, engine) => c.host.updateEngine(engineId(engine)),
  'engine:install': (c, engine) => c.host.installEngine(engineId(engine)),
  'engine:login': (c, engine, method) => {
    if (method !== undefined && method !== 'browser' && method !== 'device') throw new Error('登录方式不对')
    return c.host.loginEngine(engineId(engine), method)
  },
  'engine:loginInput': (c, engine, text) => {
    if (typeof text !== 'string' || text.length > 4096) throw new Error('授权码不对')
    return c.host.loginInput(engineId(engine), text)
  },
  'engine:loginCancel': (c, engine) => c.host.cancelLogin(engineId(engine)),
  'engine:logout': (c, engine) => c.host.logoutEngine(engineId(engine)),
  'engine:retrySettings': c => c.host.retrySettings(),
  'engine:setRetrySettings': (c, maxRetries) => c.host.setRetrySettings(maxRetries as number),
  'engine:projects': c => c.host.projects(),
  'engine:removeProject': (c, id) => c.host.removeProject(str(id, 'id')),
  'engine:renameProject': (c, id, name) => c.host.renameProject(str(id, 'id'), name as string),
  'engine:setProjectFolders': (c, id, folders) => c.host.setProjectFolders(str(id, 'id'), folders),
  'engine:sessions': c => c.host.sessions(),
  'engine:createSession': async (c, opts) => {
    const o = (opts ?? {}) as Parameters<EngineHost['createSession']>[0] & {
      copyId?: string | null
      workspaceSessionId?: string
    }
    const origin = o.workspaceSessionId ? c.host.record(o.workspaceSessionId) : null
    if (o.workspaceSessionId && origin?.projectId !== o.projectId) throw new Error('工作区不属于项目')
    const cwd = o.copyId ? await c.copyPath(o.projectId, o.copyId) : origin?.cwd
    if (o.copyId && !cwd) throw new Error('副本不存在')
    return c.host.createSession({ ...o, projectId: str(o.projectId, 'projectId') }, cwd)
  },
  'engine:openSession': (c, id) => c.host.openSession(str(id, 'id')),
  // 手机端（docs/mobile-remote.md §5.2）：只取最后一段条目，点开某一条时再取完整内容
  'engine:openSessionTail': (c, id, opts) => sessionTail(c.host.openSession(str(id, 'id')), tailOptions(opts)),
  'engine:itemDetail': (c, id, itemId) => itemDetail(c.host.open(str(id, 'id')), str(itemId, 'itemId')),
  'engine:send': (c, id, input) => c.host.send(str(id, 'id'), input as Parameters<EngineHost['send']>[1]),
  'engine:context': (c, id, detail) => c.host.inspectContext(str(id, 'id'), detail === 'summary' ? 'summary' : 'full'),
  'engine:compact': (c, id) => c.host.compactContext(str(id, 'id')),
  'engine:cancelQueued': (c, id, q) => c.host.cancelQueued(str(id, 'id'), str(q, 'queueId')),
  'engine:dismissQueued': (c, id, q) => c.host.dismissQueued(str(id, 'id'), str(q, 'queueId')),
  'engine:moveQueued': (c, id, q, to) => c.host.moveQueued(str(id, 'id'), str(q, 'queueId'), queueMove(to)),
  'engine:runQueuedNow': (c, id, q) => c.host.runQueuedNow(str(id, 'id'), str(q, 'queueId')),
  'engine:steerQueued': (c, id, q, turn) => c.host.steerQueued(str(id, 'id'), str(q, 'queueId'), str(turn, 'turnId')),
  'engine:resumeQueue': (c, id) => c.host.resumeQueue(str(id, 'id')),
  'engine:rewindPreview': (c, id, itemId) => c.host.rewindPreview(str(id, 'id'), str(itemId, 'itemId')),
  'engine:rewind': (c, id, itemId, raw) => c.host.rewind(str(id, 'id'), str(itemId, 'itemId'), rewindOptions(raw)),
  'engine:undoRewind': (c, id) => c.host.undoRewind(str(id, 'id')),
  // 接着引擎自己留下的会话（终端里的 Claude Code，docs/ui/claude-resume.md）
  'engine:nativeSessions': (c, projectId, engine, opts) =>
    c.host.nativeSessions(str(projectId, 'projectId'), engineId(engine), {
      subfolders: (opts as { subfolders?: unknown } | null)?.subfolders !== false,
    }),
  'engine:nativeSessionDetails': (c, projectId, engine, ids) =>
    c.host.nativeSessionDetails(str(projectId, 'projectId'), engineId(engine), ids),
  'engine:importNativeSession': (c, projectId, engine, nativeId, opts) =>
    c.host.importNativeSession(
      str(projectId, 'projectId'),
      engineId(engine),
      str(nativeId, 'id'),
      nativeImportOptions(opts),
    ),
  'engine:cancelNativeImport': (c, token) => c.host.cancelNativeImport(str(token, 'token')),
  'engine:nativeSessionAction': (c, id, kind) => c.host.nativeSessionAction(str(id, 'id'), kind),
  'engine:fork': (c, id, itemId, title) =>
    c.host.forkSession(str(id, 'id'), str(itemId, 'itemId'), typeof title === 'string' ? title : undefined),
  'engine:sideQuestion': (c, id, question, history) =>
    c.host.sideQuestion(str(id, 'id'), str(question, 'question'), sideHistory(history)),
  'engine:cancelSideQuestion': (c, id) => c.host.cancelSideQuestion(str(id, 'id')),
  'engine:interrupt': (c, id, opts) => c.host.interrupt(str(id, 'id'), interruptOptions(opts)),
  'engine:interruptTurn': (c, id, turnId) => c.host.interruptTurn(str(id, 'id'), str(turnId, 'turnId')),
  'engine:answer': (c, id, requestId, decision) =>
    c.host.answer(str(id, 'id'), str(requestId, 'requestId'), decision as ApprovalDecision),
  // 第三个参数 via 可省略：'mobile' 表示是手机改的，会话里留一条看得见的记录（docs/mobile-remote.md §21.7）；
  // 记录的文字由这里按改动算出来，不信任调用方给的文字。旧版远端不认第三个参数，忽略就是了
  'engine:updateSession': async (c, id, raw, via?: unknown) => {
    const sessionId = str(id, 'id'),
      patch = (raw ?? {}) as SessionPatch,
      before = c.host.record(sessionId)
    if (c.beforeUpdate && before) await c.beforeUpdate({ ...before, ...patch })
    const record = await c.host.update(sessionId, patch)
    const text = via === 'mobile' ? mobileChangeNotice(before, patch) : null
    if (text) c.host.addNotice(sessionId, 'warn', text)
    return record
  },
  'engine:deleteSession': (c, id) => c.host.deleteSession(str(id, 'id')),
  'engine:renameSession': (c, id, title) => c.host.renameSession(str(id, 'id'), title as string),
  'engine:setSessionBottom': (c, id, bottomed) => {
    if (typeof bottomed !== 'boolean') throw new Error('置底值不正确')
    return c.host.setSessionBottom(str(id, 'id'), bottomed)
  },
  'engine:setSessionPinned': (c, id, pinned) => {
    if (typeof pinned !== 'boolean') throw new Error('置顶值不正确')
    return c.host.setSessionPinned(str(id, 'id'), pinned)
  },
  'engine:archiveSession': (c, id, archived, stopRunning) => {
    if (typeof archived !== 'boolean') throw new Error('归档值不正确')
    return c.host.archiveSession(str(id, 'id'), archived, stopRunning === true)
  },
  'engine:stopTask': (c, id, taskId) => c.host.stopTask(str(id, 'id'), str(taskId, 'taskId')),
  // 右侧「连接器」（docs/ui/connectors.md）
  'engine:mcp': (c, id, op) => c.host.mcp(str(id, 'id'), mcpOp(op)),
  'engine:taskOutput': (c, id, taskId) => c.host.taskOutput(str(id, 'id'), str(taskId, 'taskId')),
  'engine:subagentTranscript': (c, id, agentId) => c.host.subagentTranscript(str(id, 'id'), str(agentId, 'agentId')),
  // 用量与调用记录（docs/ui/usage.md §6.3）
  'engine:usageSummary': (c, q) => c.host.usageSummary(usageQuery(q)),
  'engine:usageList': (c, q) => c.host.usageList(usageListQuery(q)),
  'engine:usageClear': c => c.host.usageClear(),
} satisfies OpTable<EngineOpContext>

/** 按路径添加项目（远端，以及本机「机器」页的添加）；本机工作台的「添加项目」先弹选择文件夹对话框 */
export function addProjectPath(host: EngineHost, path: unknown) {
  return host.addProject(value(path, 4096, true))
}

/** 一次按路径添加多个项目（「从一个文件夹导入」、把文件夹拖到侧栏，docs/ui/multi-root-projects.md §2） */
export function addProjectPaths(host: EngineHost, paths: unknown) {
  if (!Array.isArray(paths) || paths.length > 500) throw new Error('项目路径不对')
  return host.addProjects(paths.map(path => value(path, 4096, true)))
}

/** 导出用量的 CSV 内容；保存到哪里由本机决定 */
export function usageCsv(host: EngineHost, q: unknown): string {
  return host.usageCsv(usageQuery(q))
}
