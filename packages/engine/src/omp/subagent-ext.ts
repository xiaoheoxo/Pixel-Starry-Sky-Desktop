// oh-my-pi 子智能体的模型和思考深度（docs/omp-engine.md §18）：omp 按类型写死强度，不跟主会话。写一个扩展 -e 加载，
// 子智能体会把它再挂一份（同一个进程）：启动时向本机网关取这个类型现在的设置（设置 › 子智能体 › oh-my-pi），
// 换模型、定强度，再把实际用的报给宿主（卡片显示）。取不到时用启动时的快照，模型跟随主会话
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OMP_MODEL_FILL_SOURCE } from './model-fill'

/** 启动时的快照（JSON，OmpSubagentSnapshot）：宿主的 sessionEnv 给 */
export const OMP_SUBAGENTS_ENV = 'PIXELSKY_OMP_SUBAGENTS'
/** 网关地址和只能查子智能体设置的密钥（和像素星空命令行同一组，packages/cli/src/tools/subagent.ts） */
export const OMP_SUB_BASE_URL_ENV = 'PIXELSKY_PIXEL_SUB_BASE_URL'
export const OMP_SUB_TOKEN_ENV = 'PIXELSKY_SUBAGENT_OPTIONS_TOKEN'
/** 子智能体实际用的模型和强度，JSON：{ id, model, effort } */
export const OMP_SUB_STATUS = 'pixelsky-omp-sub'

export interface OmpSubagentSnapshot {
  /** 类型（* 是没列出来的）→ follow 跟随主会话 / pick 主模型按任务选 / omp 照 omp 自己的 / 固定的档位 */
  efforts: Record<string, string>
  /** pick 时主模型最高能选到的档 */
  maxEffort: string
}

/** 宿主给的快照；没有或不对返回 null */
export function ompSubagentSnapshot(env: NodeJS.ProcessEnv): OmpSubagentSnapshot | null {
  try {
    const o = JSON.parse(env[OMP_SUBAGENTS_ENV] ?? '') as OmpSubagentSnapshot
    return o && typeof o.efforts === 'object' && o.efforts ? o : null
  } catch {
    return null
  }
}

/** 有类型让主模型按任务选：要开 omp 的 task.enableEffort（只在启动时读） */
export const ompPicksEffort = (snapshot: OmpSubagentSnapshot | null): boolean =>
  !!snapshot && Object.values(snapshot.efforts).includes('pick')

