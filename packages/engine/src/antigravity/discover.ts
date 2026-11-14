// 找 agy、读版本、探登录（docs/antigravity-engine.md §5 第一期、§7 实测）
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codedError,
  type Effort,
  type EngineCatalog,
  type EngineInfo,
  type EngineModel,
  type SkillCommand,
} from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { ACP_AUTH_REQUIRED, AcpConnection, AcpError, type AcpHandlers } from '../acp/connection'
import { ONE_SHOT_TIMEOUT, OneShotError, oneShotProblem, type OneShotReply, type OneShotRequest } from '../oneshot'
import { IS_WINDOWS, findOnPath, isFile, removeTree, resolveCommand, run, versionAtLeast } from '../exec'
import { engineBase } from '../registry'
import { configOptions } from './session'
import { AGY_ERROR_PREFIX, agyCommands } from './translate'

/** 1.5.0 才有 agy acp，1.5.4 修了「第二次批准后这一轮卡住」 */
export const AGY_MIN_VERSION = '1.5.4'

export function agyVersionStatus(version: string | null): { status: EngineInfo['status']; message: string | null } {
  if (!version) return { status: 'error', message: 'Could not read the Antigravity CLI version' }
  if (!versionAtLeast(version, AGY_MIN_VERSION))
    return {
      status: 'outdated',
      message: `Antigravity CLI is too old (requires ${AGY_MIN_VERSION} or later). Run agy update`,
    }
  return { status: 'ready', message: null }
}

