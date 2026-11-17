// 审查和修完后的复审（docs/ui/review-pr-actions.md §2）：一个会话一份，挂在对话区（LiveTranscript）。
// 模型通道和 AI 写提交信息共用（设置 › 模型）；「换个模型复审」只换这一次用的通道
import { useEffect, useMemo, useRef } from 'react'
import type { Item } from '@pixelsky/protocol'
import type { ChangedFiles } from '@/data'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { getLocale, tr } from '@/i18n/core'
import { effectiveSource, useAiCommitSettings } from '@/features/settings/aiCommit'
import { useCommitChannels } from '@/features/settings/models/useCommitChannels'
import { channelRequest, problemText } from '@/features/panel/git/AiCommit'
import { bridge } from '@/features/engine'
import type { AiReviewRequest, AiSource } from '../../../../../shared/types/ai'
import {
  applyRecheck,
  askText,
  fixMessage,
  fixTurnOf,
  newReview,
  previousOf,
  reviewDiff,
  turnChangesOf,
  type ReviewItem,
} from './reviewModel'
import { getReview, isRunning, setError, setReview, setRunning, updateReview, useSessionReviews } from './reviewStore'

export interface ReviewRunner {
  /** 审这一轮；source 不传用设置里的通道 */
  run(turnKey: string, data: ChangedFiles, source?: AiSource): void
  /** 「修这条」「全部修复」：发一条消息让会话去修，记下来修完复审 */
  fix(turnKey: string, items: ReviewItem[]): void
  /** 「换个模型复审」能选的通道（已经能用的） */
  sources: { source: AiSource; label: string }[]
  current: AiSource | null
}

/** 用户这一轮的原话（turnKey 是开启这一轮的 user 条目 id） */
const askOf = (items: readonly Item[], turnKey: string): string => {
  const user = items.find(i => i.id === turnKey)
  return user?.kind === 'user' ? askText(user.text) : ''
}

