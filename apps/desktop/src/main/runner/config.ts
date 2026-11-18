// 执行机的配置（docs/multica-learn.md §11.7）：桌面经 SSH 写 config.json，执行机读的时候整理一遍再用。
// 不导入 electron（打进 helper.cjs）。
import { isAbsolute } from 'node:path'
import { cleanTeammate, type AgentConfig } from '../../shared/types/channels'
import type { RunnerConfig, RunnerMember } from '../../shared/types/runner'

/** 执行机上只跑 Claude Code / Codex：像素星空引擎要桌面转发平台网关（remote-runtime 的 platform:environment） */
export const RUNNER_ENGINES = ['claude', 'codex'] as const
const MAX_MEMBERS = 200

const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v && v.length <= max ? v : null)

function cleanMember(raw: unknown): RunnerMember | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const id = str(m.id, 100)
  const name = str(m.name, 100)
  const projectPath = str(m.projectPath, 4096)
  const engine = m.engine
  if (!id || !name || !projectPath || !isAbsolute(projectPath) || projectPath.includes('\0')) return null
  if (!RUNNER_ENGINES.includes(engine as (typeof RUNNER_ENGINES)[number])) return null
  const settings = (m.settings && typeof m.settings === 'object' ? { ...m.settings } : {}) as Record<string, unknown>
  // 平台额度、自定义接口在执行机上用不了（要桌面转发），一律去掉
  delete settings.platform
  delete settings.provider
  return {
    id,
    name,
    engine: engine as RunnerMember['engine'],
    projectPath,
    settings: settings as unknown as RunnerMember['settings'],
    instructions: typeof m.instructions === 'string' ? m.instructions.slice(0, 20_000) : '',
    // 执行机每项活新开会话（没人看着，不接着用一个会话）
    mode: 'per-task',
    ...(m.copyPerTask === true ? { copyPerTask: true } : {}),
    ...(m.sameDir === 'queue' || m.sameDir === 'copy' || m.sameDir === 'together' ? { sameDir: m.sameDir } : {}),
    createdAt: typeof m.createdAt === 'number' && Number.isFinite(m.createdAt) ? m.createdAt : 0,
  }
}

/** 读 config.json 的内容；认不出格式时 null（执行机不接活，等桌面推新的） */
export function cleanRunnerConfig(raw: unknown): RunnerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (c.format !== 1) return null
  const installer = str(c.installer, 200)
  if (!installer) return null
  const members = (Array.isArray(c.members) ? c.members : [])
    .slice(0, MAX_MEMBERS)
    .map(cleanMember)
    .filter((m): m is RunnerMember => !!m)
  const seen = new Set<string>()
  return {
    format: 1,
    installer,
    locale: c.locale === 'en-US' ? 'en-US' : 'zh-CN',
    selfName: str(c.selfName, 100) ?? 'Runner',
    teammate: cleanTeammate(c.teammate),
    members: members.filter(m => !seen.has(m.id) && seen.add(m.id)),
  }
}

/** 换成执行机自己的成员配置：项目 id 用执行机项目表里的，机器总是 local，每项活新开会话 */
export function runnerAgent(member: RunnerMember, projectId: string): AgentConfig {
  const { projectPath: _path, ...rest } = member
  return { ...rest, machineId: 'local', projectId, copyId: null, sharedSessionId: null, mode: 'per-task' }
}

/** 推给执行机的配置：绑在它上面、成员在这台机器上的 Claude Code / Codex 成员；项目按路径给 */
export function runnerConfig(input: {
  installer: string
  locale: RunnerConfig['locale']
  selfName: string
  members: AgentConfig[]
  teammate: RunnerConfig['teammate']
  /** 这台机器的项目（id → 路径） */
  projectPath: (projectId: string) => string | null
}): RunnerConfig {
  const members: RunnerMember[] = []
  for (const m of input.members) {
    if (m.engine !== 'claude' && m.engine !== 'codex') continue
    const projectPath = input.projectPath(m.projectId)
    if (!projectPath) continue
    const { machineId: _m, projectId: _p, copyId: _c, sharedSessionId: _s, ...rest } = m
    members.push({ ...rest, projectPath })
  }
  const projects = input.teammate.projects
  return {
    format: 1,
    installer: input.installer,
    locale: input.locale,
    selfName: input.selfName,
    teammate: {
      ...input.teammate,
      projects: projects ? projects.map(id => input.projectPath(id)).filter((p): p is string => !!p) : null,
    },
    members,
  }
}
