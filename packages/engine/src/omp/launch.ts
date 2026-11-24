// oh-my-pi 会话进程的启动参数和环境（docs/omp-engine.md §4、§5）
import { delimiter } from 'node:path'
import {
  viaGateway,
  type ExtensionLaunch,
  type PermissionMode,
  type SessionRecord,
  type SessionSettings,
} from '@pixelsky/protocol'
import { piThinkingLevel } from '../pixel/catalog'
import { OMP_PLAN_ENV, OMP_PLAN_RETURN_ENV } from './plan-ext'
import {
  OMP_SUBAGENTS_ENV,
  OMP_SUB_BASE_URL_ENV,
  OMP_SUB_TOKEN_ENV,
  ompPicksEffort,
  ompSubagentSnapshot,
} from './subagent-ext'
import { OMP_TOOLS_ENV } from './tools-ext'
import {
  GATEWAY_ENV,
  GATEWAY_PROVIDER,
  INFERRED_ENV,
  PIXEL_MODES,
  PROVIDERS_ENV,
  applyPixelModels,
  type PixelLaunchOptions,
} from '../pixel/session'

/**
 * 我们的权限档 → omp 的 --approval-mode（它默认 yolo，所以一定要传）。
 * auto 没有对应的档，按 edits；plan 不直接用这张表，按批准后回到的档算（ompApproval）
 */
export const OMP_MODES: Record<PermissionMode, string> = {
  ask: 'always-ask',
  edits: 'write',
  auto: 'write',
  plan: 'always-ask',
  full: 'yolo',
}

/**
 * 这个进程用的 --approval-mode。计划档按批准后回到的档（批准后这一轮接着做，不换进程），但最多「自动改文件」：
 * 计划阶段的只读全靠扩展拦，不能让 yolo 兜底；回到「完全放行」的，这一轮做完换进程（PixelSession.syncMode）。
 * 手机上批准会把「完全放行」降成「自动改文件」（mobile ops），也就和进程一致了
 */
export function ompApproval(permissionMode: PermissionMode, planReturn?: SessionSettings['planReturn']): string {
  if (permissionMode !== 'plan') return OMP_MODES[permissionMode] ?? 'always-ask'
  const back = planReturn ?? 'ask'
  return OMP_MODES[back === 'full' ? 'edits' : back] ?? 'always-ask'
}

/** 用户追加的参数里第一个由像素星空控制的；都允许时返回 null */
export function reservedOmpArg(args: readonly string[]): string | null {
  for (const arg of args)
    for (const name of [
      '--mode',
      '--approval-mode',
      '--session-dir',
      '--no-session',
      '--session',
      '--continue',
      '--resume',
    ])
      if (arg === name || arg.startsWith(name + '=')) return name
  return null
}

/**
 * 和 pixelLaunch 同一个签名（PixelSession 的 options.launch）。用户自己的配置、技能、MCP、扩展都照 omp 自己的走，
 * 我们加桌面端管理的扩展（§12.3）和权限档（隔离的会话 ext.strictMcp 另外停掉用户级的来源，overlay.ts）；经网关（平台线路 / 自定义 API）时 -e 加载我们的网关扩展，从环境变量注册 "pixelsky" 提供方
 */