/** 官方安装脚本放的位置：Windows %LOCALAPPDATA%\agy\bin，其他系统 ~/.local/bin（安装器把它写进用户 PATH，但已经开着的进程看不到） */
export function agyCandidates(env: NodeJS.ProcessEnv): string[] {
  if (IS_WINDOWS) {
    const local = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return [join(local, 'agy', 'bin', 'agy.exe'), join(local, 'Microsoft', 'WinGet', 'Links', 'agy.exe')]
  }
  return [join(homedir(), '.local/bin/agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']
}

/** 用户替换的命令（docs/ui/engine-launch.md §3）：绝对路径或 PATH 上的命令名 */
export function customAgy(command: string, env: NodeJS.ProcessEnv): { path: string } | { error: string } {
  const r = resolveCommand(command, env)
  if (r.ok) return { path: r.path }
  if (r.reason === 'script') return { error: codedError('launch.script', { path: r.path }).message }
  return { error: codedError(`launch.${r.reason}`, { command: command.trim() }).message }
}

/** 官方安装器：Windows 用 PowerShell 跑 install.ps1，其他系统 curl install.sh | bash；都没有时 null（界面不给「安装」） */
export function agyInstaller(env: NodeJS.ProcessEnv): Launcher | null {
  if (IS_WINDOWS) {
    const ps =
      findOnPath('powershell.exe', env) ??
      [join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')].find(isFile)
    if (!ps) return null
    return {
      command: ps,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'irm https://antigravity.google/cli/install.ps1 | iex',
      ],
    }
  }
  const bash = findOnPath('bash', env) ?? ['/bin/bash'].find(isFile)
  if (!bash || !findOnPath('curl', env)) return null
  return { command: bash, args: ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'] }
}

/** override 为用户替换的命令，null 按 PATH 和安装器的位置找 */
export async function discoverAgy(
  override: string | null,
  env: NodeJS.ProcessEnv,
): Promise<{ info: EngineInfo; launcher: Launcher | null }> {
  const base = { ...engineBase('antigravity'), launch: override ? ('custom' as const) : ('stock' as const) }
  const custom = override ? customAgy(override, env) : null
  if (custom && 'error' in custom)
    return { info: { ...base, status: 'missing', version: null, path: null, message: custom.error }, launcher: null }
  const path = custom
    ? custom.path
    : (findOnPath(IS_WINDOWS ? 'agy.exe' : 'agy', env) ?? agyCandidates(env).find(isFile) ?? null)
  if (!path)
    return {
      info: {
        ...base,
        status: 'missing',
        version: null,
        path: null,
        installable: !override && agyInstaller(env) !== null,
        message: IS_WINDOWS
          ? '没找到 Antigravity CLI。安装：在 PowerShell 运行 irm https://antigravity.google/cli/install.ps1 | iex'
          : '没找到 Antigravity CLI。安装：在终端运行 curl -fsSL https://antigravity.google/cli/install.sh | bash',
      },
      launcher: null,
    }
  const launcher = { command: path, args: [] }
  const result = await run(launcher, ['--version'], env, 12_000)
  // agy --version 只输出版本号（1.5.9）
  const version = result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null
  const check =
    custom && result.started && !version
      ? { status: 'ready' as const, message: null }
      : result.ok
        ? agyVersionStatus(version)
        : { status: 'error' as const, message: 'Antigravity CLI could not start' }
  return { info: { ...base, status: check.status, version, path, message: check.message }, launcher }
}

export type AgyAuth = { signedIn: true; kind: 'login' | 'apiKey' } | { signedIn: false; reason: string }

/**
 * 探登录：起一次 agy acp（临时空目录），握手。有 GEMINI_API_KEY 时按 Key 认证（authenticate gemini-api-key），
 * 否则 session/list 看缓存的登录还在不在：没凭据回 -32000（§7「握手和认证」）。不新建会话、不发消息
 */
export async function probeAgyAuth(launcher: Launcher, args: string[], env: NodeJS.ProcessEnv): Promise<AgyAuth> {
  try {
    return await withAgy(launcher, args, env, async (conn, key) => {
      if (!key) await conn.request('session/list', {}, 20_000)
      return { signedIn: true, kind: key ? 'apiKey' : 'login' } as const
    })
  } catch (error) {
    if (error instanceof AcpError && error.code === ACP_AUTH_REQUIRED) return { signedIn: false, reason: error.message }
    throw error
  }
}

/** 取消 Google 登录：ACP logout（initialize 报了 auth.logout，实测回 {}）；用 Key 的不受影响 */
export function agyLogout(launcher: Launcher, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return withAgy(launcher, args, env, async conn => {
    await conn.request('logout', {}, 20_000)
  })
}

/** 在临时空目录里起一次 agy acp，握手（有 Key 时按 Key 认证），做完关掉 */
export async function withAgy<T>(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  body: (conn: AcpConnection, key: boolean, cwd: string) => Promise<T>,
  handlers: AcpHandlers = {},
): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), 'pixelsky-agy-'))
  const conn = new AcpConnection(launcher, ['acp', ...args], cwd, env, handlers)
  try {
    await conn.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'pixelsky', version: '1' },
      },
      15_000,
    )
    const key = !!env.GEMINI_API_KEY?.trim()
    if (key) await conn.request('authenticate', { methodId: 'gemini-api-key' }, 20_000)
    return await body(conn, key, cwd)
  } finally {
    await conn.close()
    try {
      removeTree(cwd)
    } catch {
      // Windows 上目录可能还被占着，留给系统清
    }
  }
}

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * session/new 的结果 → 模型目录：configOptions.model 是系列（gemini-3.8-flash），models.availableModels 是
 * 「系列-档位」组合（gemini-3.8-flash-medium），据此给每个系列的档位；当前系列的默认档位取 thought_level 的当前值
 */
export function agyModels(result: Record<string, unknown>): EngineCatalog {
  const options = configOptions(result.configOptions)
  const model = options.find(o => o.id === 'model')
  const level = options.find(o => o.id === 'thought_level')?.currentValue ?? null
  const combos = (
    (result.models as { availableModels?: { modelId?: unknown }[] } | undefined)?.availableModels ?? []
  ).map(m => String(m.modelId ?? ''))
  const models: EngineModel[] = (model?.options ?? []).map(o => {
    const efforts = EFFORTS.filter(e => combos.includes(`${o.value}-${e}`))
    const isDefault = o.value === model?.currentValue
    return {
      id: o.value,
      label: o.name,
      efforts,
      defaultEffort: isDefault && level && (efforts as string[]).includes(level) ? (level as Effort) : null,
      inputModalities: ['text', 'image'],
      isDefault,
    }
  })
  return { outputStyles: [], currentOutputStyle: null, models, currentModel: model?.currentValue ?? null }
}

/**
 * 模型目录：开一个临时会话读完就关（session/close），不发消息。新建后 agy 紧接着推一次 available_commands_update
 * （P0 录像约 25 ms 后），等它最多 1 秒，给还没起进程的会话当「/」菜单
 */
