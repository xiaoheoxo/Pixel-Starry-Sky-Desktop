// 推理强度菜单的图标条有哪几格、每格的说明（docs/ui/effort-menu-strip.md）
import { Brain, ListChecks, Rocket, Sparkles, Zap, type LucideIcon } from 'lucide-react'
import type { ComposerController } from '@/features/engine'
import { tr } from '@/i18n/core'
import type { Speed } from './speedHold'

export interface HelpText {
  title: string
  /** 「更耗额度」「下一轮生效」 */
  tag?: 'cost' | 'pending'
  text: string
}

export interface EffortSwitch {
  id: 'ultracode' | 'fast' | 'thinking' | 'check'
  icon: LucideIcon
  short: string
  tone: 'accent' | 'ultracode' | 'warn'
  on: boolean
  /** 开不了（开着的可以关） */
  blocked: boolean
  pending: boolean
  help: HelpText
  /** 这一格别的情况下的说明：只占位，开关时菜单高度不变 */
  spare: HelpText[]
  set: (on: boolean) => void
  /** 能按住升 Ultrafast */
  hold?: { speed: Speed; holding: HelpText; tooShort: HelpText; set: (speed: Speed) => void }
}

export type EffortSwitchSource = Pick<
  ComposerController,
  | 'effortEngine'
  | 'ultracode'
  | 'ultracodeSupported'
  | 'ultracodeAvailable'
  | 'setUltracode'
  | 'fast'
  | 'fastSupported'
  | 'fastAvailable'
  | 'fastBlocked'
  | 'fastHint'
  | 'fastPending'
  | 'setFast'
  | 'ultrafast'
  | 'ultrafastAvailable'
  | 'ultrafastCost'
  | 'setUltrafast'
  | 'thinkingSupported'
  | 'thinkingSummaries'
  | 'setThinkingSummaries'
>

/** check：做完自动检查，会话开出来以前没有 */
export function effortSwitches(
  live: EffortSwitchSource,
  check: { on: boolean; set: (on: boolean) => void } | null,
): EffortSwitch[] {
  const list: EffortSwitch[] = []
  const omp = live.effortEngine === 'omp'
  if (live.ultracodeSupported) {
    const unavailable = live.ultracodeAvailable === false
    list.push({
      id: 'ultracode',
      icon: Sparkles,
      short: 'Ultracode',
      tone: 'ultracode',
      on: live.ultracode,
      blocked: unavailable && !live.ultracode,
      pending: false,
      help: {
        title: 'Ultracode',
        tag: unavailable ? undefined : 'cost',
        text: unavailable
          ? tr('session.ComposerMenus.notSupportedByThis')
          : tr(omp ? 'engine.omp.ultracodeDesc' : 'session.ComposerMenus.orchestrateMultipleSubagentsFor'),
      },
      spare: [],
      set: live.setUltracode,
    })
  }
  if (live.fastSupported) list.push(live.ultrafastAvailable ? speedSwitch(live) : fastSwitch(live))
  if (live.thinkingSupported)
    list.push({
      id: 'thinking',
      icon: Brain,
      short: tr('session.ComposerMenus.thinkingShort'),
      tone: 'accent',
      on: live.thinkingSummaries,
      blocked: false,
      pending: false,
      help: {
        title: tr('session.ComposerMenus.showThinkingSummaries'),
        text: tr(omp ? 'engine.omp.thinkingDesc' : 'session.ComposerMenus.showSummaryOfModel'),
      },
      spare: [],
      set: live.setThinkingSummaries,
    })
  if (check)
    list.push({
      id: 'check',
      icon: ListChecks,
      short: tr('session.ComposerMenus.checkShort'),
      tone: 'accent',
      on: check.on,
      blocked: false,
      pending: false,
      help: { title: tr('checks.auto'), text: tr('checks.autoHint') },
      spare: [],
      set: check.set,
    })
  return list
}

/** 只有 Fast */
function fastSwitch(live: EffortSwitchSource): EffortSwitch {
  const title = tr('session.ComposerMenus.fastMode')
  const unavailable = live.fastAvailable === false
  const normal: HelpText = unavailable
    ? {
        title,
        text: tr('session.ComposerMenus.temporarilyUnavailable', {
          p0: live.fastBlocked ?? tr('session.ComposerMenus.unknownReason'),
        }),
      }
    : { title, tag: 'cost', text: live.fastHint ?? tr('session.ComposerMenus.fasterOutputAtHigher') }
  const next: HelpText = { title, tag: 'pending', text: tr(live.fast ? 'codex.fastNextOn' : 'codex.fastNextOff') }
  return {
    id: 'fast',
    icon: Zap,
    short: 'Fast',
    tone: 'accent',
    on: live.fast,
    blocked: unavailable && !live.fast,
    pending: live.fastPending,
    help: live.fastPending ? next : normal,
    spare: live.fastPending ? [normal] : [next],
    set: live.setFast,
  }
}

/** 点一下 Fast、按住 Ultrafast */
function speedSwitch(live: EffortSwitchSource): EffortSwitch {
  const speed: Speed = live.ultrafast ? 'ultrafast' : live.fast ? 'fast' : 'off'
  const pixel = live.effortEngine === 'pixel'
  const n = live.ultrafastCost
  const cost = pixel
    ? tr('speed.pixelCost')
    : n !== null
      ? tr('speed.platformUltrafastDesc', { n })
      : tr('speed.ultrafastDesc')
  const pixelNow = live.fastHint ?? cost
  const fast: HelpText = {
    title: tr('session.ComposerMenus.fastMode'),
    tag: 'cost',
    text: pixel
      ? `${tr('speed.pixelHold')} ${pixelNow}`
      : n !== null
        ? tr('speed.platformHoldHint', { n })
        : tr('speed.holdHint'),
  }
  const ultrafast: HelpText = { title: 'Ultrafast', tag: 'cost', text: pixel ? pixelNow : cost }
  const now = live.ultrafast ? ultrafast : fast
  const next: HelpText = {
    title: now.title,
    tag: 'pending',
    text: tr('speed.next', {
      p0: speed === 'off' ? tr('speed.off') : speed === 'ultrafast' ? 'Ultrafast' : 'Fast',
    }),
  }
  return {
    id: 'fast',
    icon: live.ultrafast ? Rocket : Zap,
    short: live.ultrafast ? 'Ultrafast' : 'Fast',
    tone: live.ultrafast ? 'warn' : 'accent',
    on: speed !== 'off',
    blocked: false,
    pending: live.fastPending,
    help: live.fastPending ? next : now,
    spare: live.fastPending ? [fast, ultrafast] : [live.ultrafast ? fast : ultrafast, next],
    set: live.setFast,
    hold: {
      speed,
      holding: { title: now.title, text: tr('speed.holding', { p0: cost }) },
      tooShort: { title: now.title, text: tr('speed.tooShort') },
      set: s => (s === 'ultrafast' ? live.setUltrafast() : live.setFast(s === 'fast')),
    },
  }
}
