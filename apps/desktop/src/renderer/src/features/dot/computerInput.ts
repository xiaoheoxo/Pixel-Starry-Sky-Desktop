/** Dot 电脑的数据通道使用 little-endian 的 Neko 输入帧和 X11 keysym。 */
export function pointerPacket(type: 'move' | 'wheel', x: number, y: number): ArrayBuffer {
  const data = new DataView(new ArrayBuffer(7))
  data.setUint8(0, type === 'move' ? 1 : 2)
  data.setUint16(1, 4, true)
  const signed = type === 'wheel'
  if (signed) {
    data.setInt16(3, Math.max(-10, Math.min(10, x)), true)
    data.setInt16(5, Math.max(-10, Math.min(10, y)), true)
  } else {
    data.setUint16(3, Math.max(0, Math.min(65535, x)), true)
    data.setUint16(5, Math.max(0, Math.min(65535, y)), true)
  }
  return data.buffer
}
export function keyPacket(down: boolean, key: number): ArrayBuffer {
  const data = new DataView(new ArrayBuffer(11))
  data.setUint8(0, down ? 3 : 4)
  data.setUint16(1, 8, true)
  data.setBigUint64(3, BigInt(key), true)
  return data.buffer
}
const keys: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  CapsLock: 0xffe5,
}
export function dotKeysym(key: string): number | null {
  if (keys[key]) return keys[key]
  if (/^F([1-9]|1[0-2])$/.test(key)) return 0xffbd + Number(key.slice(1))
  if ([...key].length !== 1) return null
  const code = key.codePointAt(0)!
  return code > 255 ? 0x1000000 + code : code
}
export function videoPoint(
  x: number,
  y: number,
  width: number,
  height: number,
  videoWidth: number,
  videoHeight: number,
) {
  if (!width || !height || !videoWidth || !videoHeight) return null
  const scale = Math.min(width / videoWidth, height / videoHeight)
  const left = (width - videoWidth * scale) / 2
  const top = (height - videoHeight * scale) / 2
  if (x < left || y < top || x >= width - left || y >= height - top) return null
  return {
    x: Math.min(videoWidth - 1, Math.floor((x - left) / scale)),
    y: Math.min(videoHeight - 1, Math.floor((y - top) / scale)),
  }
}