export function agyCatalog(launcher: Launcher, args: string[], env: NodeJS.ProcessEnv): Promise<EngineCatalog> {
  let commands: SkillCommand[] | null = null
  let got: () => void = () => {}
  const arrived = new Promise<void>(resolve => (got = resolve))
  return withAgy(
    launcher,
    args,
    env,
    async (conn, _key, cwd) => {
      const r = await conn.request<Record<string, unknown>>('session/new', { cwd, mcpServers: [] }, 30_000)
      await Promise.race([arrived, new Promise(resolve => setTimeout(resolve, 1000))])
      await conn.request('session/close', { sessionId: r.sessionId }, 10_000).catch(() => {})
      return { ...agyModels(r), ...(commands ? { commands } : {}) }
    },
    {
      notification: (method, params) => {
        const update = (params.update ?? {}) as Record<string, unknown>
        if (method !== 'session/update' || update.sessionUpdate !== 'available_commands_update') return
        commands = agyCommands(update.availableCommands)
        got()
      },
    },
  )
}

/**
 * 不带会话问一次（AI 写提交信息、优化提示词）：临时目录里开一个会话，追加「不用工具」，权限请求一律拒，
 * 收集回复文字，问完关掉。agy 出错时把错误当回复发（AGY_ERROR_PREFIX），按原话判断原因
 */
export async function agyOneShot(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  req: OneShotRequest,
  signal: AbortSignal,
): Promise<OneShotReply> {
  let text = ''
  try {
    return await withAgy(
      launcher,
      args,
      env,
      async (conn, _key, cwd) => {
        const append = 'Answer directly in plain text. Do not use any tools, do not read or write files.'
        const r = await conn.request<Record<string, unknown>>(
          'session/new',
          { cwd, mcpServers: [], _meta: { antigravity: { systemPrompt: { append } } } },
          30_000,
        )
        const sessionId = String(r.sessionId ?? '')
        let model = configOptions(r.configOptions).find(o => o.id === 'model')?.currentValue || null
        if (req.model) {
          await conn.request('session/set_config_option', { sessionId, configId: 'model', value: req.model }, 10_000)
          model = req.model
        }
        const cancel = (): void => conn.notify('session/cancel', { sessionId })
        signal.addEventListener('abort', cancel)
        try {
          const res = await conn.request<Record<string, unknown>>(
            'session/prompt',
            { sessionId, prompt: [{ type: 'text', text: req.prompt }] },
            ONE_SHOT_TIMEOUT,
          )
          if (signal.aborted || res.stopReason === 'cancelled') throw new OneShotError('cancelled', '已停止')
          const reply = text.trim()
          if (reply.startsWith(AGY_ERROR_PREFIX)) throw new OneShotError(oneShotProblem(reply), reply)
          if (!reply) throw new OneShotError('failed', 'Antigravity 没有回复')
          const u = (res.usage ?? {}) as Record<string, unknown>
          const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
          return {
            text: reply,
            model,
            usage: res.usage
              ? {
                  input: n(u.inputTokens),
                  output: n(u.outputTokens),
                  cacheRead: n(u.cachedReadTokens),
                  cacheWrite: n(u.cachedWriteTokens),
                }
              : null,
          }
        } finally {
          signal.removeEventListener('abort', cancel)
        }
      },
      {
        notification: (method, params) => {
          const update = (params.update ?? {}) as Record<string, unknown>
          const content = (update.content ?? {}) as Record<string, unknown>
          if (method === 'session/update' && update.sessionUpdate === 'agent_message_chunk')
            text += typeof content.text === 'string' ? content.text : ''
        },
        // 不让它动手：权限请求一律拒
        request: method =>
          method === 'session/request_permission' ? Promise.resolve({ outcome: { outcome: 'cancelled' } }) : undefined,
      },
    )
  } catch (error) {
    if (error instanceof OneShotError) throw error
    if (error instanceof AcpError && error.code === ACP_AUTH_REQUIRED)
      throw new OneShotError('notAuthorized', error.message)
    const message = (error as Error).message
    if (signal.aborted) throw new OneShotError('cancelled', '已停止')
    throw new OneShotError(/超时|timed? ?out/i.test(message) ? 'timeout' : oneShotProblem(message), message)
  }
}