export function ompLaunch(
  base: NodeJS.ProcessEnv,
  record: SessionRecord,
  permissionMode: PermissionMode,
  ext: ExtensionLaunch | undefined,
  options: PixelLaunchOptions,
): { args: string[]; env: NodeJS.ProcessEnv; cleanup?: () => void } {
  const env: NodeJS.ProcessEnv = { ...base, ...ext?.env }
  if (ext?.pathDirs.length) {
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    env[key] = [...ext.pathDirs, env[key] ?? ''].join(delimiter)
  }
  const args = ['--approval-mode', ompApproval(permissionMode, record.planReturn)]
  // 没走网关：不动它的提供方（用户环境里的 *_BASE_URL 由 omp 自己处理）
  if (env[GATEWAY_ENV.baseUrl]?.trim()) applyPixelModels(env, record, options.contextWindows)
  else delete env[PROVIDERS_ENV]
  // 猜的字段是给像素星空命令行按 Pi 内置表补全用的，omp 的扩展不读
  delete env[INFERRED_ENV]
  const gateway = !!env[PROVIDERS_ENV] && !!options.extensionFile
  if (gateway) args.push('-e', options.extensionFile!)
  // 我们的计划扩展总是加载（omp 自带的在 RPC 里进不去）：计划档时打开、批准后报回到的档；不在计划档时只把
  // 历史里以前注入的计划说明从上下文里滤掉（plan-ext.ts）
  if (options.planFile) args.push('-e', options.planFile)
  if (permissionMode === 'plan') {
    env[OMP_PLAN_ENV] = '1'
    env[OMP_PLAN_RETURN_ENV] = PIXEL_MODES[record.planReturn ?? 'ask']
  } else {
    delete env[OMP_PLAN_ENV]
    delete env[OMP_PLAN_RETURN_ENV]
  }
  if (options.turnFile) args.push('-e', options.turnFile())
  // 应用自己的工具（频道、对话历史）：扩展注册成普通工具；令牌走环境变量，扩展读到就拿掉
  if (ext?.ownTools?.length && options.toolsFile) {
    args.push('-e', options.toolsFile())
    env[OMP_TOOLS_ENV] = JSON.stringify(ext.ownTools)
  } else delete env[OMP_TOOLS_ENV]
  // 子智能体的模型和强度（§18）；扩展读到就把密钥拿掉，不加载扩展时不给
  const subagents = options.subagentFile ? ompSubagentSnapshot(env) : null
  if (subagents) args.push('-e', options.subagentFile!())
  else for (const key of [OMP_SUBAGENTS_ENV, OMP_SUB_BASE_URL_ENV, OMP_SUB_TOKEN_ENV]) delete env[key]
  args.push(...(options.args ?? []))
  // 用户在桌面端配的 MCP、技能：拼成插件目录。放用户参数后面：两个 --plugin-dir 都生效
  const plugin = ext && !ext.strictMcp ? options.pluginDir?.(ext) : null
  if (plugin) args.push('--plugin-dir', plugin.dir)
  if (gateway) args.push(...ompGatewayRoles(record.model))
  // 会话开关的叠加设置放用户参数后面（omp 的 --config 可以给多份，都生效，实测）
  const config = options.configFile?.(record, !!ext?.strictMcp, ompPicksEffort(subagents))
  if (config) args.push(`--config=${config}`)
  // 隔离靠叠加设置：没有它就不能起来，会带上用户的 MCP
  else if (ext?.strictMcp) throw new Error('oh-my-pi 的隔离设置没有写出来')
  return { args, env, ...(plugin ? { cleanup: plugin.remove } : {}) }
}

/**
 * 终端（TUI）模式的参数（docs/omp-engine.md §11.7）：launchArgs 是 ompLaunch 给的（权限档、网关扩展、角色、用户参数、叠加设置），
 * 再接上会话文件（omp 用 --resume=<路径>，没有 --session）、模型、思考档；会话进程里这些是起来后用 RPC 设的。
 * Fast 关着时 --service-tier=none：用户配置里的 tier.openai: priority 不能让终端里悄悄按 Fast 发（§11.1）
 */
export function ompTuiArgs(
  record: Pick<SessionRecord, 'model' | 'effort' | 'fast' | 'platform' | 'provider'>,
  sessionFile: string,
  launchArgs: readonly string[],
): string[] {
  const args = [...launchArgs, `--resume=${sessionFile}`]
  if (record.model) {
    // 经网关的只能用网关扩展注册的 pixelsky/<id>，不能落到同名的内置模型（会用本机账号直连厂商）
    const bare = record.model.replace(new RegExp(`^${GATEWAY_PROVIDER}/`), '')
    args.push(`--model=${viaGateway(record) ? `${GATEWAY_PROVIDER}/${bare}` : record.model}`)
  }
  if (record.effort) args.push(`--thinking=${piThinkingLevel(record.effort)}`)
  args.push(`--service-tier=${record.fast ? 'priority' : 'none'}`)
  return args
}

/**
 * 经网关时 omp 的辅助请求也走这条线路：用户在 omp 里给 smol / slow / plan 配了自己的模型的话，标题、强度判断、
 * 子智能体会拿用户自己的账号去请求（实测，D354 补充），不扣平台余额也不经网关。这次运行里三个角色都指到会话的模型，
 * 判断和 Spotlight 只用当前提供方；只对这个进程生效，不写用户的配置。放在用户参数后面，同名的以这里为准
 */
export function ompGatewayRoles(model: string | null): string[] {
  const id = model?.replace(new RegExp(`^${GATEWAY_PROVIDER}/`), '')
  if (!id) return ['--no-judge', '--no-spotlight']
  const ref = `${GATEWAY_PROVIDER}/${id}`
  return [`--smol=${ref}`, `--slow=${ref}`, `--plan=${ref}`, '--no-judge', '--no-spotlight']
}
