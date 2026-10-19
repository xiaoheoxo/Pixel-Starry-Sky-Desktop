import { catalog } from './catalog'
import { systemMessages } from './systemMessages'
import { pluginMessages } from './pluginMessages'
import { sessionMessages } from './sessionMessages'
import { commandMessages } from './commandMessages'
import { codexMessages } from './codexMessages'
import { pixelMessages } from './pixelMessages'
import { projectToolsMessages } from './projectToolsMessages'
import { terminalMessages } from './terminalMessages'
import { sidebarMessages } from './sidebarMessages'
import { projectMessages } from './projectMessages'
import { workspaceMessages } from './workspaceMessages'
import { machineMessages, machineErrors } from './machineMessages'
import { channelMessages } from './channelMessages'
import { teamMessages } from './teamMessages'
import { notificationMessages } from './notificationMessages'
import { gitMessages } from './gitMessages'
import { artifactMessages } from './artifactMessages'
import { errorMessages } from './errorMessages'
import { contentMessages } from './contentMessages'
import { branchMessages } from './branchMessages'
import { updateMessages } from './updateMessages'
import { customApiMessages } from './customApiMessages'
import { logMessages } from './logMessages'
import { feedbackMessages } from './feedbackMessages'
import { trayMessages } from './trayMessages'
import { mobileMessages } from './mobileMessages'
import { editorMessages } from './editorMessages'
import { codingMessages } from './codingMessages'
import { attachmentMessages } from './attachmentMessages'
import { boardMessages } from './boardMessages'
import { aiMessages } from './aiMessages'
import { contextMessages } from './contextMessages'
import { costMessages } from './costMessages'
import { longConversationMessages } from './longConversationMessages'
import { tabMenuMessages } from './tabMenuMessages'
import { minimalModeMessages } from './minimalModeMessages'
import { imageViewerMessages } from './imageViewerMessages'
import { modelChannelMessages } from './modelChannelMessages'
import { fullAccessMessages } from './fullAccessMessages'
import { htmlPreviewMessages } from './htmlPreviewMessages'
import { recoveryMessages } from './recoveryMessages'
import { pathClickMessages } from './pathClickMessages'
import { contextMenuMessages } from './contextMenuMessages'
import { subagentMessages } from './subagentMessages'
import { subagentStopMessages } from './subagentStopMessages'
import { subagentRouteMessages } from './subagentRouteMessages'
import { progressLineMessages } from './progressLineMessages'
import { traceHistoryMessages } from './traceHistoryMessages'
import { wslMessages } from './wslMessages'
import { extensionCenterMessages } from './extensionCenterMessages'
import { extstoreInstalledMessages } from './extstoreInstalledMessages'
import { extstorePublishMessages } from './extstorePublishMessages'
import { fileIconMessages } from './fileIconMessages'
import { extGrammarMessages } from './extGrammarMessages'
import { editorThemeMessages } from './editorThemeMessages'
import { extSnippetMessages } from './extSnippetMessages'
import { extTaskMessages } from './extTaskMessages'
import { promptMessages } from './promptMessages'
import { resumeMessages } from './resumeMessages'
import { onboardingMessages } from './onboardingMessages'
import { systemProxyMessages } from './systemProxyMessages'
import { approvalMessages } from './approvalMessages'
import { extstoreDetailMessages } from './extstoreDetailMessages'
import { replaceCodedErrors } from '@pixelsky/protocol'
import type { Locale } from './messages'

