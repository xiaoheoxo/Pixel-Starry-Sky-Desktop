import type { CodexRpc } from './reader'
import { object, string } from './process'

/** 内存中的 ChatGPT 连接信息；持久化、系统凭据库及令牌刷新仍由 Codex 管理。 */
export interface ChatGptCredentials {
  accessToken: string
  accountId: string
  accountUserId: string
  userId?: string
  plan: string | null
}

function claims(token: string): Record<string, unknown> {
  try {
    const parts = token.split('.')
    return parts.length === 3 ? object(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))) : {}
  } catch {
    return {}
  }
}

/** 通过已有 app-server 读取当前 CODEX_HOME 的登录，兼容 Codex 的文件和系统凭据库存储。 */
export async function readChatGptCredentials(rpc: CodexRpc, signal?: AbortSignal): Promise<ChatGptCredentials | null> {
  let auth = await rpc.request('getAuthStatus', { includeToken: true, refreshToken: false }, signal)
  if (auth.authMethod !== 'chatgpt' || !string(auth.authToken)) return null
  let jwt = claims(string(auth.authToken))
  if (typeof jwt.exp === 'number' && jwt.exp * 1000 <= Date.now() + 60_000) {
    auth = await rpc.request('getAuthStatus', { includeToken: true, refreshToken: true }, signal)
    jwt = claims(string(auth.authToken))
  }
  const identity = object(jwt['https://api.openai.com/auth'])
  const accountId = string(identity.chatgpt_account_id)
  const accountUserId = string(identity.chatgpt_account_user_id) || string(identity.chatgpt_user_id)
  if (
    auth.authMethod !== 'chatgpt' ||
    !accountId ||
    !accountUserId ||
    typeof jwt.exp !== 'number' ||
    jwt.exp * 1000 <= Date.now()
  )
    return null
  return {
    accessToken: string(auth.authToken),
    accountId,
    accountUserId,
    ...(string(identity.chatgpt_user_id) ? { userId: string(identity.chatgpt_user_id) } : {}),
    plan: string(identity.chatgpt_plan_type) || null,
  }
}
