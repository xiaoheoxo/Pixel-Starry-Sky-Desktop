import { describe, expect, it } from 'vitest'
import { parseRelay, parseSeats, pickRelay, timeOf, validRelay } from './cloud-devices'

const device = (over: Record<string, unknown> = {}) => ({
  id: 'phone-1',
  name: 'iPhone',
  desktop_id: 'desk-local',
  status: 'active',
  online: true,
  last_ip: '203.0.113.7',
  last_seen_at: '2026-10-21T08:00:00Z',
  created_at: '2026-10-01T08:00:00Z',
  ...over,
})

describe('parseSeats', () => {
  it('按约定的字段解析，标出本机配对的', () => {
    const seats = parseSeats(
      {
        seats: { used: 1, limit: 2 },
        premium: true,
        seat_groups: [7, '8', 7, -1, 'x'],
        premium_groups: [9],
        devices: [device(), device({ id: 'phone-2', desktop_id: 'desk-other', online: false, status: 'pending' })],
      },
      'desk-local',
    )
    expect(seats).toEqual({
      available: true,
      used: 1,
      limit: 2,
      premium: true,
      seatGroups: [7, 8],
      premiumGroups: [9],
      devices: [
        {
          id: 'phone-1',
          name: 'iPhone',
          desktopId: 'desk-local',
          local: true,
          pending: false,
          online: true,
          lastIp: '203.0.113.7',
          lastSeenAt: Date.parse('2026-10-21T08:00:00Z'),
          createdAt: Date.parse('2026-10-01T08:00:00Z'),
        },
        expect.objectContaining({ id: 'phone-2', local: false, pending: true, online: false }),
      ],
    })
  })

  it('席位字段不对：当作接口不可用', () => {
    expect(parseSeats(null, 'd')).toBeNull()
    expect(parseSeats({ devices: [] }, 'd')).toBeNull()
    expect(parseSeats({ seats: { used: -1, limit: 2 } }, 'd')).toBeNull()
    expect(parseSeats({ seats: { used: 1.5, limit: 2 } }, 'd')).toBeNull()
    expect(parseSeats({ seats: { used: '1', limit: 2 } }, 'd')).toBeNull()
  })

  it('不信任的字段：丢掉坏设备，坏 IP / 时间换成 null，名字去控制字符并截断，premium 只认 true', () => {
    const seats = parseSeats(
      {
        seats: { used: 0, limit: 1 },
        premium: 'yes',
        seat_groups: 'nope',
        devices: [
          'junk',
          { name: 'no id' },
          device({ id: 42 }),
          device({ id: 'a'.repeat(65) }),
          device({
            id: 'ok',
            name: 'x\u0000y' + 'z'.repeat(100),
            last_ip: '<script>',
            last_seen_at: '0001-01-01T00:00:00Z',
            created_at: 'garbage',
            online: 'true',
          }),
          device({ id: 'ok', name: 'duplicate' }),
        ],
      },
      'desk-local',
    )
    if (!seats?.available) throw new Error('应可用')
    expect(seats.premium).toBe(false)
    expect(seats.seatGroups).toEqual([])
    expect(seats.devices).toHaveLength(1)
    const [d] = seats.devices
    expect(d.name).toBe('xy' + 'z'.repeat(62))
    expect(d.lastIp).toBeNull()
    expect(d.lastSeenAt).toBeNull()
    expect(d.createdAt).toBeNull()
    expect(d.online).toBe(false)
  })

  it('没有 desktop_id 的不算本机', () => {
    const seats = parseSeats({ seats: { used: 0, limit: 1 }, devices: [device({ desktop_id: '' })] }, '')
    expect(seats?.available && seats.devices[0].local).toBe(false)
  })

  it('本机的排在前面，再按在线、最近在线', () => {
    const seats = parseSeats(
      {
        seats: { used: 0, limit: 1 },
        devices: [
          device({ id: 'old', desktop_id: 'x', online: false, last_seen_at: '2026-01-01T00:00:00Z' }),
          device({ id: 'new', desktop_id: 'x', online: false, last_seen_at: '2026-10-01T00:00:00Z' }),
          device({ id: 'on', desktop_id: 'x', online: true }),
          device({ id: 'mine', online: false }),
        ],
      },
      'desk-local',
    )
    expect(seats?.available && seats.devices.map(d => d.id)).toEqual(['mine', 'on', 'new', 'old'])
  })
})

describe('timeOf', () => {
  it('认毫秒、秒和 RFC 3339', () => {
    expect(timeOf(1_760_000_000_000)).toBe(1_760_000_000_000)
    expect(timeOf(1_760_000_000)).toBe(1_760_000_000_000)
    expect(timeOf('2026-10-21T08:00:00+08:00')).toBe(Date.parse('2026-10-21T00:00:00Z'))
    expect(timeOf(0)).toBeNull()
    expect(timeOf(Number.NaN)).toBeNull()
    expect(timeOf(null)).toBeNull()
  })
})

describe('中转地址', () => {
  it('parseRelay 只认 ws / wss 地址', () => {
    expect(parseRelay({ url: 'wss://node1.example.com/v1/bridge/ws', node: 'n1', premium: true })).toBe(
      'wss://node1.example.com/v1/bridge/ws',
    )
    // 主站节点：云端给的是 CDN 域名，不用它，按本机的几档走
    expect(parseRelay({ url: 'wss://pixelstarrysky.xyz/v1/bridge/ws', node: 'default', premium: false })).toBeNull()
    expect(parseRelay({ url: 'https://node1.example.com' })).toBeNull()
    expect(parseRelay({ url: 'wss://user:pw@node1.example.com' })).toBeNull()
    expect(parseRelay({ url: 'wss://a b' })).toBeNull()
    expect(parseRelay({ url: 'wss://' + 'a'.repeat(600) })).toBeNull()
    expect(parseRelay(null)).toBeNull()
    expect(parseRelay({})).toBeNull()
    expect(validRelay('ws://127.0.0.1:8787/v1/bridge/ws')).toBe(true)
  })

  it('pickRelay：手填的优先，其次云端分配的，最后默认', () => {
    expect(pickRelay('ws://local', 'wss://node', 'wss://default')).toBe('ws://local')
    expect(pickRelay('', 'wss://node', 'wss://default')).toBe('wss://node')
    expect(pickRelay('', null, 'wss://default')).toBe('wss://default')
  })
})
