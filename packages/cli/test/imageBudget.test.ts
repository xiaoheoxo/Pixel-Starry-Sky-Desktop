import { describe, expect, it } from 'vitest'
import {
  BIG_REQUEST,
  imageBudgetExtension,
  omittedImages,
  sizeOf,
  timeoutNote,
  withoutOldImages,
  type Message,
} from '../src/extensions/imageBudget.ts'

const image = (size: number) => ({ type: 'image', data: 'x'.repeat(size), mimeType: 'image/png' })
const user = (...sizes: number[]): Message => ({
  role: 'user',
  content: [{ type: 'text', text: '看图' }, ...sizes.map(image)],
})
/** 一步：模型读若干张图，每张一个工具结果 */
const step = (id: string, ...sizes: number[]): Message[] => [
  {
    role: 'assistant',
    content: sizes.map((_, i) => ({
      type: 'toolCall',
      id: `${id}${i}`,
      name: 'read',
      arguments: { path: `D:/${id}${i}.png` },
    })),
  },
  ...sizes.map((size, i) => ({
    role: 'toolResult',
    toolCallId: `${id}${i}`,
    toolName: 'read',
    content: [{ type: 'text', text: 'Read image' }, image(size)],
  })),
]
/** 省掉的图片所在的消息 */
const gone = (messages: Message[], bytes = 100, count = 20): number[] =>
  omittedImages(messages, bytes, count).map(p => p.message)

describe('图片总预算（docs/ui/pixel-request-size.md §7）', () => {
  it('没超不动；超了从最早的省，降到一半；最新一批留着', () => {
    const messages = [user(), ...step('a', 40), ...step('b', 40)]
    expect(withoutOldImages(messages, 100)).toBeNull()
    // 120 > 100：省 a（剩 80）、再省 b（剩 40 ≤ 50）
    const more = [...messages, ...step('c', 40)]
    expect(gone(more)).toEqual([2, 4])
    // 一批就超：也留着
    expect(gone([user(), ...step('a', 10), ...step('b', 90, 90)])).toEqual([2])
  })

  it('张数超了也省', () => {
    const messages = [user(), ...step('a', 1, 1), ...step('b', 1, 1), ...step('c', 1)]
    expect(gone(messages, 100, 4)).toEqual([2, 3, 5, 6])
  })

  it('最近一条带图的用户消息另算：不省、不占后面看的图的份额，追问（不带图）时还在', () => {
    const turn = [user(90, 90), ...step('a', 40), ...step('b', 40)]
    expect(gone(turn)).toEqual([])
    expect(gone([...turn, ...step('c', 40)])).toEqual([2, 4])
    // 追问：最多留一份总量，从最早的省
    expect(omittedImages([...turn, user()], 100)).toMatchObject([{ message: 0, block: 1 }])
    expect(gone([user(40, 40), user(), ...step('a', 60), user()])).toEqual([])
    // 又发了新图：以前的和别的图一起算
    expect(gone([user(40, 40), user(), ...step('a', 60), { role: 'assistant', content: [] }, user(90)])).toEqual([
      0, 0, 3,
    ])
  })

  it('模型还没看过的不省：同一批工具结果后面又插了话、夹着系统消息也一样；看过之后才省', () => {
    const [call, ...results] = step('a', 60, 60)
    const turn = [user(), call, results[0], { role: 'system', content: 'x' }, results[1], user(), user(30)]
    expect(gone(turn)).toEqual([])
    expect(gone([user(), ...step('z', 30), ...turn])).toEqual([2])
    expect(gone([...turn, ...step('b', 10)])).toEqual([2, 4])
    // 用户发的图还没看过就又补了一句：不裁
    expect(gone([user(90, 90), user()])).toEqual([])
  })

  it('后面加消息不会把省掉的放回来，界线不是每次都动', () => {
    let messages: Message[] = [user(5)]
    let before = new Set<string>()
    let moves = 0
    for (let i = 0; i < 60; i++) {
      messages = [...messages, ...step(`s${i}-`, 10)]
      if (i % 13 === 12) messages = [...messages, user(15)]
      const now = new Set(omittedImages(messages, 100).map(p => `${p.message}:${p.block}`))
      for (const key of before) expect(now.has(key)).toBe(true)
      if (now.size !== before.size) moves++
      before = now
    }
    expect(moves).toBeLessThan(20)
  })

  it('换成文字：read 读的写路径；只换图片，原来的消息不动', () => {
    const messages = [
      user(60),
      user(1),
      ...step('a', 60),
      { role: 'toolResult', toolCallId: 'a1', toolName: 'shot', content: [image(60)] },
      ...step('b', 60),
    ]
    const copy = structuredClone(messages)
    const out = withoutOldImages(messages, 100)!
    expect(messages).toEqual(copy)
    expect(out).toHaveLength(messages.length)
    expect(out[0].content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'text', text: '[An earlier image was omitted to keep the request small.]' },
    ])
    expect(out[3].content).toEqual([
      { type: 'text', text: 'Read image' },
      {
        type: 'text',
        text: '[Image omitted to keep the request small: D:/a0.png. Read it again if you need to see it.]',
      },
    ])
    expect(out[4].content).toEqual([
      { type: 'text', text: '[An earlier image was omitted to keep the request small.]' },
    ])
    expect(out[6]).toBe(messages[6])
    // 文字写成字符串的、没有内容的消息照常过
    expect(withoutOldImages([{ role: 'user', content: 'hi' }, { role: 'custom' }], 1)).toBeNull()
  })
})

describe('超时报错写明大小', () => {
  it('只有超时而且请求大才加；原文留着', () => {
    const raw = 'Request timed out.: This operation was aborted (20)'
    expect(timeoutNote(raw, 41296383)).toBe(
      `${raw} — the request was 39.4 MB and may be too large to upload in time. Compact the conversation or start a new one.`,
    )
    expect(timeoutNote(raw, BIG_REQUEST - 1)).toBeNull()
    expect(timeoutNote('pixelsky API error (402): insufficient balance', 41296383)).toBeNull()
  })

  it('大小和真实 JSON 差不多', () => {
    const body = {
      model: 'm',
      input: [
        { type: 'text', text: 'x'.repeat(5000) },
        { n: 1, ok: true, none: null },
      ],
    }
    const real = JSON.stringify(body).length
    expect(Math.abs(sizeOf(body) - real)).toBeLessThan(real * 0.02)
  })

  it('按最近一次请求的大小改报错；成功、用户停止的不动', async () => {
    const handlers: Record<string, (event: unknown) => Promise<unknown>> = {}
    imageBudgetExtension({ on: (name: string, fn: never) => (handlers[name] = fn) } as never)
    const failed = (stopReason: string, errorMessage = 'Request timed out.') => ({
      message: { role: 'assistant', stopReason, errorMessage, content: [] },
    })
    expect(await handlers.message_end(failed('error'))).toBeUndefined()
    await handlers.before_provider_request({ payload: { input: 'x'.repeat(6 * 1024 * 1024) } })
    expect(await handlers.message_end(failed('error'))).toMatchObject({
      message: { errorMessage: expect.stringContaining('6.0 MB') },
    })
    expect(await handlers.message_end(failed('aborted'))).toBeUndefined()
    expect(await handlers.message_end({ message: { role: 'user', content: [] } })).toBeUndefined()
    // 会话里没有要省的图：不改消息
    expect(await handlers.context_with_system({ messages: [user(10)] })).toBeUndefined()
  })
})