export const OMP_SUBAGENT_SOURCE = `// 像素星空写的文件，每次启动会覆盖。子智能体的模型和思考深度（设置 › 子智能体 › oh-my-pi）
${OMP_MODEL_FILL_SOURCE}
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const ASK_TIMEOUT_MS = 5000

// 主智能体和子智能体各挂一份，整个进程共用。密钥读到就从环境里拿掉，模型跑的命令看不到
function load() {
  let snapshot = { efforts: {}, maxEffort: 'max' }
  try {
    snapshot = JSON.parse(process.env.${OMP_SUBAGENTS_ENV} || '') || snapshot
  } catch {}
  const root = (process.env.${OMP_SUB_BASE_URL_ENV} || '').replace(/\\/+$/, '')
  const token = process.env.${OMP_SUB_TOKEN_ENV} || ''
  delete process.env.${OMP_SUB_TOKEN_ENV}
  return {
    snapshot,
    root,
    token,
    // 启动时有没有开 task.enableEffort
    picks: Object.values(snapshot.efforts || {}).includes('pick'),
    main: null,
    ui: null,
    // 派出去还没启动的任务：{ text, picked 主模型选没选强度 }
    tasks: [],
    started: new Set(),
    keys: new Map(),
  }
}

export default function pixelskySubagents(pi) {
  const state = (globalThis.__pixelskyOmpSub ??= load())

  const ask = async body => {
    if (!state.root || !state.token) return null
    try {
      const res = await fetch(state.root + '/pixelsky/subagent-options', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
      })
      const omp = res.ok ? (await res.json()).omp : null
      return omp && omp.efforts ? omp : null
    } catch {
      return null
    }
  }
  // omp 会修剪任务文字首尾的空白
  const plain = text => String(text ?? '').replace(/\\s+/g, ' ').trim()
  const ruleOf = (settings, type) => settings.efforts[type] ?? settings.efforts['*'] ?? 'follow'

  // 派活：记下主模型给每个任务选的强度；不让它选的类型，填了的拿掉
  pi.on('tool_call', async event => {
    const input = event.input
    if (event.toolName !== 'task' || !state.picks || !input) return undefined
    const settings = (await ask({ omp: true })) ?? state.snapshot
    for (const task of Array.isArray(input.tasks) ? input.tasks : [input]) {
      if (!task || typeof task !== 'object') continue
      if (ruleOf(settings, task.agent || 'task') !== 'pick') delete task.effort
      else if (plain(task.task))
        state.tasks = [...state.tasks, { text: plain(task.task), picked: !!task.effort }].slice(-200)
    }
    return undefined
  })

  // 单独的线路：每把密钥注册成一个提供方
  const useRoute = async (ctx, { route, secret }) => {
    let n = state.keys.get(secret)
    if (!n) state.keys.set(secret, (n = state.keys.size + 1))
    const name = 'pixelsky-sub-' + n
    const chat = route.api === 'openai-completions'
    pi.registerProvider(name, {
      baseUrl: route.api === 'anthropic-messages' ? state.root : state.root + '/v1',
      api: route.api,
      apiKey: secret,
      models: [fillModel(route.api, { reasoning: !chat, input: chat ? ['text'] : ['text', 'image'], ...route.model })],
    })
    const model = ctx.modelRegistry.find(name, route.model.id)
    return !!model && (await pi.setModel(model)) !== false
  }

  pi.on('before_agent_start', async (_event, ctx) => {
    const agent = ctx.agent
    if (!agent || agent.kind === 'main') {
      state.main = pi
      state.ui = ctx.mode === 'rpc' ? ctx.ui : null
      return undefined
    }
    if (agent.kind !== 'sub') return undefined
    // 只在第一次开始时定；之后再叫它（插话、接着做、换了进程再叫醒）不改
    const id = ctx.sessionManager.getSessionFile?.() || agent.id
    const entries = ctx.sessionManager.getEntries()
    const init = entries.findIndex(e => e.type === 'session_init')
    if (init >= 0 && entries.slice(init).some(e => e.type === 'message' && e.message?.role === 'assistant')) return undefined
    if (state.started.has(id)) return undefined
    state.started.add(id)
    const reply = await ask({ omp: true, type: agent.name, spawn: true })
    const settings = reply ?? state.snapshot
    const rule = ruleOf(settings, agent.name)
    const before = pi.getThinkingLevel()
    let moved = false
    let problem = reply?.problem
    if (reply?.route && reply.secret) {
      try {
        moved = await useRoute(ctx, reply)
      } catch {}
      if (!moved) problem = 'oh-my-pi 没有换过去'
    }
    if (problem && state.ui)
      state.ui.notify('子智能体「' + agent.name + '」指定的模型用不了（' + problem + '），这次跟随对话的模型', 'warning')
    let level
    if (rule === 'pick') {
      // 一个任务的文字可能包着另一个的：取最长的，一样长的取后派的
      const text = plain(entries[init]?.task)
      const task = state.tasks
        .filter(t => text.includes(t.text))
        .reduce((best, t) => (best && best.text.length > t.text.length ? best : t), undefined)
      state.tasks = state.tasks.filter(t => t !== task)
      if (!task?.picked) level = state.main?.getThinkingLevel()
      else level = LEVELS.indexOf(before) > LEVELS.indexOf(settings.maxEffort) ? settings.maxEffort : before
    } else if (rule === 'follow') level = state.main?.getThinkingLevel()
    else if (rule !== 'omp') level = rule
    if (level) pi.setThinkingLevel(level)
    // 照 omp 自己的可能还要它自己判断（auto），这里说不准，跑完从它的会话文件读
    if (state.ui && level)
      state.ui.setStatus(
        ${JSON.stringify(OMP_SUB_STATUS)},
        JSON.stringify({ id: agent.id, model: ctx.model?.id ?? '', effort: pi.getThinkingLevel() }),
      )
    return undefined
  })
}
`

/** 写到 dir 下（内容一样就不写），返回文件路径 */
export function writeOmpSubagents(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'pixelsky-subagents.mjs')
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // 还没有
  }
  if (current !== OMP_SUBAGENT_SOURCE) writeFileSync(file, OMP_SUBAGENT_SOURCE)
  return file
}
