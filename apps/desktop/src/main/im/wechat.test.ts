import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImInbound } from './bridge'
import { WECHAT_API, WechatLink } from './wechat'

const json = (body: unknown) => new Response(JSON.stringify(body))

function setup(over: { token?: string | null; updates?: unknown[]; status?: unknown[]; send?: unknown } = {}) {
  const updates = [...(over.updates ?? [])]
  const scans = [...(over.status ?? [])]
  const sends: Array<Record<string, unknown>> = []
  const seenHeaders: Array<Record<string, string>> = []
  const events: string[] = []
  const messages: ImInbound[] = []
  const logins: string[][] = []
  const cursors: string[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('get_bot_qrcode')) return json({ qrcode: 'code', qrcode_img_content: 'https://qr', ret: 0 })
    if (u.includes('get_qrcode_status')) return json(scans.shift() ?? { status: 'wait' })
    if (u.includes('getupdates')) {
      seenHeaders.push(init?.headers as Record<string, string>)
      const next = updates.shift()
      if (next) return json(next)
      // 没有更多：挂到被停掉
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))
      })
    }
    sends.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return json(over.send ?? { ret: 0 })
  })
  const link = new WechatLink({
    token: over.token === undefined ? 'tok' : over.token,
    baseUrl: null,
    cursor: '',
    onMessage: m => messages.push(m),
    onStatus: (status, error) => events.push(error ? `${status}:${error}` : status),
    onQr: url => events.push(`qr:${url}`),
    onLogin: (token, base) => logins.push([token, base]),
    onExpired: () => events.push('expired'),
    onCursor: c => cursors.push(c),
    fetch: fetchMock as unknown as typeof fetch,
    retryBase: 1,
  })
  return { link, events, messages, logins, cursors, sends, seenHeaders, fetchMock }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 2))
  expect(check()).toBe(true)
}

const userMessage = {
  message_id: 7,
  from_user_id: 'u@im.wechat',
  message_type: 1,
  context_token: 'ctx',
  item_list: [{ type: 1, text_item: { text: '你好' } }],
}

describe('WechatLink', () => {
  let active: WechatLink | null = null
  afterEach(() => active?.stop())

  it('没令牌先扫码，确认后保存令牌并开始收消息', async () => {
    const s = setup({
      token: null,
      status: [{ status: 'scaned' }, { status: 'confirmed', bot_token: 'new', baseurl: 'https://b.example' }],
      updates: [{ ret: 0, msgs: [] }],
    })
    active = s.link
    s.link.start()
    await until(() => s.events.includes('online'))
    expect(s.events).toContain('qr:https://qr')
    expect(s.events).toContain('scan')
    expect(s.events).toContain('qr:null')
    expect(s.logins).toEqual([['new', 'https://b.example']])
    expect(String(s.fetchMock.mock.calls.at(-1)?.[0])).toBe('https://b.example/ilink/bot/getupdates')
  })

  it('取二维码失败：报网络问题并重试', async () => {
    const s = setup({ token: null, status: [{ status: 'expired' }] })
    active = s.link
    s.fetchMock.mockRejectedValueOnce(new Error('offline'))
    s.link.start()
    await until(() => s.events.includes('error:network') && s.events.includes('error:wechatQr'))
  })

  it('二维码过期报原因', async () => {
    const s = setup({ token: null, status: [{ status: 'expired' }] })
    active = s.link
    s.link.start()
    await until(() => s.events.includes('error:wechatQr'))
  })

  it('用户消息转给上层，机器人自己的不转；游标存下来', async () => {
    const s = setup({
      updates: [
        {
          ret: 0,
          get_updates_buf: 'c1',
          msgs: [userMessage, { ...userMessage, message_id: 8, message_type: 2 }],
        },
      ],
    })
    active = s.link
    s.link.start()
    await until(() => s.messages.length > 0)
    expect(s.messages).toEqual([{ id: '7', from: 'u@im.wechat', text: '你好', reply: 'ctx' }])
    expect(s.cursors).toEqual(['c1'])
    expect(s.seenHeaders[0]).toMatchObject({ AuthorizationType: 'ilink_bot_token', Authorization: 'Bearer tok' })
    expect(Buffer.from(s.seenHeaders[0]['X-WECHAT-UIN'], 'base64').toString()).toMatch(/^\d+$/)
  })

  it('图片这类没文字的消息，文字是空的（上层说只支持文字）', async () => {
    const s = setup({ updates: [{ ret: 0, msgs: [{ ...userMessage, item_list: [{ type: 2 }] }] }] })
    active = s.link
    s.link.start()
    await until(() => s.messages.length > 0)
    expect(s.messages[0].text).toBe('')
  })

  it('登录失效（实测 errcode -14）：清令牌、要重新扫码、不再轮询', async () => {
    const s = setup({ updates: [{ errcode: -14, errmsg: 'session timeout' }] })
    active = s.link
    s.link.start()
    await until(() => s.events.includes('error:wechatExpired'))
    expect(s.events).toContain('expired')
    expect(s.seenHeaders.length).toBe(1)
    expect(await s.link.send('u', 'x', 'ctx')).toBe('window')
  })

  it('回复带 context_token；没有就留到下一条', async () => {
    const s = setup()
    expect(await s.link.send('u', '回复', 'ctx')).toBe('sent')
    expect(s.sends[0]).toMatchObject({
      msg: {
        to_user_id: 'u',
        context_token: 'ctx',
        message_type: 2,
        item_list: [{ type: 1, text_item: { text: '回复' } }],
      },
    })
    expect(await s.link.send('u', '回复', null)).toBe('window')
    expect(s.sends.length).toBe(1)
  })

  it('发送其他错误抛出去', async () => {
    const s = setup({ send: { ret: -2, errmsg: 'bad' } })
    await expect(s.link.send('u', 'x', 'ctx')).rejects.toThrow('bad')
  })

  it('默认地址是实测通的那个', () => {
    expect(WECHAT_API).toBe('https://ilinkai.weixin.qq.com')
  })
})
