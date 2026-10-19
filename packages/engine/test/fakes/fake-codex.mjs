import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'
if (process.env.FAKE_CODEX_ARGV)
  appendFileSync(process.env.FAKE_CODEX_ARGV, JSON.stringify(process.argv.slice(2)) + '\n')
// codex logout：马上退出（账号额度测试用，确认退出登录后关掉只读进程）
if (process.argv[2] === 'logout') process.exit(0)
// 像真的 codex 一样拒绝不认识的参数（测试用 --fake-bad-arg）：stderr 报错后退出
if (process.argv.includes('--fake-bad-arg')) {
  process.stderr.write(
    "\x1b[1m\x1b[31merror:\x1b[0m unexpected argument '--fake-bad-arg' found\n\nUsage: codex app-server [OPTIONS]\n",
  )
  process.exit(2)
}
// 模拟不认得 default_mode_request_user_input 开关的 Codex（以后改名 / 去掉）：带了开关就起不来
if (process.env.FAKE_CODEX_REJECT_ASK && process.argv.includes('features.default_mode_request_user_input=true')) {
  process.stderr.write("error: unknown feature 'default_mode_request_user_input'\n")
  process.exit(2)
}
const out = value => process.stdout.write(JSON.stringify(value) + '\n')
const emit = (method, params) => out({ method, params })
const lockedThread = id => {
  const value = process.env.FAKE_CODEX_LOCKED
  return !!value && (value === '1' || value === '*' || value.split(',').includes(id))
}
/** 测试通过创建这个文件打开「恢复线程失败」开关：thread/resume 报错，thread/start 给新线程 id */
const resumeFails = () =>
  !!process.env.FAKE_CODEX_RESUME_FAIL_FILE && existsSync(process.env.FAKE_CODEX_RESUME_FAIL_FILE)
/**
 * 线程的轮次（回退 / 分叉测试用）：每个线程记 [{ id, clientId, content }]。
 * FAKE_CODEX_STATE_DIR 指向目录时落盘（threads.json），新进程能读到旧进程的线程；不设则只在本进程内存里。
 */
const stateFile = process.env.FAKE_CODEX_STATE_DIR ? join(process.env.FAKE_CODEX_STATE_DIR, 'threads.json') : null
let threads = {}
function loadThreads() {
  if (!stateFile) return
  try {
    threads = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    threads = {}
  }
}
function saveThreads() {
  if (!stateFile) return
  mkdirSync(process.env.FAKE_CODEX_STATE_DIR, { recursive: true })
  writeFileSync(stateFile, JSON.stringify(threads))
}
/**
 * 线程的元数据（thread/list、thread/read 用）：FAKE_CODEX_STATE_DIR/meta.json，
 * { 线程 id: { cwd, source, originator, name, preview, updatedAt, model, modelProvider, gitBranch, historyMode,
 * ephemeral?, parentThreadId?, path?, archived?, createdAt? } }；没有的字段按真 Codex 的形状补默认值。
 * 只读：测试在起进程前写好
 */
function loadMeta() {
  if (!process.env.FAKE_CODEX_STATE_DIR) return {}
  try {
    return JSON.parse(readFileSync(join(process.env.FAKE_CODEX_STATE_DIR, 'meta.json'), 'utf8'))
  } catch {
    return {}
  }
}
const textOf = content =>
  (Array.isArray(content) ? content : [])
    .filter(i => i.type === 'text')
    .map(i => i.text)
    .join('\n')
/**
 * 一轮的 Turn 对象；items 没给时只有一条 userMessage。view：full / summary（第一条用户消息和最后一条回复）/ notLoaded。
 * 形状和真 Codex 0.163.0 一致（实测）：summary 和 full 视图里 userMessage 的字段都是 type、id、clientId、content，
 * clientId 是发送方传的 clientUserMessageId（像素星空发的轮次有，终端里发的是 null）
 */
