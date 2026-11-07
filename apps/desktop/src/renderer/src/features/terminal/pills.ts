// 运行胶囊的状态（docs/ui/panel-pill.md §4）：shell 集成只报告「命令结束」和「提示符回来」，
// 没有「命令开始」，所以「在跑」靠「提示符之后发过回车，而且还没等到下一个提示符」判断。
// shortcut: 多行输入停在续行提示符时会误判成在跑；用户反馈多再给集成加 OSC 633 C（命令开始）。
// shortcut: 集成中途丢了（`. $PROFILE` 覆盖 prompt、exec 进没集成的 shell）提示符不再上报，胶囊停在「运行中」，
// 关掉终端才清掉（「停止」只发 Ctrl+C，分不清程序没退还是集成丢了）；`exec ` 开头的命令先不记。加 OSC 633 C 后按「命令开始」标记判断再去掉这两处。
import type { TerminalRecord } from '../../../../shared/types/terminal'
import { promptCommand } from './errorLines'
import { hasIntegration, type PromptMarks } from './marks'

/** 回车后这么久还没等到提示符才显示：短命令和空回车不闪 */
export const RUN_SHOW_AFTER_MS = 2000
/** 成功的命令至少跑这么久才给 ✓ */
export const DONE_MIN_MS = 10_000
/** ✓ 留这么久 */
export const DONE_SHOW_MS = 6000

/** 用户中止不算失败：Ctrl+C（集成记 130）、Windows 控制台的 STATUS_CONTROL_C_EXIT */
const INTERRUPTED = new Set([130, -1073741510])

export type TerminalRun =
  | {
      phase: 'running'
      generation: number
      at: number
      /** 回车时的提示符、命令结束次数：之后变了才算这条命令结束 */
      prompts: number
      ends: number
      command: string | null
      afterSeq: number
    }
  | { phase: 'done'; generation: number; code: number; endedAt: number; command: string | null; afterSeq: number }

const marksOf = (marks: PromptMarks | undefined, generation: number): PromptMarks | undefined =>
  marks?.generation === generation ? marks : undefined

/** 输入里有回车：记下一条命令开始；在跑的程序收到回车、exec 换掉 shell 不算新命令 */
export function startRun(
  run: TerminalRun | undefined,
  marks: PromptMarks | undefined,
  input: { generation: number; now: number; command: string | null; afterSeq: number },
): TerminalRun | undefined {
  if (input.command && /^exec\s/.test(input.command.trimStart())) return run
  const current = marksOf(marks, input.generation)
  const prompts = current?.prompts ?? 0
  if (run?.phase === 'running' && run.generation === input.generation && run.prompts === prompts) return run
  return {
    phase: 'running',
    generation: input.generation,
    at: input.now,
    prompts,
    ends: current?.ends ?? 0,
    command: input.command,
    afterSeq: input.afterSeq,
  }
}

/** 提示符回来了：决定留不留胶囊。结束时正看着这个终端就不留 */
export function endRun(
  run: TerminalRun | undefined,
  marks: PromptMarks,
  now: number,
  onScreen: boolean,
): TerminalRun | undefined {
  if (run?.phase !== 'running') return run
  if (marks.generation !== run.generation) return undefined
  if (marks.prompts <= run.prompts) return run
  // 命令比 shell 的第一个提示符先写入（新建终端马上跑脚本）：这个提示符之后命令才开始
  if (run.prompts === 0 && marks.ends <= run.ends) return { ...run, prompts: marks.prompts }
  if (marks.ends <= run.ends || onScreen) return undefined
  const code = marks.codes[marks.codes.length - 1] ?? null
  if (code === null || INTERRUPTED.has(code)) return undefined
  if (code === 0 && now - run.at < DONE_MIN_MS) return undefined
  return { phase: 'done', generation: run.generation, code, endedAt: now, command: run.command, afterSeq: run.afterSeq }
}

export interface RunPill {
  id: string
  generation: number
  state: 'failed' | 'done' | 'running'
  name: string
  short: string
  code: number | null
  afterSeq: number
}

const RANK: Record<RunPill['state'], number> = { failed: 0, done: 1, running: 2 }
const RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun', 'npx', 'pnpx', 'node', 'python', 'python3', 'cargo', 'go'])

/** 窄时显示的短名字：pnpm build → build，vitest --watch → vitest，./scripts/a.sh → a.sh */
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/)
  const base = (word: string): string => word.split(/[\\/]/).pop() || word
  const first = base(words[0] ?? '')
  // pnpm run dev、pnpm exec vitest 取后面那个词
  const next = words.slice(1).find(word => !word.startsWith('-') && word !== 'run' && word !== 'exec')
  // node -e "代码" 这种后面不是脚本名，就用 node
  return RUNNERS.has(first.replace(/\.(exe|cmd)$/i, '')) && next && /^[\w.@:/\\-]+$/.test(next) ? base(next) : first
}

/** 现在该显示哪些胶囊；nextAt：下一次到点变化（2 秒门槛、✓ 到期），没有为 null */
export function pillsOf(
  records: readonly TerminalRecord[],
  allMarks: Readonly<Record<string, PromptMarks>>,
  runs: Readonly<Record<string, TerminalRun>>,
  now: number,
): { pills: RunPill[]; nextAt: number | null } {
  const pills: RunPill[] = []
  let nextAt: number | null = null
  const wake = (at: number): void => {
    nextAt = nextAt === null ? at : Math.min(nextAt, at)
  }
  for (const record of records) {
    const run = runs[record.id],
      marks = allMarks[record.id]
    // 拿不到准确状态时宁可不显示：没有集成、cmd（weak：不报告命令结束）
    if (!run || run.generation !== record.generation) continue
    if (!hasIntegration(marks, record.generation) || marks.weak > 0) continue
    const base = {
      id: record.id,
      generation: record.generation,
      name: run.command || record.title,
      short: run.command ? shortName(run.command) : record.title,
      afterSeq: run.afterSeq,
    }
    if (run.phase === 'done') {
      if (run.code !== 0) pills.push({ ...base, state: 'failed', code: run.code })
      else if (now < run.endedAt + DONE_SHOW_MS) {
        pills.push({ ...base, state: 'done', code: 0 })
        wake(run.endedAt + DONE_SHOW_MS)
      }
      continue
    }
    if (record.status !== 'running' && record.status !== 'starting') {
      const code = record.exitCode ?? null
      if (code !== null && code !== 0 && !INTERRUPTED.has(code)) pills.push({ ...base, state: 'failed', code })
      continue
    }
    if (now < run.at + RUN_SHOW_AFTER_MS) wake(run.at + RUN_SHOW_AFTER_MS)
    else pills.push({ ...base, state: 'running', code: null })
  }
  pills.sort((a, b) => RANK[a.state] - RANK[b.state])
  return { pills, nextAt }
}

/** 详情里的最后几行：\r 覆盖的进度行只留最后一段，去掉末尾空行和命令结束后回来的提示符 */
export function lastLines(text: string, count: number): string[] {
  const lines = text.split('\n').map(line => {
    const parts = line.split('\r').filter(Boolean)
    return (parts[parts.length - 1] ?? '').trimEnd()
  })
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  if (lines.length && promptCommand(lines[lines.length - 1]) !== null) lines.pop()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const last = lines.slice(-count)
  while (last.length && !last[0]) last.shift()
  return last
}
