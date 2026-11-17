import { describe, expect, it, vi } from 'vitest'
import { readChatGptCredentials } from '../src/codex/chatgpt'

const token = (auth: Record<string, string>, exp = Date.now() / 1000 + 3600) =>
  `header.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': auth })).toString('base64url')}.signature`
const claims = { chatgpt_account_id: 'workspace', chatgpt_account_user_id: 'member', chatgpt_user_id: 'user' }

describe('shared Codex ChatGPT credentials', () => {
  it('uses the existing app-server login without copying saved credentials', async () => {
    const accessToken = token(claims)
    const request = vi.fn().mockResolvedValue({ authMethod: 'chatgpt', authToken: accessToken })
    expect(await readChatGptCredentials({ request })).toEqual({
      accessToken,
      accountId: 'workspace',
      accountUserId: 'member',
      userId: 'user',
      plan: null,
    })
    expect(request).toHaveBeenCalledWith('getAuthStatus', { includeToken: true, refreshToken: false }, undefined)
  })

  it('lets Codex refresh an expiring token and reads the refreshed identity', async () => {
    const renewed = token({ ...claims, chatgpt_account_id: 'renewed' })
    const request = vi
      .fn()
      .mockResolvedValueOnce({ authMethod: 'chatgpt', authToken: token(claims, 1) })
      .mockResolvedValueOnce({ authMethod: 'chatgpt', authToken: renewed })
    expect(await readChatGptCredentials({ request })).toMatchObject({ accessToken: renewed, accountId: 'renewed' })
    expect(request).toHaveBeenLastCalledWith('getAuthStatus', { includeToken: true, refreshToken: true }, undefined)
  })

  it('accepts the canonical user id when the account-member claim is absent', async () => {
    const request = vi.fn().mockResolvedValue({
      authMethod: 'chatgpt',
      authToken: token({ chatgpt_account_id: 'workspace', chatgpt_user_id: 'user' }),
    })
    expect(await readChatGptCredentials({ request })).toMatchObject({ accountUserId: 'user' })
  })

  it.each([
    { authMethod: 'apikey', authToken: 'private-api-key' },
    { authMethod: null, authToken: null },
    { authMethod: 'chatgpt', authToken: 'invalid-private-token' },
    { authMethod: 'chatgpt', authToken: token({ chatgpt_user_id: 'user' }) },
  ])('does not accept API keys, signed-out state or incomplete identities', async response => {
    expect(await readChatGptCredentials({ request: vi.fn().mockResolvedValue(response) })).toBeNull()
  })
})