export function useReviewRunner(
  sessionId: string | null,
  items: readonly Item[],
  sessionRunning: boolean,
): ReviewRunner {
  const { model } = useAiCommitSettings()
  const channels = useCommitChannels()
  const current = effectiveSource(model, channels.ctx)
  const latest = useRef({ model, channels, items })
  latest.current = { model, channels, items }

  /** 问一次模型；previous 不为空是复审 */
  const ask = async (turnKey: string, data: ChangedFiles, source: AiSource, previous: AiReviewRequest['previous']) => {
    const { model, channels, items } = latest.current
    const label = `${channels.name(source)} · ${channels.modelLabel(source, model)}`
    const channel = await channelRequest(source, model, channels)
    if ('problem' in channel)
      return { error: problemText({ ...channel, model: model.model, source }, channels.name(source)) }
    const api = window.pixelsky?.ai
    if (!api) return { error: tr('aiCommit.problem.failed') }
    const result = await api.review({
      requestId: crypto.randomUUID(),
      ...channel.request,
      diff: reviewDiff(data),
      ask: askOf(items, turnKey),
      previous,
      uiLanguage: getLocale().startsWith('zh') ? 'zh' : 'en',
    })
    if (!result.ok)
      return {
        error: problemText({ problem: result.problem, detail: result.detail, model: model.model, source }, label),
      }
    return { result, label }
  }

  const run = (turnKey: string, data: ChangedFiles, source?: AiSource): void => {
    if (!sessionId || isRunning(sessionId, turnKey)) return
    const using = source ?? current
    if (isDemo) {
      setReview(
        sessionId,
        turnKey,
        newReview(demo().aiReviewFindings, { at: Date.now(), model: 'claude-opus-5-5', files: data.files.length }),
      )
      return
    }
    if (!using) return setError(sessionId, turnKey, tr('aiCommit.problem.failed'))
    setRunning(sessionId, turnKey, 'review')
    void ask(turnKey, data, using, [])
      .then(out => {
        if ('error' in out) return setError(sessionId, turnKey, out.error ?? '')
        const { result, label } = out
        if (!result.ok) return
        setReview(
          sessionId,
          turnKey,
          newReview(result.findings, { at: Date.now(), model: label, files: data.files.length, raw: result.raw }),
        )
      })
      .catch((e: Error) => setError(sessionId, turnKey, e.message))
      .finally(() => setRunning(sessionId, turnKey, null))
  }

  const fix = (turnKey: string, chosen: ReviewItem[]): void => {
    if (!sessionId || !chosen.length) return
    const text = fixMessage(chosen)
    const ids = new Set(chosen.map(i => i.id))
    const mark = (): void =>
      updateReview(sessionId, turnKey, r => ({
        ...r,
        items: r.items.map(i => (ids.has(i.id) ? { ...i, status: 'sent' as const } : i)),
        // 只复审一次：已经复审过的再修就不再自动复审
        fix: r.rechecked ? null : { text, ids: [...ids] },
      }))
    if (isDemo || !bridge) return mark()
    mark()
    void bridge.send(sessionId, { text, clientMessageId: crypto.randomUUID() }).catch((e: Error) => {
      updateReview(sessionId, turnKey, r => ({
        ...r,
        items: r.items.map(i => (ids.has(i.id) ? { ...i, status: 'open' as const } : i)),
        fix: null,
      }))
      setError(sessionId, turnKey, e.message)
    })
  }

  // 修的那一轮结束后自动复审一次（Q2）：只审那一轮的差异，带上原来的条目
  const reviews = useSessionReviews(sessionId)
  useEffect(() => {
    if (!sessionId || isDemo) return
    for (const [turnKey, review] of Object.entries(reviews)) {
      if (!review.fix || review.rechecked || isRunning(sessionId, turnKey)) continue
      const turn = fixTurnOf(items, turnKey, review.fix.text, sessionRunning)
      if (!turn) continue
      const data = turnChangesOf(items, turn.turnKey)
      const { previous, ids } = previousOf(review)
      // 修的那一轮什么都没改、或者没有要复审的：不复审，只记下复审过了
      if (!data || !previous.length || !current) {
        updateReview(sessionId, turnKey, r => ({ ...r, fix: null, rechecked: true }))
        continue
      }
      setRunning(sessionId, turnKey, 'recheck')
      void ask(turn.turnKey, data, current, previous)
        .then(out => {
          if ('error' in out) {
            updateReview(sessionId, turnKey, r => ({ ...r, fix: null, rechecked: true }))
            return setError(sessionId, turnKey, out.error ?? '')
          }
          const { result } = out
          // await 之后重新读最新的那份再改（期间可能点了忽略、又发了修复）
          if (result.ok && getReview(sessionId, turnKey))
            updateReview(sessionId, turnKey, r => applyRecheck(r, ids, result.resolved, result.findings))
        })
        .catch((e: Error) => {
          // 失败也算复审过：不然会话每来一条消息就再问一次模型
          updateReview(sessionId, turnKey, r => ({ ...r, fix: null, rechecked: true }))
          setError(sessionId, turnKey, e.message)
        })
        .finally(() => setRunning(sessionId, turnKey, null))
    }
    // ask 用 latest 里的最新值；只在条目、运行状态、审查结果变化时看
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, items, sessionRunning, reviews, current])

  const sources = useMemo(
    () =>
      channels.channels.ready.map(c => ({
        source: c.source,
        label: `${channels.name(c.source)} · ${channels.modelLabel(c.source, model)}`,
      })),
    [channels, model],
  )
  // 对外是同一个对象（改动卡片是 memo 的，传新对象会让每一轮都重画）；调用时用最新的实现
  const impl = useRef({ run, fix, sources, current })
  impl.current = { run, fix, sources, current }
  return useMemo<ReviewRunner>(
    () => ({
      run: (...args) => impl.current.run(...args),
      fix: (...args) => impl.current.fix(...args),
      get sources() {
        return impl.current.sources
      },
      get current() {
        return impl.current.current
      },
    }),
    [],
  )
}
