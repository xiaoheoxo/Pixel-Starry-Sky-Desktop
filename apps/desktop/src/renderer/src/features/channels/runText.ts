// 失败原因的文字（docs/multica-learn.md §2）：纯函数，不依赖 window，可以直接单测
import { tr, type TranslationKey } from '../../i18n/core'
import type { RunReason } from '../../../../shared/types/channels'

/** 建议给谁看：引擎、会话、成员的问题只有主人能处理；「主人电脑离线」是给别人看的；排队过期谁都能重新派 */
function hintFor(reason: RunReason, mine: boolean): boolean {
  if (reason === 'queue_expired') return true
  if (reason === 'machine_offline') return !mine
  return mine
}

/** 「原因 · 建议」：认不出的（other）不写，只留错误原文；建议只给能照着做的人看 */
export function reasonText(reason: RunReason | null | undefined, mine: boolean): string | null {
  if (!reason || reason === 'other') return null
  const label = tr(`run.reason.${reason}` as TranslationKey)
  return hintFor(reason, mine) ? `${label} · ${tr(`run.hint.${reason}` as TranslationKey)}` : label
}
