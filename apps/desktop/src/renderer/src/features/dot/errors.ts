import { cleanIpcError } from '@/features/account/useStore'
import { tr, translateMessage } from '@/i18n/core'

/** Dot 的报错给人看：去掉「Error invoking remote method …」前缀，引擎和主进程的英文原文按词典换成当前语言 */
export function dotError(e: unknown): string {
  return translateMessage(cleanIpcError(e, tr('dot.error.generic')))
}
