import { describe, expect, it, vi } from 'vitest'
import { aggregateIq, CloudModelIq, parseAnalysis, parseRadar } from '../src/host/model-iq'

const now = Date.parse('2026-11-23T00:00:00Z')
const day = 86_400_000
const scores = {
  'gpt-6.2-astra': 135,
  'gpt-6.2-sol': 133,
  'gpt-6.1-terra': 126,
}
const radar = (at = now - day) =>
  `<script type="application/json" id="home-overview-data">${JSON.stringify({
    scores: {
      protocol: 'codex-four-weighted-150-v2',
      author_test_interval: { completed_at: new Date(at).toISOString() },
      rows: Object.entries(scores).map(([model, score150]) => ({ model, score150, effort: 'xhigh' })),
    },
  })}</script>`
const aa = `<table><thead><tr><th>Artificial Analysis Intelligence Index</th><th>Cost per Task</th></tr></thead>
  <tbody>
  <tr><td>GPT-6.2 Astra (xhigh)</td><td>50</td><td><a href="/models/gpt-6-2-astra">Model</a></td></tr>
  <tr><td>GPT-6.2 Sol (xhigh)</td><td>55</td><td><a href="/models/gpt-6-2-sol">Model</a></td></tr>
  <tr><td>GPT-6.1 Terra (xhigh)</td><td>45</td><td><a href="/models/gpt-6-1-terra">Model</a></td></tr>
  <tr><td>GPT-6.2 Sol (xhigh) (Fast)</td><td>99</td><td><a href="/models/gpt-6-2-sol">Model</a></td></tr>
  </tbody></table>`

describe('cross-benchmark IQ', () => {
  it('matches same model and xhigh; adjusts weight as dated evidence ages and exposes disagreement', () => {
    const secondary = parseAnalysis(aa, now)!
    expect(secondary.scores.get('gpt-6.2-sol')).toBe(55)
    const fresh = aggregateIq(parseRadar(radar(), now)!, secondary, now)
    const old = aggregateIq(parseRadar(radar(now - 20 * day), now)!, secondary, now)
    expect(Object.keys(fresh)).toHaveLength(3)
    expect(fresh['gpt-6.2-sol'].cohortSize).toBe(3)
    expect(fresh['gpt-6.2-sol'].disagreement).toBe(33)
    expect(fresh['gpt-6.2-sol'].radarWeight).toBeGreaterThan(old['gpt-6.2-sol'].radarWeight)
    expect(fresh['gpt-6.2-sol'].score).toBeLessThan(old['gpt-6.2-sol'].score)
  })
  it('requires both current sources and rejects incompatible or stale data', () => {
    const primary = parseRadar(radar(), now)!
    const secondary = parseAnalysis(aa, now)!
    expect(parseRadar(radar(now - 46 * day), now)).toBeNull()
    expect(parseRadar(radar().replace('four-weighted', 'unknown-format'), now)).toBeNull()
    expect(parseAnalysis(aa.replace('GPT-6.2 Astra (xhigh)', 'GPT-6.2 Astra (max)'), now)).toBeNull()
    expect(aggregateIq(primary, secondary, now + 3 * day)).toEqual({})
  })
  it('manual refresh requests both fixed URLs, deduplicates concurrent requests and preserves valid fallback', async () => {
    let clock = now
    let fail = false
    const fetcher = vi.fn<typeof fetch>(async url =>
      String(url).includes('codexradar') ? new Response(fail ? 'invalid' : radar()) : new Response(aa),
    )
    const client = new CloudModelIq(fetcher, () => clock)
    const first = client.refresh()
    expect(client.refresh(true)).toBe(first)
    expect(Object.keys((await first).scores)).toHaveLength(3)
    await client.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    fail = true
    clock += 1_000
    const result = await client.refresh(true)
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === 'omit')).toBe(true)
    expect(result.failedSources).toEqual(['radar'])
    expect(Object.keys(result.scores)).toHaveLength(3)
    expect(result.sourceFetchedAt).toEqual({ radar: now, analysis: clock })
    clock += 3 * day
    expect((await client.refresh(true)).scores).toEqual({})
  })
})
