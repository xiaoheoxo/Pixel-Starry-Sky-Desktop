import { describe, expect, it } from 'vitest'
import { TeamApi, TeamError, parseMessage, parseOverview, type TeamFetch } from './api'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function api(handler: (method: string, path: string, body: unknown) => Response | Promise<Response>) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const fetcher: TeamFetch = async (method, path, body) => {
    calls.push({ method, path, body })
    return handler(method, path, body)
  }
  return { api: new TeamApi(fetcher), calls }
}

describe('parseOverview / parseMessage', () => {
  it('snake_case 转 camelCase，时间转毫秒', () => {
    const ov = parseOverview({
      me: { id: 'u:1', name: '林夏', email: 'a@b.c' },
      teams: [
        {
          id: 'tm_1',
          name: '小队',
          role: 'owner',
          seq: 4,
          members: [
            {
              id: 'u:2',
              name: '周宁',
              email: 'z@b.c',
              role: 'member',
              online: true,
              last_seen_at: '2026-10-14T06:00:00Z',
            },
          ],
          invites: [{ id: 'iv_1', email: 'w@b.c', role: 'member', expires_at: '2026-10-28T06:00:00Z' }],
          channels: [
            {
              id: 'tc_1',
              name: '更新日志',
              topic: null,
              created_by: 'u:1',
              created_at: '2026-10-14T05:00:00Z',
              last_at: '2026-10-14T06:00:00Z',
              seq: 4,
              last_n: 7,
              read_n: 5,
              unread: 2,
              mentioned: true,
            },
          ],
          agents: [
            {
              id: 'ta_1',
              channel_id: 'tc_1',
              owner: 'u:2',
              local_id: 'm-1',
              name: '审查员',
              engine: 'codex',
              model: 'gpt',
              machine: '周宁的电脑',
              project: 'api',
              policy: 'team',
              status: 'running',
              task: '看 PR',
              updated_at: '2026-10-14T06:00:00Z',
            },
          ],
        },
      ],
      invites: [
        {
          id: 'iv_2',
          team_id: 'tm_2',
          team_name: '设计组',
          inviter: '周宁',
          role: 'observer',
          expires_at: '2026-10-28T06:00:00Z',
        },
      ],
    })
    expect(ov.teams[0].members[0]).toMatchObject({ lastSeenAt: Date.parse('2026-10-14T06:00:00Z'), online: true })
    expect(ov.teams[0].channels[0]).toMatchObject({ lastN: 7, readN: 5, unread: 2, mentioned: true, topic: null })
    expect(ov.teams[0].agents[0]).toMatchObject({
      localId: 'm-1',
      channelId: 'tc_1',
      policy: 'team',
      status: 'running',
    })
    expect(ov.teams[0].invites[0].expiresAt).toBeGreaterThan(0)
    expect(ov.invites[0]).toMatchObject({ teamId: 'tm_2', teamName: '设计组', role: 'observer' })
  })

  it('任务卡字段', () => {
    const m = parseMessage({
      id: 'tg_1',
      channel_id: 'tc_1',
      n: 3,
      seq: 9,
      kind: 'task',
      author: 'u:1',
      created_at: '2026-10-14T06:00:00Z',
      task: {
        assignee: 'ta_1',
        owner: 'u:2',
        title: '改设置页',
        status: 'approval',
        round: 2,
        diff: { added: 3, removed: 1 },
        progress: { done: 1, total: 4 },
        claimed_by: 'dev-1',
        pending_action: 'stop',
        followup_message: 'tg_9',
        note: 'rejected',
      },
    })!
    expect(m.task).toMatchObject({
      status: 'approval',
      round: 2,
      diff: { added: 3, removed: 1 },
      progress: { done: 1, total: 4 },
      claimedBy: 'dev-1',
      pendingAction: 'stop',
      followupMessage: 'tg_9',
      note: 'rejected',
      error: null,
    })
    expect(parseMessage({ id: 'x', kind: 'weird' })?.kind).toBe('message')
    // 不认识的 pending_action 当作没有，不回退成取消
    const later = parseMessage({ id: 'tg_2', kind: 'task', task: { status: 'running', pending_action: 'pause' } })!
    expect(later.task?.pendingAction).toBeNull()
    expect(parseMessage({})).toBeNull()
  })
})

