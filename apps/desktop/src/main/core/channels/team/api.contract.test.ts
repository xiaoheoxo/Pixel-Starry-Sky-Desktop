import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TeamApi, isObj, parseAgent, parseMessage, parseOverview, type TeamFetch, type TeamTaskData } from './api'

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
  // 204 不能带响应体
  const fetcher: TeamFetch = async () =>
    new Response(s.status === 204 ? null : JSON.stringify(s.body), {
      status: s.status,
      headers: { 'Content-Type': 'application/json' },
    })
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
    // 事项唤醒（docs/multica-learn.md §11.6）：云端带了 wakeups 字段，每条规则都认得（不认识的会被丢掉）
    const wakeups = (raw as { task?: { wakeups?: unknown } }).task?.wakeups
    if (Array.isArray(wakeups)) {
      expect(m!.task!.wakeups, '规则一条都不丢').toHaveLength(wakeups.length)
      for (const w of m!.task!.wakeups!) expectWakeup(w)
    }
  }
  if (m!.kind === 'event') expect(m!.event).not.toBeNull()
}

/** 成员的由谁接、绑的执行机：样例里有这两个字段时逐个对上（旧样例没有，跳过） */
function expectExecutor(raw: Record<string, unknown>, agent: ReturnType<typeof parseAgent>): void {
  expect(agent).not.toBeNull()
  if ('executor' in raw) expect(agent!.executor).toBe(raw.executor || null)
  if (!('runner' in raw)) return
  if (!isObj(raw.runner)) return expect(agent!.runner).toBeNull()
  expectFields(agent!.runner as unknown as Record<string, unknown>, {
    id: 'string',
    name: 'string',
    online: 'boolean',
    lastSeenAt: ['number', 'null'],
  })
  expect(agent!.runner!.id).toBe(raw.runner.id)
  expect(agent!.executor).toBe(agent!.runner!.id)
}

