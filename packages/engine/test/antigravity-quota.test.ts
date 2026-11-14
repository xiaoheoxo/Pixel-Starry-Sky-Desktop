import { describe, expect, it, vi } from 'vitest'
import { AntigravityAdapter } from '../src/antigravity'
import { parseAgyUsage } from '../src/antigravity/quota'

const SAMPLE_USAGE_JSON = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  response: '',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            {
              id: 'gemini-weekly',
              name: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining_fraction: 0.9815081357955933,
              reset_time: '2026-11-21T12:43:00Z',
            },
            {
              id: 'gemini-5h',
              name: 'Five Hour Limit Remaining',
              window: '5h',
              remaining_fraction: 0.9280962347984314,
              reset_time: '2026-11-14T17:43:00Z',
            },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            {
              id: '3p-weekly',
              window: 'weekly',
              remaining_fraction: 0.4,
              reset_time: '2026-11-21T16:45:52Z',
            },
            {
              id: '3p-5h',
              window: '5h',
              remaining_fraction: 0.1,
              reset_time: '2026-11-14T21:45:52Z',
            },
          ],
        },
      ],
    },
  },
})

describe('parseAgyUsage', () => {
  it('只提取 Gemini Models 的 5 小时与每周额度并忽略第三方模型池', () => {
    const reading = parseAgyUsage(SAMPLE_USAGE_JSON, 1_700_000_000_000, 'Google AI Ultra')
    expect(reading).toEqual({
      kind: 'ok',
      plan: 'Google AI Ultra',
      account: null,
      windows: [
        {
          id: 'five_hour',
          durationMins: 300,
          usedPercent: 7.19,
          resetsAt: Date.parse('2026-11-14T17:43:00Z'),
        },
        {
          id: 'seven_day',
          durationMins: 10_080,
          usedPercent: 1.85,
          resetsAt: Date.parse('2026-11-21T12:43:00Z'),
        },
      ],
      extras: {},
      blocked: null,
      observedAt: 1_700_000_000_000,
    })
  })

  it('remaining_fraction 为 0 时标记为已用完（rejected）', () => {
    const json = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [{ id: 'gemini-5h', window: '5h', remaining_fraction: 0, reset_time: '2026-11-14T17:43:00Z' }],
            },
          ],
        },
      },
    })
    const reading = parseAgyUsage(json, 1_700_000_000_000)
    expect(reading).toMatchObject({
      kind: 'ok',
      windows: [{ id: 'five_hour', durationMins: 300, usedPercent: 100, rejected: true }],
    })
  })

  it('只有第三方模型组或 JSON 异常时抛出无数据错误；status 失败时抛出详情', () => {
    const only3p = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Claude and GPT models',
              buckets: [{ id: '3p-5h', window: '5h', remaining_fraction: 0.5, reset_time: '2026-11-14T17:43:00Z' }],
            },
          ],
        },
      },
    })
    expect(() => parseAgyUsage(only3p, 1)).toThrow('没有拿到额度数据')
    expect(() => parseAgyUsage('not-json', 1)).toThrow('没有拿到额度数据')
    expect(() => parseAgyUsage(JSON.stringify({ status: 'ERROR', response: 'network timeout' }), 1)).toThrow(
      'network timeout',
    )
  })
})

describe('AntigravityAdapter.accountQuota', () => {
  it('API Key 模式或未登录返回 unsupported；Antigravity 登录传递 tier 并合并并发请求', async () => {
    const apiKeyAdapter = new AntigravityAdapter({
      overridePath: () => process.execPath,
      probe: async () => ({ signedIn: true, kind: 'apiKey' }),
      fetchQuota: vi.fn(),
    })
    expect(await apiKeyAdapter.accountQuota()).toEqual({ kind: 'unsupported' })

    let resolveFetch!: (v: ReturnType<typeof parseAgyUsage>) => void
    const fetchQuota = vi.fn(
      (_launcher, _env, plan) =>
        new Promise<ReturnType<typeof parseAgyUsage>>(r => {
          resolveFetch = r
          expect(plan).toBe('Google AI Ultra')
        }),
    )
    const loginAdapter = new AntigravityAdapter({
      overridePath: () => process.execPath,
      probe: async () => ({ signedIn: true, kind: 'login', plan: 'Google AI Ultra' }),
      fetchQuota,
    })
    const p1 = loginAdapter.accountQuota()
    const p2 = loginAdapter.accountQuota()
    // 两次并发均等同一个探针：只触发一次 fetchQuota，结果相同
    await vi.waitFor(() => expect(fetchQuota).toHaveBeenCalledTimes(1))
    resolveFetch(parseAgyUsage(SAMPLE_USAGE_JSON, 100, 'Google AI Ultra'))
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toMatchObject({ kind: 'ok', plan: 'Google AI Ultra' })
    expect(r2).toEqual(r1)
    expect(fetchQuota).toHaveBeenCalledTimes(1)

    await loginAdapter.close()
    await expect(loginAdapter.accountQuota()).rejects.toThrow('Antigravity unavailable')
  })
})
