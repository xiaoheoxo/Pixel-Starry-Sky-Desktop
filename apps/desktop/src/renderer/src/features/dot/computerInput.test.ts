import { describe, expect, it } from 'vitest'
import { dotKeysym, keyPacket, pointerPacket, videoPoint } from './computerInput'
describe('Dot computer input', () => {
  it('encodes pointer and signed wheel frames in the native wire format', () => {
    expect([...new Uint8Array(pointerPacket('move', 300, 500))]).toEqual([1, 4, 0, 44, 1, 244, 1])
    const wheel = new DataView(pointerPacket('wheel', -2, 50))
    expect(wheel.getInt16(3, true)).toBe(-2)
    expect(wheel.getInt16(5, true)).toBe(10)
    expect(new DataView(keyPacket(true, 0xff0d)).getBigUint64(3, true)).toBe(0xff0dn)
  })
  it('maps keyboard input and rejects keys without a known representation', () => {
    expect(dotKeysym('Enter')).toBe(0xff0d)
    expect(dotKeysym('F12')).toBe(0xffc9)
    expect(dotKeysym('A')).toBe(65)
    expect(dotKeysym('中')).toBe(0x1004e2d)
    expect(dotKeysym('Unidentified')).toBeNull()
  })
  it('maps the visible video rather than its letterboxed margins', () => {
    expect(videoPoint(100, 10, 400, 400, 800, 400)).toBeNull()
    expect(videoPoint(100, 150, 400, 400, 800, 400)).toEqual({ x: 200, y: 100 })
    expect(videoPoint(100, 150, 0, 0, 800, 400)).toBeNull()
  })
})
