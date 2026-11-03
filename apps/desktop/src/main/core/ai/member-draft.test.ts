import { describe, expect, it } from 'vitest'
import type { ModelDeps } from './commit-message'
import { memberDraft, parseMemberDraft } from './member-draft'

describe('parseMemberDraft', () => {
  it('取最后一个代码块；按格式收，全权限压成自动编辑，不认识的丢掉', () => {
    const reply = [
      '```json\n{"name":"旧的"}\n```',
      '改了一下：',
      '```json',
      JSON.stringify({
        name: '  前端小王  ',
        engine: 'codex',
        source: 'custom:my-api',
        model: 'gpt-x',
        permission: 'full',
        effort: 'huge',
        fast: 'yes',
        mode: 'shared',
        tools: ['x'],
        reasons: { name: '你说做前端', permission: '要改代码', effort: '没用', bogus: 'x' },
      }),
      '```',
    ].join('\n')
    expect(parseMemberDraft(reply)).toEqual({
      name: '前端小王',
      engine: 'codex',
      source: 'custom:my-api',
      model: 'gpt-x',
      permission: 'edits',
      fullAsked: true,
      mode: 'shared',
      reasons: { name: '你说做前端', permission: '要改代码' },
    })
  })

  it('没有代码块时认裸 JSON；截长；保留名、非法来源丢掉；什么都没有返回 null', () => {
    const d = parseMemberDraft(
      `好的 {"name":"all","source":"custom:../x","instructions":"${'a'.repeat(2500)}","engine":"gemini"} 完`,
    )
    expect(d).toEqual({ instructions: 'a'.repeat(2000), reasons: {} })
    expect(parseMemberDraft('{"name":"全体","engine":"x"}')).toBeNull()
    expect(parseMemberDraft('就是一段话')).toBeNull()
  })
})

describe('memberDraft', () => {
  const never = new AbortController().signal
  const req = {
    requestId: 'r3',
    source: 'platform' as const,
    groups: ['7'],
    providerId: null,
    model: 'claude-opus-5-5',
  }
  const reply = (body: object) => new Response(JSON.stringify(body))
  const deps = (res: Response): ModelDeps => ({
    platform: async () => res,
    provider: () => null,
    fetch: async () => new Response('{}'),
    engine: async () => ({ text: '', model: null, usage: null }),
  })

  it('选项和那句话一起发，返回草稿', async () => {
    let sent = ''
    const d = deps(reply({ content: [{ type: 'text', text: '{"name":"审查"}' }] }))
    const out = await memberDraft(
      {
        ...d,
        platform: async body => {
          sent = JSON.parse(body).messages[0].content
          return reply({ content: [{ type: 'text', text: '{"name":"审查"}' }] })
        },
      },
      { ...req, text: '帮我审 PR', context: '引擎：claude' },
      never,
    )
    expect(out).toMatchObject({ ok: true, draft: { name: '审查' }, groupId: '7' })
    expect(sent).toBe('Options:\n引擎：claude\n\nDescription:\n帮我审 PR')
  })

  it('截断报太长，读不出草稿报没写出东西', async () => {
    const cut = reply({ content: [{ type: 'text', text: '{"name":' }], stop_reason: 'max_tokens' })
    expect(await memberDraft(deps(cut), { ...req, text: 'x', context: '' }, never)).toEqual({
      ok: false,
      problem: 'tooLong',
      detail: '',
    })
    const prose = reply({ content: [{ type: 'text', text: '我觉得可以' }] })
    expect(await memberDraft(deps(prose), { ...req, text: 'x', context: '' }, never)).toMatchObject({
      ok: false,
      problem: 'empty',
    })
  })
})
