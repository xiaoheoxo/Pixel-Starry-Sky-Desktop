// Codex 目标模式的目标栏（docs/ui/codex-goal.md §2）
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionGoal } from '@pixelsky/protocol'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})
const goals: Record<string, SessionGoal | null> = {}
/** 会话的引擎（不写是 Codex） */
const engines: Record<string, string> = {}
vi.mock('@/features/engine/store', () => ({
  useEngineState: <T,>(
    selector: (s: { snapshots: Record<string, { goal: SessionGoal | null; record: { engine: string } }> }) => T,
  ): T =>
    selector({
      snapshots: Object.fromEntries(
        Object.entries(goals).map(([id, goal]) => [id, { goal, record: { engine: engines[id] ?? 'codex' } }]),
      ),
    }),
}))
import { I18nProvider } from '@/i18n/I18nProvider'
import { GoalBar, claudeGoalCommand, goalResultText, goalStats, goalUsageText } from './GoalBar'

const goal = (patch: Partial<SessionGoal> = {}): SessionGoal => ({
  objective: '把测试修好',
  status: 'active',
  tokensUsed: 12_345,
  tokenBudget: null,
  timeUsedSeconds: 95,
  updatedAt: 0,
  ...patch,
})
const render = (id: string | null) =>
  renderToStaticMarkup(
    <I18nProvider>
      <GoalBar sessionId={id} onAction={async () => null} />
    </I18nProvider>,
  )

describe('GoalBar', () => {
  it('没有目标时不显示', () => {
    goals.none = null
    expect(render('none')).toBe('')
    expect(render(null)).toBe('')
  })

  it('进行中：目标、状态、用量，能暂停和清除', () => {
    goals.s = goal()
    const html = render('s')
    expect(html).toContain('把测试修好')
    expect(html).toContain('进行中')
    expect(html).toContain('已用 12.3k token · 用时 1m 35s')
    expect(html).toContain('暂停')
    expect(html).not.toContain('>继续<')
    expect(html).toContain('aria-label="清除"')
  })

  it('暂停 / 卡住时能继续；完成了只能清除', () => {
    goals.p = goal({ status: 'paused' })
    expect(render('p')).toContain('继续')
    goals.b = goal({ status: 'blocked' })
    expect(render('b')).toContain('卡住了')
    goals.c = goal({ status: 'complete' })
    const done = render('c')
    expect(done).toContain('已完成')
    expect(done).not.toContain('>继续<')
    expect(done).not.toContain('>暂停<')
  })

  it('用量带预算；/goal 的结果提示', () => {
    expect(goalUsageText(goal({ tokenBudget: 50_000, timeUsedSeconds: 0 }))).toBe('已用 12.3k / 50k token')
    expect(goalResultText({ kind: 'get' }, goal({ status: 'paused' }))).toBe('当前目标（已暂停）：把测试修好')
    expect(goalResultText({ kind: 'get' }, null)).toBe('这个对话没有目标。输入 /goal 加上要达成的目标来设一个')
    expect(goalResultText({ kind: 'set', objective: '修 bug' }, goal())).toBe(
      '已设目标：修 bug。Codex 会一轮接一轮地做，直到完成；输入 /goal pause 暂停，/goal clear 清除',
    )
    expect(goalResultText({ kind: 'clear' }, null)).toBe('目标已清除')
  })

  it('默认收起：整行是展开按钮，完整目标和明细要点开才显示', () => {
    goals.e = goal({ objective: '第一行\n第二行' })
    const html = render('e')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('完整目标')
  })

  it('展开区的四格：预算比例封顶 1、预算 0 当用完；没设预算、没更新时间时的写法；卡住标警告', () => {
    const [status, tokens, time, updated] = goalStats(goal({ status: 'blocked', tokenBudget: 10_000 }))
    expect(status).toMatchObject({ value: '卡住了', warn: true })
    expect(tokens).toMatchObject({ value: '12.3k / 10k', share: 1 })
    expect(time.value).toBe('1m 35s')
    expect(updated.value).toBe('—')
    expect(goalStats(goal({ tokenBudget: 0 }))[1].share).toBe(1)
    expect(goalStats(goal({ tokenBudget: 50_000 }))[1].share).toBeCloseTo(12_345 / 50_000)
    const none = goalStats(goal())
    expect(none[0].warn).toBe(false)
    expect(none[1]).toEqual({ label: '已用 token', value: '12.3k（没设预算）' })
  })

  it('Claude Code（docs/ui/claude-goal.md）：没有暂停 / 继续；进行中只有用时，完成后带 token 和轮数', () => {
    const now = Date.UTC(2026, 10, 28, 8, 0)
    const active = goal({ tokensUsed: 0, timeUsedSeconds: 0, startedAt: now - 12 * 60_000 })
    goals.cc = active
    engines.cc = 'claude'
    const html = render('cc')
    expect(html).toContain('进行中')
    expect(html).not.toContain('>暂停<')
    expect(html).not.toContain('>继续<')
    expect(html).toContain('给 Claude Code 发 /goal clear')
    expect(goalUsageText(active, true, now)).toBe('用时 12m 0s')
    expect(goalStats(active, true, now).map(x => [x.label, x.value, !!x.faint])).toEqual([
      ['状态', '进行中', false],
      ['已用 token', '完成后显示', true],
      ['用时', '12m 0s', false],
      ['轮数', '完成后显示', true],
    ])
    const done = goal({ status: 'complete', tokensUsed: 284_000, timeUsedSeconds: 480, turns: 4, startedAt: now - 9e5 })
    expect(goalUsageText(done, true, now)).toBe('已用 284k token · 用时 8m 0s · 4 轮')
    expect(goalStats(done, true, now).map(x => x.value)).toEqual(['已完成', '284k', '8m 0s', '4 轮'])
    // 按钮换成的命令
    expect(claudeGoalCommand({ kind: 'clear' })).toBe('/goal clear')
    expect(claudeGoalCommand({ kind: 'set', objective: '修好测试' })).toBe('/goal 修好测试')
    expect(claudeGoalCommand({ kind: 'pause' })).toBeNull()
    // 卡住了也没有「继续」
    goals.cb = goal({ status: 'blocked', turns: 2 })
    engines.cb = 'claude'
    expect(render('cb')).not.toContain('>继续<')
  })
})