function expectWakeup(w: NonNullable<TeamTaskData['wakeups']>[number]): void {
  expectFields(w as unknown as Record<string, unknown>, {
    id: 'string',
    member: 'string',
    owner: 'string',
    by: 'string',
    text: 'string',
    until: ['number', 'null'],
    next: ['number', 'null'],
    fired: 'number',
    card: ['string', 'null'],
    state: 'string',
    endNote: ['string', 'null'],
    approved: 'boolean',
    createdAt: 'number',
    lastAt: ['number', 'null'],
  })
  expect(['at', 'every']).toContain(w.when.kind)
  if (w.when.kind === 'every') expect(w.when.tz).not.toBe('')
  expect(w.createdAt).toBeGreaterThan(0)
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
        // 由谁接、绑的执行机（docs/multica-learn.md §11.7）：云端带了就原样解析出来
        const raws = (body.teams as { agents?: Record<string, unknown>[] }[]).flatMap(t => t.agents ?? [])
        const parsed = ov.teams.flatMap(t => t.agents)
        expect(parsed).toHaveLength(raws.length)
        raws.forEach((raw, i) => expectExecutor(raw, parsed[i]))
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

  // 事项唤醒（docs/multica-learn.md §11.6 团队部分）的样例：云端分支还没合进 services/cloud 时没有这几份，各自跳过
  const has = (name: string): boolean => files.includes(name)

  // 附件（docs/ui/channels-unify.md §9）
  it.skipIf(!has('teams-attachment-upload.json'))('teams-attachment-upload.json：上传返回说明', async () => {
    const s = sample('teams-attachment-upload.json')
    const meta = await serve(s).uploadAttachment('tm_1', 'tc_1', { kind: 'file', name: '日志.txt', dataBase64: 'YQ==' })
    expect(meta).toMatchObject({ kind: 'file', name: '日志.txt', mime: 'text/plain', bytes: 9000, lines: 120 })
    expect(meta.id).toBe((s.body as { id: string }).id)
  })
  it.skipIf(!has('teams-attachment-get.json'))('teams-attachment-get.json：取到说明和内容', async () => {
    const s = sample('teams-attachment-get.json')
    const data = await serve(s).getAttachment('tm_1', 'tf_1')
    expect(data).toMatchObject({ kind: 'file', name: '日志.txt', encoding: 'gb18030' })
    expect(Buffer.from(data.dataBase64, 'base64').toString('utf8')).toBe('第一行\n第二行')
  })
  it.skipIf(!has('teams-post-attachments.json'))('teams-post-attachments.json：消息带着附件说明', () => {
    const body = sample('teams-post-attachments.json').body as { message: unknown }
    expect(parseMessage(body.message)?.attachments).toMatchObject([
      { kind: 'image', name: '截图.png', width: 4, height: 3 },
    ])
  })
  it.skipIf(!has('teams-attachment-upload.json') || !has('teams-overview.json'))(
    'teams-overview.json：云端支持附件时总览带着上限；没有那几项是 null',
    async () => {
      const s = sample('teams-overview.json')
      const ov = await serve(s).overview()
      expect(ov.attach).toEqual({ images: 5, files: 5, imageBytes: 2 << 20, fileBytes: 256 << 10 })
      const { limits: _l, ...old } = s.body as Record<string, unknown>
      expect((await serve({ ...s, body: old }).overview()).attach).toBeNull()
    },
  )

  it.skipIf(!has('teams-wakeup-add.json'))('teams-wakeup-add.json：挂唤醒返回卡和新规则', async () => {
    const s = sample('teams-wakeup-add.json')
    const res = await serve(s).addWakeup('tm_1', 'tg_1', {
      member: 'ta_1',
      when: { kind: 'at', at: 1 },
      text: 'x',
      until: null,
    })
    expect(res.wakeup).not.toBeNull()
    expect(res.message.task?.wakeups?.some(w => w.id === res.wakeup!.id)).toBe(true)
    expect(['pending', 'active']).toContain(res.wakeup!.state)
    expect(res.message.task?.wake).toBeNull()
  })

  it.skipIf(!has('teams-wakeup-cancel.json'))('teams-wakeup-cancel.json：取消返回卡', async () => {
    const m = await serve(sample('teams-wakeup-cancel.json')).cancelWakeup('tm_1', 'tg_1', 'tw_1')
    expect(m.task?.wakeups?.some(w => w.state === 'cancelled')).toBe(true)
  })

  it.skipIf(!has('teams-wakeup-approve.json'))('teams-wakeup-approve.json：主人同意返回卡', async () => {
    const m = await serve(sample('teams-wakeup-approve.json')).approveWakeup('tm_1', 'tg_1', 'tw_1', true)
    expect(m.task?.wakeups?.some(w => w.state === 'active' && w.approved)).toBe(true)
  })

  it.skipIf(!has('teams-wakeup-fired.json'))('teams-wakeup-fired.json：唤醒卡带 wake，被盯的卡记下唤醒卡', async () => {
    const page = await serve(sample('teams-wakeup-fired.json')).messages('tm_1', 'tc_1')
    const cards = page.messages.filter(m => m.task)
    const woken = cards.find(m => m.task!.wake)
    expect(woken?.task?.wake).toMatchObject({ ruleId: expect.any(String), kind: expect.any(String) })
    const watched = cards.find(m => m.task!.wakeups?.some(w => w.id === woken!.task!.wake!.ruleId))
    expect(watched?.task?.wakeups?.find(w => w.id === woken!.task!.wake!.ruleId)?.card).toBe(woken!.id)
  })

  // 执行机（docs/multica-learn.md §11.7）的样例：同上，云端分支没合进 services/cloud 时各自跳过
  it.skipIf(!has('teams-agent-put.json'))('teams-agent-put.json：登记返回的成员带由谁接', () => {
    const s = sample('teams-agent-put.json')
    expectExecutor(s.body as Record<string, unknown>, parseAgent(s.body))
  })

  it.skipIf(!has('teams-runner-pairing.json'))('teams-runner-pairing.json：配对码和到期时间', async () => {
    const res = await serve(sample('teams-runner-pairing.json')).runnerPairing('hk-1')
    expect(res.code).toHaveLength(16)
    expect(res.expiresAt).toBeGreaterThan(0)
  })

  it.skipIf(!has('teams-runner-pair.json'))('teams-runner-pair.json：执行机换到 id 和令牌', async () => {
    const res = await serve(sample('teams-runner-pair.json')).pairRunner('aAJcAUWH7oiYINpX', '0.9.0')
    expect(res.runnerId).toMatch(/^rn_/)
    expect(res.token).toMatch(/^rn_/)
    expect(res.name).not.toBe('')
  })

  it.skipIf(!has('teams-runner-seats.json'))('teams-runner-seats.json：席位满了要配对码是 CONFLICT', async () => {
    const s = sample('teams-runner-seats.json')
    await expect(serve(s).runnerPairing('hk-1')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: (s.body as { error: string }).error,
    })
  })

  it.skipIf(!has('teams-runner-pair-invalid.json'))('teams-runner-pair-invalid.json：码不对是 NOT_FOUND', async () => {
    await expect(serve(sample('teams-runner-pair-invalid.json')).pairRunner('x', '1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it.skipIf(!has('teams-runners.json'))('teams-runners.json：我的执行机', async () => {
    const s = sample('teams-runners.json')
    const list = await serve(s).runners()
    expect(list).toHaveLength((s.body as { runners: unknown[] }).runners.length)
    for (const r of list!)
      expectFields(r as unknown as Record<string, unknown>, {
        id: 'string',
        name: 'string',
        version: ['string', 'null'],
        createdAt: 'number',
        lastSeenAt: ['number', 'null'],
        online: 'boolean',
      })
  })

  it.skipIf(!has('teams-runner-remove.json'))('teams-runner-remove.json：停用是 204', async () => {
    await expect(serve(sample('teams-runner-remove.json')).removeRunner('rn_1')).resolves.toBeUndefined()
  })

  it('parseOverview 对样例不抛错', () => {
    for (const name of files) {
      const s = sample(name)
      if (s.status === 200 && /GET \/v1\/teams$/.test(s.endpoint)) expect(parseOverview(s.body).teams).toBeDefined()
    }
  })
})