export const allMessages = {
  ...catalog,
  ...systemMessages,
  ...pluginMessages,
  ...sessionMessages,
  ...commandMessages,
  ...codexMessages,
  ...pixelMessages,
  ...projectToolsMessages,
  ...terminalMessages,
  ...sidebarMessages,
  ...projectMessages,
  ...workspaceMessages,
  ...machineMessages,
  ...machineErrors,
  ...wslMessages,
  ...channelMessages,
  ...teamMessages,
  ...notificationMessages,
  ...gitMessages,
  ...artifactMessages,
  ...errorMessages,
  ...contentMessages,
  ...branchMessages,
  ...updateMessages,
  ...customApiMessages,
  ...logMessages,
  ...feedbackMessages,
  ...trayMessages,
  ...mobileMessages,
  ...editorMessages,
  ...codingMessages,
  ...attachmentMessages,
  ...boardMessages,
  ...aiMessages,
  ...contextMessages,
  ...costMessages,
  ...longConversationMessages,
  ...tabMenuMessages,
  ...minimalModeMessages,
  ...imageViewerMessages,
  ...modelChannelMessages,
  ...fullAccessMessages,
  ...htmlPreviewMessages,
  ...recoveryMessages,
  ...pathClickMessages,
  ...contextMenuMessages,
  ...subagentMessages,
  ...subagentStopMessages,
  ...subagentRouteMessages,
  ...progressLineMessages,
  ...traceHistoryMessages,
  ...extensionCenterMessages,
  ...extstoreInstalledMessages,
  ...extstorePublishMessages,
  ...fileIconMessages,
  ...extGrammarMessages,
  ...editorThemeMessages,
  ...extSnippetMessages,
  ...extTaskMessages,
  ...promptMessages,
  ...resumeMessages,
  ...onboardingMessages,
  ...systemProxyMessages,
  ...approvalMessages,
  ...extstoreDetailMessages,
}
export type TranslationKey = keyof typeof allMessages

const sourceKeys = new Map<string, TranslationKey>()
const englishKeys = new Map<string, TranslationKey>()
for (const [key, value] of Object.entries(allMessages)) {
  if (!sourceKeys.has(value.zh)) sourceKeys.set(value.zh, key as TranslationKey)
  if (!englishKeys.has(value.en)) englishKeys.set(value.en, key as TranslationKey)
}
export function translateTextFor(language: Locale, value: string): string {
  const key = sourceKeys.get(value) ?? (language === 'zh-CN' ? englishKeys.get(value) : undefined)
  return key ? allMessages[key][language === 'en-US' ? 'en' : 'zh'] : value
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// 只用宿主 / 功能消息做动态匹配：catalog 是界面标签（日期、时长、计数，如「{p0}/{p1}」「{p0}s」「{p0} requests」），
// 拿来匹配引擎原文会改坏它（「Reconnecting... 3/5」→「3月5日」、「Too many requests」→「请求 Too many 次」）。
// 固定文字太少的模板（如「{action}: {icon}」）同样几乎能匹配任何文本，也不参与。
const literalChars = (text: string): number => text.replace(/\{\w+\}/g, '').match(/[\p{L}\p{N}]/gu)?.length ?? 0
const patterns = Object.entries(allMessages)
  .filter(([key]) => !(key in catalog))
  .map(([, message]) => message)
  .flatMap(message => {
    if (!/\{\w+\}/.test(message.zh)) return []
    return (['zh', 'en'] as const)
      .filter(from => literalChars(message[from]) >= 3)
      .map(from => {
        const names: string[] = []
        let cursor = 0,
          pattern = '^'
        for (const match of message[from].matchAll(/\{(\w+)\}/g)) {
          pattern += escapeRegex(message[from].slice(cursor, match.index)) + '([\\s\\S]*?)'
          cursor = match.index + match[0].length
          names.push(match[1])
        }
        pattern += escapeRegex(message[from].slice(cursor)) + '$'
        return { regex: new RegExp(pattern), names, message }
      })
  })
/** 仅用于宿主错误、状态和系统通知，不应用于消息正文或文件内容。语言必须显式传入（renderer 的 core.ts 另有默认当前语言的封装）。 */
export function translateMessage(input: string | null | undefined, language: Locale): string {
  const value = input ?? ''
  // 带代码的宿主错误（codedError）：按 errors.<code> 查词典并代入参数；不认识的代码显示代码本身
  const coded = replaceCodedErrors(value, ({ code, params }) => {
    const message = (allMessages as Record<string, { zh: string; en: string } | undefined>)[`errors.${code}`]
    if (!message) return code
    return message[language === 'en-US' ? 'en' : 'zh'].replace(/\{(\w+)\}/g, (_, name: string) =>
      String(params[name] ?? ''),
    )
  })
  if (coded !== value) return coded
  const known = translateTextFor(language, value)
  if (known !== value || sourceKeys.has(value) || englishKeys.has(value)) return known
  for (const pattern of patterns) {
    const match = pattern.regex.exec(value)
    if (!match) continue
    const params = Object.fromEntries(pattern.names.map((name, i) => [name, match[i + 1]]))
    return pattern.message[language === 'en-US' ? 'en' : 'zh'].replace(
      /\{(\w+)\}/g,
      (_, name: string) => params[name] ?? '',
    )
  }
  return value
}
