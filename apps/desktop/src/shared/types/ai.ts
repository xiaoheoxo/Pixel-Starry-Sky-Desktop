// AI 写提交信息（docs/ui/ai-commit-codex-warnings-history.md §2）：渲染层和主进程之间的数据
import type { GitCommitScope } from './project-tools'
import type { WorkspaceRef } from './workspace'

/**
 * 用哪条通道（docs/ui/ai-commit-channels.md）：像素星空云端（照常从账号余额扣费）/ Claude 授权（本机 Claude Code + 订阅）/
 * ChatGPT 授权（本机 Codex + 账号）/ 自定义 API
 */
export type AiSource = 'platform' | 'claude' | 'codex' | 'custom'
/** auto：跟随仓库最近的提交，没有提交时用界面语言 */
export type AiCommitLanguage = 'auto' | 'zh' | 'en'
/** subject：只写一行标题；body：改动多时加简短正文 */
export type AiCommitStyle = 'subject' | 'body'

/** 一次性调用都带的：用哪条通道、哪个模型（AI 写提交信息、优化提示词共用一套设置） */
export interface AiChannelRequest {
  /** 渲染层生成；停止（ai:cancel）、查实际扣费（ai:commitCharge）用 */
  requestId: string
  source: AiSource
  /** 云端：按顺序试的线路，线路拒绝时换下一条（最多 3 条） */
  groups: string[]
  /** 自定义 API：接口 */
  providerId: string | null
  /** Claude / ChatGPT 授权可以为空：跟随引擎自己的设置 */
  model: string
}

export interface AiCommitRequest extends AiChannelRequest {
  ref: WorkspaceRef
  scope: GitCommitScope
  language: AiCommitLanguage
  /** 界面语言：language 为 auto 且仓库还没有提交时用 */
  uiLanguage: 'zh' | 'en'
  style: AiCommitStyle
  /** 额外要求（最多 1000 字） */
  instructions: string
}

/** 优化提示词（docs/ui/prompt-optimize.md）：把输入框里的话改写得更清楚，结果的 message 是改写后的全文 */
export interface AiPromptRequest extends AiChannelRequest {
  /** 输入框里的原文（最多 PROMPT_TEXT_LIMIT 字） */
  text: string
  /** 项目名、对话标题、最近几轮对话的摘录；新对话为空（最多 PROMPT_CONTEXT_LIMIT 字） */
  context: string
}
export const PROMPT_TEXT_LIMIT = 20_000
export const PROMPT_CONTEXT_LIMIT = 8_000

export interface AiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * 出错的原因（界面按它给说法和按钮）：
 * signedOut 没登录或登录过期；balance 余额不足；route 线路拒绝；model 没有这个模型；rateLimit 太频繁；
 * provider 自定义接口不可用（删了、没 Key、拒绝 Key、地址不对）；network 连不上；timeout 超时；
 * empty 模型没写出东西；nothing 没有要提交的改动；cancelled 停止了；failed 其他；
 * tooLong 写到输出上限被截断（优化提示词）；
 * Claude / ChatGPT 授权：notInstalled 引擎没装；notAuthorized 没授权或授权失效；usageLimit 订阅额度用完（detail 是原话，带恢复时间）
 */
export type AiProblem =
  | 'signedOut'
  | 'balance'
  | 'route'
  | 'model'
  | 'rateLimit'
  | 'provider'
  | 'network'
  | 'timeout'
  | 'empty'
  | 'nothing'
  | 'cancelled'
  | 'failed'
  | 'notInstalled'
  | 'notAuthorized'
  | 'usageLimit'
  | 'tooLong'

export type AiCommitResult =
  | {
      ok: true
      message: string
      /** 实际用的模型（引擎报的；没报时是请求里的，可能为空） */
      model: string
      /** 云端用的线路；自定义 API 为 null */
      groupId: string | null
      usage: AiUsage | null
      /** 太长只给 AI 看了一部分、或超出上限只列了名字的文件数 */
      partial: number
      /** 云端：可以用 ai:commitCharge 查实际扣费 */
      chargeable: boolean
    }
  | { ok: false; problem: AiProblem; detail: string }
