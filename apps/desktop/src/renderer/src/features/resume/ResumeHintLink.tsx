import { useEngineState } from '@/features/engine'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { cn } from '@/ui'
import { machineOf } from '@/features/machines/store'
import { RESUME_ENGINE_NAMES } from './store'
import { HINT_ENGINES, hintEngine, hintText, openResumeFor, refreshResumeCounts, useResumeHint } from './hint'

/**
 * 「这个项目有 N 个 Claude Code / Codex 会话可以接着聊 · 接着聊」：点「接着聊」打开这个项目的 /resume 选择器（两个引擎都有先打开当前执行者的）。
 * 没有会话 / 还没查到 / 查询失败 / 远程项目时什么都不画。
 * probe 为 true 时（项目的空状态）没有会话也给手动入口：正在查找…、没找到 · 重新查找、查找失败 · 重试（悬停看原因）。
 * fetch 为 false 时不自己触发查询，只显示别处（导入后的批量预查）已经查到的
 */
export function ResumeHintLink({
  projectId,
  separator = 'dot',
  fetch = true,
  probe = false,
  engine: executor,
  className,
}: {
  projectId: string | null | undefined
  separator?: 'dot' | 'comma'
  fetch?: boolean
  probe?: boolean
  /** 当前执行者（两个引擎都有会话时先开它的）；不传用默认执行者 */
  engine?: string | null
  className?: string
}) {
  useI18n()
  const defaultEngine = useEngineState(s => s.defaults?.engine)
  const hint = useResumeHint(projectId, fetch)
  const counts = hint?.counts ?? null
  const text = counts ? hintText(counts) : null
  if (!projectId || !hint) return null
  const sep = tr(separator === 'dot' ? 'resume.hint.sep.dot' : 'resume.hint.sep.comma')
  const action = (label: string, run: () => void, name: string) => (
    <button type="button" data-resume-hint-action={name} onClick={run} className="text-accent-fg hover:underline">
      {label}
    </button>
  )
  if (counts && text) {
    const engine = hintEngine(counts, executor ?? defaultEngine)
    return (
      <span data-resume-hint className={cn('text-label text-fg-muted', className)}>
        {text}
        {sep}
        {action(tr('resume.hint.action'), () => openResumeFor(projectId, engine), 'open')}
      </span>
    )
  }
  // 远程机器 / WSL 项目不查（fetchResumeCounts 直接给空），不说「没找到」
  if (!probe || machineOf(projectId) !== 'local') return null
  if (hint.checking)
    return (
      <span data-resume-hint="checking" role="status" className={cn('text-label text-fg-faint', className)}>
        {tr('resume.hint.checking')}
      </span>
    )
  const failed = HINT_ENGINES.filter(e => hint.errors[e])
  const recheck = () => void refreshResumeCounts(projectId)
  if (failed.length)
    return (
      <span
        data-resume-hint="failed"
        role="status"
        title={failed
          .map(e =>
            tr('resume.hint.failedDetail', {
              engine: RESUME_ENGINE_NAMES[e],
              error: translateMessage(hint.errors[e]!),
            }),
          )
          .join('\n')}
        className={cn('text-label text-fg-muted', className)}
      >
        {tr('resume.hint.failed', { engines: failed.map(e => RESUME_ENGINE_NAMES[e]).join(' / ') })}
        {sep}
        {action(tr('resume.retry'), recheck, 'recheck')}
      </span>
    )
  return (
    <span data-resume-hint="none" className={cn('text-label text-fg-faint', className)}>
      {tr('resume.hint.none')}
      {sep}
      {action(tr('resume.hint.recheck'), recheck, 'recheck')}
    </span>
  )
}
