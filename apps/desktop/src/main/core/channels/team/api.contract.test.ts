import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TeamApi, parseMessage, parseOverview, type TeamFetch } from './api'

// 云端服务的契约样例（services/cloud/testdata/contract/desktop/teams-*.json，形如 {endpoint, status, body}）：
// Go 那边检查实际响应和样例一致，这里用同一份样例喂桌面端的解析代码。样例还没生成时整组跳过。
const dir = fileURLToPath(new URL('../../../../../../../services/cloud/testdata/contract/desktop/', import.meta.url))

interface Sample {
  endpoint: string
  status: number
  body: unknown
}
const sample = (name: string): Sample => JSON.parse(readFileSync(dir + name, 'utf8')) as Sample
const files = existsSync(dir) ? readdirSync(dir).filter(n => /^teams-.*\.json$/.test(n)) : []
const hasSamples = files.length > 0

function expectFields(value: Record<string, unknown>, fields: Record<string, string | string[]>): void {
  for (const [key, type] of Object.entries(fields)) {
    const actual = value[key] === null ? 'null' : typeof value[key]
    expect([type].flat(), `${key} 的类型`).toContain(actual)
  }
}

function serve(s: Sample): TeamApi {
  const fetcher: TeamFetch = async () =>
    new Response(JSON.stringify(s.body), { status: s.status, headers: { 'Content-Type': 'application/json' } })
  return new TeamApi(fetcher)
}

const ROLES = ['owner', 'member', 'observer']
const STATUSES = ['queued', 'approval', 'running', 'waiting', 'done', 'failed', 'stopped']

function expectMessage(raw: unknown): void {
  const m = parseMessage(raw)
  expect(m, '消息能解析').not.toBeNull()
  expectFields(m as unknown as Record<string, unknown>, {
    id: 'string',
    channelId: 'string',
    n: 'number',
    seq: 'number',
    kind: 'string',
    author: 'string',
    text: 'string',
    format: 'string',
    mentions: 'object',
    createdAt: 'number',
    updatedAt: 'number',
  })
  expect(['message', 'task', 'event']).toContain(m!.kind)
  expect(m!.createdAt).toBeGreaterThan(0)
  if (m!.kind === 'task') {
    expect(m!.task).not.toBeNull()
    expectFields(m!.task as unknown as Record<string, unknown>, {
      assignee: 'string',
      owner: 'string',
      title: 'string',
      status: 'string',
      round: 'number',
      claimedBy: ['string', 'null'],
      pendingAction: ['string', 'null'],
      sourceMessage: ['string', 'null'],
      endedAt: ['number', 'null'],
    })
    expect(STATUSES).toContain(m!.task!.status)
  }
  if (m!.kind === 'event') expect(m!.event).not.toBeNull()
}