function turnObject(t, view) {
  const all = t.items ?? [{ type: 'userMessage', id: 'u-' + t.id, clientId: t.clientId ?? null, content: t.content }]
  let items = all
  if (view === 'notLoaded') items = []
  else if (view !== 'full') {
    const user = all.find(i => i.type === 'userMessage')
    const reply = [...all].reverse().find(i => i.type === 'agentMessage')
    items = [user, reply].filter(Boolean)
  }
  return {
    id: t.id,
    rootTurnId: null,
    items,
    itemsView: view === 'full' || view === 'notLoaded' ? view : 'summary',
    status: t.status ?? 'completed',
    error: t.error ?? null,
    startedAt: t.startedAt ?? null,
    completedAt: t.completedAt ?? null,
    durationMs: null,
  }
}
function threadObject(id, meta, list) {
  const first = list?.[0]
  const firstText = first ? textOf((first.items?.find(i => i.type === 'userMessage') ?? first).content) : ''
  return {
    id,
    sessionId: id,
    forkedFromId: meta.forkedFromId ?? null,
    parentThreadId: meta.parentThreadId ?? null,
    preview: meta.preview ?? firstText,
    ephemeral: !!meta.ephemeral,
    historyMode: meta.historyMode ?? 'paginated',
    modelProvider: meta.modelProvider ?? 'fake',
    model: meta.model ?? 'fake-codex',
    reasoningEffort: null,
    createdAt: meta.createdAt ?? meta.updatedAt ?? 0,
    updatedAt: meta.updatedAt ?? 0,
    status: { type: 'notLoaded' },
    path: meta.path ?? null,
    cwd: meta.cwd ?? process.cwd(),
    cliVersion: '0.160.1',
    originator: meta.originator ?? 'codex_cli_rs',
    source: meta.source ?? 'cli',
    gitInfo: meta.gitBranch ? { sha: null, branch: meta.gitBranch, originUrl: null } : null,
    name: meta.name ?? null,
    turns: [],
  }
}
const sourceKind = source => (typeof source === 'string' ? source : source?.subAgent ? 'subAgent' : 'unknown')
/** 记一轮：把 turn-N 的编号接在已有轮次之后，多个进程之间不重号 */
function recordTurn(clientId, content) {
  loadThreads()
  for (const list of Object.values(threads))
    for (const t of list) next = Math.max(next, Number(String(t.id).replace(/^turn-/, '')) || 0)
  const id = 'turn-' + ++next
  ;(threads[thread] ??= []).push({ id, clientId: clientId ?? null, content })
  saveThreads()
  return id
}
const rpcError = (m, message) => out({ id: m.id, error: { code: -32000, message } })
let initialized = false,
  thread = 'fake-thread',
  turn = null,
  next = 0,
  total = 0,
  pending = null
let approvalQueue = [],
  approvalIndex = 0
