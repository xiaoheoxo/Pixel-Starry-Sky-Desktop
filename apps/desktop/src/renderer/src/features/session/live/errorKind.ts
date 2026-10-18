import { tr } from '../../../i18n/core'
// 错误卡片的归类和按钮（纯函数，NoticeActions 和测试共用；docs/ui/source-switch.md §3.5）
import type { SourceAction } from '@/features/engine/sourceActions'
import {
  ENGINES,
  classifyErrorText,
  isNoticeErrorKind,
  type NoticeError,
  type NoticeErrorKind,
  type SessionRecord,
} from '@pixelsky/protocol'

/** auth 登录失效 / balance 余额 / route 线路或模型不可用 / busy 限额或服务繁忙 / overflow 上下文超限（可以压缩后重试） */
export type ErrorKind = NoticeErrorKind

/**
 * 错误归类：引擎给了结构化信息（notice.error）就用它的 kind（认不出时引擎没写 kind，就是归不了类）；
 * 没有（旧会话、旧引擎、平台代理 / 适配层的原文）才按文字猜（协议里的 classifyErrorText，Claude Code 的错误码已在引擎里翻成中文）。
 * kind 是不认识的值（以后新增的）时也退回按文字猜
 */
export function classifyError(text: string, error?: NoticeError | null): ErrorKind | null {
  if (error) {
    if (isNoticeErrorKind(error.kind)) return error.kind
    if (error.kind === undefined) return null
  }
  return classifyErrorText(text)
}

/** 换线路 / 额度来源这一类的按钮（侧栏悬停卡也用）；compact-retry 只在对话流的错误卡片上 */
export type RouteAction = Exclude<SourceAction, 'compact-retry'>

/** 侧栏状态悬停卡也用（features/sidebar/SessionStatusCard.tsx） */
export function actionsFor(
  kind: ErrorKind,
  record: Pick<SessionRecord, 'platform' | 'provider'>,
  engine: SessionRecord['engine'],
): RouteAction[] {
  // 上下文超限和额度来源、线路无关：压缩 / 新开会话才是出路（按钮见 noticeActions）
  if (kind === 'overflow') return []
  // 自定义 API（docs/ui/custom-api.md §3.3）：失败不自动改用别的来源，按钮让用户自己选
  if (record.provider && !record.platform) {
    const platform: RouteAction[] = ENGINES[engine].caps.platformSwitch ? ['use-platform'] : []
    if (kind === 'auth') return ['edit-provider', ...platform, 'use-self']
    if (kind === 'balance' || kind === 'busy') return ['edit-provider', ...platform]
    return ['open-menu', 'edit-provider']
  }
  if (record.platform) {
    if (kind === 'auth') return ['sign-in', 'use-self']
    if (kind === 'balance') return ['open-account', 'open-menu', 'use-self']
    return ['open-menu', 'use-self']
  }
  // 自有：只有能接平台额度的引擎（能力表 platformSwitch）才给「改用平台」
  return ENGINES[engine].caps.platformSwitch ? ['use-platform'] : []
}

/**
 * 错误卡片上的一键按钮（纯函数）：retry 是会话空闲、队列也空着时才给「重试」；
 * 上下文超限再加「压缩后重试」（引擎支持原生压缩 compact 时），放在「重试」前面——不压缩直接重试多半还是超限
 */
export function noticeActions(
  kind: ErrorKind | null,
  record: Pick<SessionRecord, 'platform' | 'provider'>,
  engine: SessionRecord['engine'],
  options: { retry: boolean; compact: boolean },
): SourceAction[] {
  return [
    ...(kind === 'overflow' && options.retry && options.compact ? (['compact-retry'] as const) : []),
    ...(options.retry ? (['retry'] as const) : []),
    ...(kind ? actionsFor(kind, record, engine) : []),
  ]
}

/**
 * 「压缩后重试」的执行顺序（纯函数，Composer 和测试共用）：先压缩，压缩排进队列成功了才发「继续」。
 * 压缩发不出去（引擎不支持、正忙、没有桥接）就抛错、不发「继续」——不压缩直接重试多半还是超限，只会再报一次同样的错
 */
export async function compactThenRetry(
  compact: (() => Promise<unknown>) | undefined,
  retry: () => Promise<unknown>,
): Promise<void> {
  if (!compact) throw new Error(tr('system.engineDoesNotSupport'))
  await compact()
  await retry()
}

/** 平台会话里的「登录已失效」不是 Claude Code 自己的登录：换成平台的说法 */
export function platformNoticeText(record: Pick<SessionRecord, 'platform' | 'provider'>, text: string): string {
  if (record.platform && /^登录已失效/.test(text)) return tr('session.live.errorKind.platformSignInExpired')
  if (record.provider && /^登录已失效/.test(text)) return tr('customApi.keyRejected')
  return text
}