describe.skipIf(!hasSamples)('云端契约样例：团队', () => {
  for (const name of files) {
    const s = sample(name)
    const body = (s.body ?? {}) as Record<string, unknown>
    if (s.status >= 200 && s.status < 300 && Array.isArray(body.teams)) {
      it(`${name}：总览字段和类型`, async () => {
        const ov = await serve(s).overview()
        expectFields(ov.me as unknown as Record<string, unknown>, { id: 'string', name: 'string', email: 'string' })
        expect(ov.teams).toHaveLength((body.teams as unknown[]).length)
        for (const t of ov.teams) {
          expect(ROLES).toContain(t.role)
          expectFields(t as unknown as Record<string, unknown>, { id: 'string', name: 'string', seq: 'number' })
          for (const m of t.members)
            expectFields(m as unknown as Record<string, unknown>, {
              id: 'string',
              role: 'string',
              online: 'boolean',
              lastSeenAt: ['number', 'null'],
            })
          for (const c of t.channels)
            expectFields(c as unknown as Record<string, unknown>, {
              id: 'string',
              name: 'string',
              topic: ['string', 'null'],
              createdAt: 'number',
              lastAt: 'number',
              seq: 'number',
              lastN: 'number',
              readN: 'number',
              unread: 'number',
              mentioned: 'boolean',
            })
          for (const a of t.agents) {
            expectFields(a as unknown as Record<string, unknown>, {
              id: 'string',
              channelId: 'string',
              owner: 'string',
              localId: 'string',
              name: 'string',
              engine: 'string',
              policy: 'string',
              status: 'string',
              task: ['string', 'null'],
            })
            expect(['owner', 'approve', 'listed', 'team']).toContain(a.policy)
            expect(Array.isArray(a.allow)).toBe(true)
          }
        }
        for (const i of ov.invites)
          expectFields(i as unknown as Record<string, unknown>, {
            id: 'string',
            teamId: 'string',
            teamName: 'string',
            inviter: 'string',
            role: 'string',
            expiresAt: 'number',
          })
      })
    } else if (s.status >= 200 && s.status < 300 && (Array.isArray(body.items) || body.item)) {
      // 收件箱（docs/multica-learn.md §11.5）：每一行都认得，种类都是已知的
      it(`${name}：收件箱`, async () => {
        const api = serve(s)
        const items = Array.isArray(body.items)
          ? await api.inbox()
          : [await api.patchInbox('tm_1', 'tg_1', { read: true })]
        expect(items).toHaveLength(Array.isArray(body.items) ? body.items.length : 1)
        expect(items!.length).toBeGreaterThan(0)
        for (const it of items!)
          expectFields(it as unknown as Record<string, unknown>, {
            teamId: 'string',
            key: 'string',
            channelId: 'string',
            kind: 'string',
            actor: 'string',
            text: 'string',
            count: 'number',
            at: 'number',
            read: 'boolean',
            archived: 'boolean',
            snoozeUntil: ['number', 'null'],
            muted: 'boolean',
          })
      })
    } else if (s.status >= 200 && s.status < 300 && Array.isArray(body.messages)) {
      it(`${name}：消息列表`, async () => {
        const page = await serve(s).messages('tm_1', 'tc_1')
        expect(page.messages).toHaveLength((body.messages as unknown[]).length)
        expect(typeof page.hasMore).toBe('boolean')
        for (const m of body.messages as unknown[]) expectMessage(m)
      })
    } else if (s.status >= 200 && s.status < 300 && Array.isArray(body.tasks) && body.message === undefined) {
      it(`${name}：待办或发消息的响应`, async () => {
        const api = serve(s)
        if (/tasks\/mine/.test(s.endpoint)) {
          const mine = await api.tasksMine()
          expect(mine).toHaveLength((body.tasks as unknown[]).length)
          for (const m of mine) expect(m.teamId).not.toBe('')
        }
        for (const t of body.tasks as Record<string, unknown>[]) expectMessage(t.message ?? t)
      })
    } else if (s.status >= 200 && s.status < 300 && body.message) {
      it(`${name}：带消息的响应`, async () => {
        expectMessage(body.message)
        // 开工前核对（docs/multica-learn.md §11.3）：结果和这一轮的运行凭证
        if (s.endpoint.endsWith('/start')) {
          const res = await serve(s).start('tm_1', 'tg_1', 'laptop')
          expect(res.outcome).toBe(body.outcome)
          expect(res.runToken).toMatch(/^rt_/)
        }
        for (const t of (Array.isArray(body.tasks) ? body.tasks : []) as unknown[]) expectMessage(t)
      })
    } else if (s.status >= 400) {
      it(`${name}：HTTP ${s.status} 变成带 code 的中文错误`, async () => {
        const expected =
          (
            {
              400: 'INVALID',
              401: 'RUN_TOKEN',
              403: 'FORBIDDEN',
              404: 'NOT_FOUND',
              409: 'CONFLICT',
              413: 'INVALID',
              429: 'RATE_LIMITED',
            } as Record<number, string>
          )[s.status] ?? 'UNAVAILABLE'
        const message = typeof body.error === 'string' ? body.error : ''
        await expect(serve(s).respondInvite('iv_1', true)).rejects.toMatchObject({
          code: expected,
          ...(message && { message }),
        })
      })
    }
  }

  it('parseOverview 对样例不抛错', () => {
    for (const name of files) {
      const s = sample(name)
      if (s.status === 200 && /GET \/v1\/teams$/.test(s.endpoint)) expect(parseOverview(s.body).teams).toBeDefined()
    }
  })
})