/** 协作模式像真 Codex 一样沿用到下一次 turn/start 带新的；Default 模式要开了开发中开关模型才有 request_user_input */
let collaborationMode = 'default'
const defaultModeAsk = process.argv.includes('features.default_mode_request_user_input=true')
/** thread/start、thread/resume 报的实际模型 / 推理强度 / 协作模式（FAKE_CODEX_RESUME_COLLAB 是 JSON，只有 resume 报）；不设就不报，和真 Codex 没配置时一样 */
const threadReport = resume => ({
  ...(process.env.FAKE_CODEX_THREAD_MODEL ? { model: process.env.FAKE_CODEX_THREAD_MODEL } : {}),
  ...(process.env.FAKE_CODEX_THREAD_EFFORT ? { reasoningEffort: process.env.FAKE_CODEX_THREAD_EFFORT } : {}),
  ...(resume && process.env.FAKE_CODEX_RESUME_COLLAB
    ? { collaborationMode: JSON.parse(process.env.FAKE_CODEX_RESUME_COLLAB) }
    : {}),
})
/** FAKE_CODEX_RATE_UPDATE：账号额度的滚动更新（account/rateLimits/updated，params.rateLimits 是这个 JSON，不带 threadId）；线程启动后、每轮开始时、每轮结束后（会话已空闲）各发一条 */
const rateUpdate = idle => {
  const json = (idle && process.env.FAKE_CODEX_RATE_UPDATE_IDLE) || process.env.FAKE_CODEX_RATE_UPDATE
  if (json) emit('account/rateLimits/updated', { rateLimits: JSON.parse(json) })
}
function nextApproval() {
  const request = approvalQueue[approvalIndex++]
  if (!request) return finish()
  out({
    id: 'approval-' + approvalIndex,
    method: request.method,
    params: { threadId: thread, turnId: turn.id, ...request.params },
  })
}
const models = [
  {
    id: 'fake-codex',
    model: 'fake-codex',
    displayName: 'Fake Codex',
    supportedReasoningEfforts: ['low', 'high', 'ultra'].map(reasoningEffort => ({ reasoningEffort })),
    defaultReasoningEffort: 'high',
    inputModalities: ['text', 'image'],
    isDefault: true,
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed, increased usage' }],
  },
  {
    id: 'fake-plain',
    model: 'fake-plain',
    displayName: 'Fake Plain',
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    defaultReasoningEffort: 'high',
    inputModalities: ['text'],
    isDefault: false,
  },
]
function finish(status = 'completed') {
  if (!turn) return
  const current = turn
  turn = null
  clearTimeout(current.timer)
  emit('item/completed', {
    threadId: thread,
    turnId: current.id,
    item: { type: 'agentMessage', id: current.item, text: current.text },
  })
  total += 100
  emit('thread/tokenUsage/updated', {
    threadId: thread,
    turnId: current.id,
    tokenUsage: {
      total: {
        inputTokens: total,
        cachedInputTokens: total / 2,
        cacheWriteInputTokens: 0,
        outputTokens: total / 10,
        totalTokens: total * 1.1,
      },
      last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10, totalTokens: 110 },
      modelContextWindow: 128000,
    },
  })
  emit('turn/completed', { threadId: thread, turn: { id: current.id, status, error: null } })
  // 一轮结束之后（会话已空闲）再来一条账号额度更新；FAKE_CODEX_RATE_UPDATE_IDLE 给了就发它
  rateUpdate(true)
}
function response(message, result) {
  out({ id: message.id, result })
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(m) + '\n')
  if (m.result && String(m.id).startsWith('approval-')) {
    if (m.result.decision === 'decline' || m.result.decision === 'cancel') finish('interrupted')
    else nextApproval()
    return
  }
  if (m.result && m.id === 'ask') {
    pending = null
    finish('completed')
    return
  }
  if (m.result && m.id === 'approve') {
    pending = null
    finish(m.result.decision === 'decline' ? 'interrupted' : 'completed')
    return
  }
  const p = m.params ?? {}
  if (m.method === 'initialize') {
    initialized = true
    response(m, { userAgent: 'fake codex 0.160.1' })
    return
  }
  if (m.method === 'initialized') return
  if (!initialized) {
    out({ id: m.id, error: { code: -32000, message: 'Not initialized' } })
    return
  }
  switch (m.method) {
    case 'account/rateLimits/read':
      // FAKE_CODEX_RATE_LIMITS：回包的 JSON（账号额度，docs/ui/account-quota.md）；FAKE_CODEX_RATE_LIMITS_ERROR 回错误；都不设回 fixtures 里的样本
      if (process.env.FAKE_CODEX_RATE_LIMITS_ERROR) rpcError(m, process.env.FAKE_CODEX_RATE_LIMITS_ERROR)
      else
        response(
          m,
          process.env.FAKE_CODEX_RATE_LIMITS
            ? JSON.parse(process.env.FAKE_CODEX_RATE_LIMITS)
            : JSON.parse(readFileSync(new URL('../fixtures/codex-rate-limits.json', import.meta.url), 'utf8')),
        )
      break
    case 'account/read':
      response(
        m,
        process.env.FAKE_CODEX_ACCOUNT
          ? JSON.parse(process.env.FAKE_CODEX_ACCOUNT)
          : { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
      )
      break
    case 'model/list':
      response(m, { data: models, nextCursor: null })
      break
    case 'config/read':
      response(m, {
        config: {
          ...(process.env.FAKE_CODEX_NO_MODEL ? {} : { model: 'fake-codex' }),
          model_provider: process.env.FAKE_CODEX_PROVIDER ?? 'fake',
          windows: { sandbox: 'elevated' },
        },
        // includeLayers 时：命令行 -c 在 sessionFlags 层；FAKE_CODEX_USER_ASK 模拟用户 config.toml 里也开了同一个功能
        ...(p.includeLayers
          ? {
              layers: [
                {
                  name: { type: 'sessionFlags' },
                  config: defaultModeAsk ? { features: { default_mode_request_user_input: true } } : {},
                },
                {
                  name: { type: 'user', file: 'config.toml' },
                  config: process.env.FAKE_CODEX_USER_ASK
                    ? { features: { default_mode_request_user_input: true } }
                    : {},
                },
              ],
            }
          : {}),
      })
      break
    case 'configRequirements/read':
      response(m, { requirements: null })
      break
    case 'skills/list':
      response(m, {
        data: [
          {
            cwd: process.cwd(),
            skills: [
              { name: 'probe-skill', description: 'Original skill', path: process.cwd() + '/SKILL.md', enabled: true },
            ],
          },
        ],
      })
      break
    case 'thread/start':
    case 'thread/resume':
      // FAKE_CODEX_LOCKED：另一个进程正写着这个线程（终端里的 codex）。逗号分隔的线程 id；'1' 或 '*' 是所有线程
      if (m.method === 'thread/resume' && lockedThread(p.threadId)) {
        out({ id: m.id, error: { code: -32000, message: 'thread ' + p.threadId + ' already has an active writer' } })
        break
      }
      if (m.method === 'thread/resume' && resumeFails()) {
        out({ id: m.id, error: { code: -32000, message: 'thread not found: ' + p.threadId } })
        break
      }
      loadThreads()
      if (m.method === 'thread/resume' && stateFile && !threads[p.threadId]) {
        rpcError(m, 'thread not found: ' + p.threadId)
        break
      }
      if (m.method === 'thread/start' && stateFile) {
        // 开了落盘时每个新线程一个新 id，测试能分清「接着原线程」和「开了新线程」
        const n = Object.keys(threads).length
        thread = n ? 'fake-thread-' + (n + 1) : 'fake-thread'
        threads[thread] = []
        saveThreads()
      } else thread = p.threadId ?? (resumeFails() ? 'fake-thread-new' : 'fake-thread')
      response(m, { thread: { id: thread, turns: [] }, ...threadReport(m.method === 'thread/resume') })
      rateUpdate()
      break
    case 'thread/fork': {
      loadThreads()
      const source = threads[p.threadId]
      const at = p.lastTurnId ? source?.findIndex(t => t.id === p.lastTurnId) : source ? source.length - 1 : -1
      if (!source || at < 0) {
        rpcError(m, 'cannot fork: ' + p.threadId + ' @ ' + p.lastTurnId)
        break
      }
      thread = 'fake-fork-' + (Object.keys(threads).length + 1)
      threads[thread] = source.slice(0, at + 1)
      saveThreads()
      response(m, { thread: { id: thread, turns: [] }, model: 'fake-codex' })
      break
    }
    case 'thread/revert': {
      loadThreads()
      const list = threads[p.threadId]
      const at = list ? list.findIndex(t => t.id === p.beforeTurnId) : -1
      if (at < 0) {
        rpcError(m, 'turn not found: ' + p.beforeTurnId)
        break
      }
      threads[p.threadId] = list.slice(0, at)
      saveThreads()
      response(m, { thread: { id: p.threadId, turns: [] } })
      break
    }
    case 'thread/turns/list': {
      loadThreads()
      const list = threads[p.threadId]
      if (!list) {
        if (loadMeta()[p.threadId]) {
          response(m, { data: [], nextCursor: null, backwardsCursor: null })
          break
        }
        out({ id: m.id, error: { code: -32600, message: 'thread not loaded: ' + p.threadId } })
        break
      }
      // 真 Codex：sortDirection 默认 desc、itemsView 默认 summary、游标不透明（这里是已翻过的轮数）。
      // 没传 limit 时按 FAKE_CODEX_PAGE 或一页读完
      const size = Number(p.limit) || Number(process.env.FAKE_CODEX_PAGE) || list.length || 1
      const start = Number(p.cursor) || 0
      const ordered = p.sortDirection === 'asc' ? list : [...list].reverse()
      const page = ordered.slice(start, start + size)
      response(m, {
        data: page.map(t => turnObject(t, p.itemsView)),
        nextCursor: start + size < list.length ? String(start + size) : null,
        backwardsCursor: null,
      })
      break
    }
    case 'thread/list': {
      const meta = loadMeta()
      loadThreads()
      const providers = Array.isArray(p.modelProviders) ? p.modelProviders : ['fake']
      const kinds = Array.isArray(p.sourceKinds) && p.sourceKinds.length ? p.sourceKinds : ['cli', 'vscode']
      const cwds = p.cwd == null ? null : Array.isArray(p.cwd) ? p.cwd : [p.cwd]
      const rows = Object.entries(meta)
        .filter(([, t]) => !providers.length || providers.includes(t.modelProvider ?? 'fake'))
        .filter(([, t]) => kinds.includes(sourceKind(t.source ?? 'cli')))
        .filter(([, t]) => !!t.archived === (p.archived === true))
        .filter(([, t]) => !cwds || cwds.includes(t.cwd))
        .sort((a, b) => (b[1].updatedAt ?? 0) - (a[1].updatedAt ?? 0) || (a[0] < b[0] ? -1 : 1))
      if (p.sortDirection === 'asc') rows.reverse()
      const size = Number(p.limit) || rows.length || 1
      const start = Number(p.cursor) || 0
      response(m, {
        data: rows.slice(start, start + size).map(([id, t]) => threadObject(id, t, threads[id])),
        nextCursor: start + size < rows.length ? String(start + size) : null,
        backwardsCursor: null,
      })
      break
    }
    case 'thread/read': {
      const meta = loadMeta()
      loadThreads()
      if (!meta[p.threadId] && !threads[p.threadId]) {
        out({ id: m.id, error: { code: -32600, message: 'thread not loaded: ' + p.threadId } })
        break
      }
      const list = threads[p.threadId]
      const thread = threadObject(p.threadId, meta[p.threadId] ?? {}, list)
      if (p.includeTurns) thread.turns = (list ?? []).map(t => turnObject(t, 'full'))
      response(m, { thread })
      break
    }
    case 'turn/start': {
      // 测试创建这个文件让下一次 turn/start 被拒绝（一次性）：模拟 Codex 回错，这一轮没开成
      if (process.env.FAKE_CODEX_TURN_FAIL_FILE && existsSync(process.env.FAKE_CODEX_TURN_FAIL_FILE)) {
        rmSync(process.env.FAKE_CODEX_TURN_FAIL_FILE)
        rpcError(m, 'turn rejected')
        break
      }
      const id = recordTurn(p.clientUserMessageId, p.input),
        text = p.input
          .filter(i => i.type === 'text')
          .map(i => i.text)
          .join('\n')
      if (text.includes('延迟')) {
        // turn/start 的响应晚到：期间不推送任何通知，模拟开轮途中就点了停止
        turn = { id, item: 'msg-' + next, text: '收到：' + text, timer: null, slow: false }
        setTimeout(() => {
          emit('turn/started', { threadId: thread, turn: { id, status: 'inProgress' } })
          response(m, { turn: { id, status: 'inProgress' } })
        }, 400)
        break
      }
      // 缓停：收到 turn/interrupt 后约 1 秒才回 interrupted，且不会自己结束
      turn = { id, item: 'msg-' + next, text: '收到：' + text, timer: null, slow: text.includes('缓停') }
      emit('turn/started', { threadId: thread, turn: { id, status: 'inProgress' } })
      if (process.env.FAKE_CODEX_IMAGE_PATH) {
        const item = { type: 'imageView', id: 'view-image-' + next, path: process.env.FAKE_CODEX_IMAGE_PATH }
        emit('item/started', { threadId: thread, turnId: id, item })
        emit('item/completed', { threadId: thread, turnId: id, item })
      }
      emit('item/started', {
        threadId: thread,
        turnId: id,
        item: { type: 'userMessage', id: 'u-' + next, clientId: p.clientUserMessageId, content: p.input },
      })
      if (text.includes('换模型')) {
        // 被换了模型，接着断线重连一次，然后照常回复
        emit('model/rerouted', {
          threadId: thread,
          turnId: id,
          fromModel: 'fake-codex',
          toModel: 'fake-codex-safe',
          reason: 'highRiskCyberActivity',
        })
        emit('error', {
          threadId: thread,
          turnId: id,
          willRetry: true,
          error: {
            message: 'Reconnecting... 1/5',
            additionalDetails: 'stream disconnected before completion: error decoding response body',
            codexErrorInfo: null,
          },
        })
      }
      emit('item/started', { threadId: thread, turnId: id, item: { type: 'agentMessage', id: turn.item, text: '' } })
      emit('item/agentMessage/delta', { threadId: thread, turnId: id, itemId: turn.item, delta: turn.text })
      response(m, { turn: { id, status: 'inProgress' } })
      rateUpdate()
      if (text.includes('警告')) {
        // 用户 config.toml 引起的警告（每轮都发）和一条真正的警告；不带线程和轮次，和真 Codex 一样
        emit('warning', {
          message:
            'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
            '  user (C:\\Users\\x\\.codex\\config.toml): `disable_response_storage` is ignored.',
        })
        emit('warning', {
          message:
            'Under-development features enabled: local_thread_store_compaction. To suppress this warning, set `suppress_unstable_features_warning = true`.',
        })
        emit('warning', { message: 'Model metadata for `fake-model` not found.' })
      }
      if (process.env.FAKE_CODEX_ASK_WARNING) {
        // 开关带来的警告，和真 Codex 一样只在功能真开着时才报；换行开头、旧版 Codex 不认得开关等写法见各取值
        const kind = process.env.FAKE_CODEX_ASK_WARNING,
          tail = ' Under-development features are incomplete and may behave unpredictably.'
        if (kind === 'ignored') {
          if (defaultModeAsk)
            emit('warning', {
              message:
                'Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings.\n' +
                '  session-flags: `features.default_mode_request_user_input` is ignored.',
            })
        } else if (kind === 'ignored-mixed') {
          if (defaultModeAsk)
            emit('warning', {
              message:
                'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
                '  session-flags: `features.default_mode_request_user_input` is ignored.\n' +
                '  user (config.toml): `disable_response_storage` is ignored.',
            })
        } else if (defaultModeAsk || process.env.FAKE_CODEX_USER_ASK)
          emit('warning', {
            message:
              (kind === 'features-newline' ? '\n' : '') +
              'Under-development features enabled: default_mode_request_user_input.' +
              tail,
          })
      }
      if (text.includes('崩溃')) {
        process.exit(3)
        return
      }
      if (text.includes('重连')) {
        const err = n => ({
          message: `Reconnecting... ${n}/2`,
          additionalDetails:
            'stream disconnected before completion: error sending request for url (https://api.example.test/v1/responses)',
          codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        })
        emit('error', { threadId: thread, turnId: id, willRetry: true, error: err(1) })
        emit('error', { threadId: thread, turnId: id, willRetry: true, error: err(2) })
        const current = turn
        turn = null
        emit('turn/completed', {
          threadId: thread,
          turn: {
            id: current.id,
            status: 'failed',
            error: {
              message: 'exceeded retry limit, last status: 502 Bad Gateway',
              additionalDetails: 'upstream connect error',
              codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 502 } },
            },
          },
        })
        return
      }
      if (p.collaborationMode?.mode) collaborationMode = p.collaborationMode.mode
      if (text.includes('提问') && (collaborationMode === 'plan' || defaultModeAsk)) {
        // 计划协作模式下模型才有 request_user_input；开了 default_mode_request_user_input 时 Default 模式也有
        pending = 'ask'
        out({
          id: 'ask',
          method: 'item/tool/requestUserInput',
          params: {
            threadId: thread,
            turnId: id,
            itemId: 'ask-1',
            questions: [
              {
                id: 'scope',
                header: '范围',
                question: '先做哪一批？',
                isOther: true,
                options: [
                  { label: '只做收尾（推荐）', description: '行为问题单列' },
                  { label: '先补测试', description: '确认后修复' },
                ],
              },
            ],
          },
        })
        return
      }
      if (text.includes('连续审批')) {
        approvalQueue = [
          { method: 'item/commandExecution/requestApproval', params: { command: 'echo first' } },
          {
            method: 'item/commandExecution/requestApproval',
            params: { command: 'npm test', threadId: 'fake-sub-thread', turnId: 'sub-turn' },
          },
          { method: 'item/fileChange/requestApproval', params: { changes: [] } },
          { method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } },
          {
            method: 'item/tool/requestUserInput',
            params: {
              questions: [{ id: 'choice', question: 'Choose a name', header: '', options: [], isOther: true }],
            },
          },
          {
            method: 'mcpServer/elicitation/request',
            params: { serverName: 'test', requestedSchema: { type: 'object' } },
          },
        ]
        approvalIndex = 0
        nextApproval()
        return
      }
      if (text.includes('子智能体审批')) {
        // 子智能体在自己的线程和轮次里请求审批
        pending = 'approve'
        out({
          id: 'approve',
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'fake-sub-thread', turnId: 'sub-turn-1', itemId: 'sub-cmd', command: 'npm test' },
        })
        return
      }
      if (text.includes('审批')) {
        pending = 'approve'
        out({
          id: 'approve',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: thread,
            turnId: id,
            itemId: 'cmd-1',
            command: 'echo test',
            reason: 'Test approval',
            ...(process.env.FAKE_CODEX_DECISIONS
              ? { availableDecisions: JSON.parse(process.env.FAKE_CODEX_DECISIONS) }
              : {}),
          },
        })
        return
      }
      if (!turn.slow) turn.timer = setTimeout(() => finish(), text.includes('慢') ? 1800 : 50)
      break
    }
    case 'turn/steer':
      if (!turn || turn.id !== p.expectedTurnId) {
        out({ id: m.id, error: { code: -32000, message: 'turn mismatch' } })
        break
      }
      emit('item/started', {
        threadId: thread,
        turnId: turn.id,
        item: { type: 'userMessage', id: 'steer-' + next, clientId: p.clientUserMessageId, content: p.input },
      })
      turn.text +=
        ' ' +
        p.input
          .filter(i => i.type === 'text')
          .map(i => i.text)
          .join(' ')
      response(m, { turnId: turn.id })
      break
    case 'turn/interrupt': {
      response(m, {})
      const current = turn
      if (current?.slow) setTimeout(() => turn === current && finish('interrupted'), 1000)
      else finish('interrupted')
      break
    }
    case 'thread/inject_items':
      // FAKE_CODEX_INJECT_FAIL：模拟旧版 Codex 没有这个方法，接力退回文字交接
      if (process.env.FAKE_CODEX_INJECT_FAIL) out({ id: m.id, error: { code: -32601, message: 'Unknown method' } })
      else response(m, {})
      break
    case 'thread/compact/start':
      turn = { id: 'compact-' + ++next, item: 'compact-item-' + next, text: 'Compacted', timer: null }
      emit('turn/started', { threadId: thread, turn: { id: turn.id, status: 'inProgress' } })
      emit('item/started', { threadId: thread, turnId: turn.id, item: { type: 'contextCompaction', id: turn.item } })
      response(m, {})
      setTimeout(() => finish(), 50)
      break
    default:
      out({ id: m.id, error: { code: -32601, message: 'Unknown method ' + m.method } })
  }
})
process.stdin.on('end', () => process.exit(0))