describe('TeamApi 错误码', () => {
  const codes: [number, string][] = [
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [429, 'RATE_LIMITED'],
    [400, 'INVALID'],
    [413, 'INVALID'],
    [500, 'UNAVAILABLE'],
  ]
  for (const [status, code] of codes)
    it(`HTTP ${status} → ${code}，带上云端的中文原因`, async () => {
      const t = api(() => json({ error: '没有权限' }, status))
      await expect(t.api.deleteTeam('tm_1')).rejects.toMatchObject({ code, message: '没有权限' })
    })

  it('总览 404 是 NOT_DEPLOYED（云端还没有这个接口）', async () => {
    const t = api(() => json({ error: 'not found' }, 404))
    await expect(t.api.overview()).rejects.toMatchObject({ code: 'NOT_DEPLOYED' })
  })

  it('网络错误、超时 → UNAVAILABLE；登录过期 → AUTH_EXPIRED', async () => {
    await expect(
      new TeamApi(async () => Promise.reject(new TypeError('fetch failed'))).overview(),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    await expect(new TeamApi(async () => Promise.reject(timeout)).overview()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
    const expired = Object.assign(new Error('登录已过期'), { code: 'AUTH_EXPIRED' })
    await expect(new TeamApi(async () => Promise.reject(expired)).overview()).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      message: '登录已过期',
    })
    await expect(new TeamApi(async () => Promise.reject(new Error('请先登录像素星空账号'))).overview()).rejects.toThrow(
      '请先登录',
    )
  })

  it('响应不是 JSON → UNAVAILABLE', async () => {
    const t = api(() => new Response('<html>', { status: 200 }))
    await expect(t.api.overview()).rejects.toBeInstanceOf(TeamError)
  })
})

describe('TeamApi 请求', () => {
  it('路径和请求体', async () => {
    const msg = {
      id: 'tg_1',
      channel_id: 'tc_1',
      n: 1,
      seq: 1,
      kind: 'task',
      author: 'u:1',
      task: { assignee: 'ta_1', owner: 'u:1', status: 'queued' },
    }
    const t = api(() => json({ message: msg, tasks: [msg] }))
    await t.api.postMessage('tm_1', 'tc_1', {
      clientId: 'c1',
      text: '你好',
      replyTo: 'tg_0',
      mentions: ['u:2'],
      agentId: 'ta_1',
      taskId: 'tg_5',
    })
    await t.api.messages('tm_1', 'tc_1', { before: 30, limit: 50 })
    await t.api.messages('tm_1', 'tc_1', { after: 77 })
    await t.api.claim('tm_1', 'tg_1', 'dev-1')
    await t.api.patchTask('tm_1', 'tg_1', { status: 'done', clearAction: true, summary: '好了' })
    await t.api.approve('tm_1', 'tg_1', true)
    await t.api.action('tm_1', 'tg_1', 'stop')
    await t.api.respondInvite('iv_1', false)
    await t.api.markRead('tm_1', 'tc_1', 12)
    await t.api.invite('tm_1', 'a@b.c', 'observer')
    await t.api.setRole('tm_1', 'u:2', 'member')
    await t.api.removeMember('tm_1', 'u:2')
    await t.api.rename('tm_1', '小林')
    expect(t.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/teams/tm_1/channels/tc_1/messages',
      'GET /v1/teams/tm_1/channels/tc_1/messages?before=30&limit=50',
      'GET /v1/teams/tm_1/channels/tc_1/messages?after=77',
      'POST /v1/teams/tm_1/tasks/tg_1/claim',
      'PATCH /v1/teams/tm_1/tasks/tg_1',
      'POST /v1/teams/tm_1/tasks/tg_1/approve',
      'POST /v1/teams/tm_1/tasks/tg_1/action',
      'POST /v1/invites/iv_1/decline',
      'POST /v1/teams/tm_1/channels/tc_1/read',
      'POST /v1/teams/tm_1/invites',
      'PATCH /v1/teams/tm_1/members/u%3A2',
      'DELETE /v1/teams/tm_1/members/u%3A2',
      'PATCH /v1/teams/tm_1/me',
    ])
    expect(t.calls[0].body).toEqual({
      client_id: 'c1',
      text: '你好',
      reply_to: 'tg_0',
      mentions: ['u:2'],
      agent_id: 'ta_1',
      task_id: 'tg_5',
    })
    expect(t.calls[3].body).toEqual({ device: 'dev-1' })
    expect(t.calls[4].body).toEqual({ status: 'done', summary: '好了', clear_action: true })
  })
})
