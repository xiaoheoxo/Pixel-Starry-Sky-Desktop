// oh-my-pi 的会话开关（docs/omp-engine.md §11.2、§11.4）：显示思考、Ultracode 没有 RPC 命令，只能启动时用
// --config 叠一份设置。只写我们开关管的几项，只对这个进程生效，不写用户的配置；改了要换进程（下一轮生效）
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionSettings } from '@pixelsky/protocol'

/** Ultracode 时最多同时跑几个子智能体（omp 在 RPC 下默认 32，控制余额消耗） */
export const OMP_ULTRACODE_CONCURRENCY = 8

/**
 * 隔离（队友派来的活、执行器，ExtensionLaunch.strictMcp）时停掉的配置来源：用户级 MCP、插件、扩展、技能都从这些来，
 * 停掉后只剩项目自己的 .mcp.json 等（真 omp 19.1.0 逐个试过；登录、模型、设置不受影响）。项目的 .omp/ 和用户的是同一个
 * 来源，一起停。cursor、vscode 不列：只剩项目级的，用户级的由 enabledProviders: [] 挡住；cursor 这个 id 又和模型提供方
 * 共用，停了会把用 Cursor 登录的模型一起停掉
 */
export const OMP_ISOLATED_SOURCES = [
  'native',
  'omp-plugins',
  'agent-plugins',
  'agents',
  'claude',
  'claude-plugins',
  'codex',
  'gemini',
  'opencode',
  'windsurf',
] as const

/**
 * 叠加设置的内容。omitThinking 两种都写：开着时也要盖过用户自己配置里的省略，开关和实际才一致。
 * Ultracode = task.eager: always（每轮系统提示要求把改动拆开委派给 task 子智能体，首条消息前再加一段并行派活的提醒）
 */
export function ompOverlayText(
  settings: Pick<SessionSettings, 'thinkingSummaries' | 'ultracode'>,
  isolated = false,
): string {
  const lines = [`omitThinking: ${settings.thinkingSummaries ? 'false' : 'true'}`]
  if (settings.ultracode) lines.push('task:', '  eager: always', `  maxConcurrency: ${OMP_ULTRACODE_CONCURRENCY}`)
  if (isolated) lines.push(`disabledProviders: [${OMP_ISOLATED_SOURCES.join(', ')}]`, 'enabledProviders: []')
  return lines.join('\n') + '\n'
}

/** 写到 dir/overlay-<内容哈希>.yml，内容一样不重写；返回路径 */
export function writeOmpOverlay(dir: string, text: string): string {
  const file = join(dir, `overlay-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.yml`)
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return file
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, text)
  return file
}
