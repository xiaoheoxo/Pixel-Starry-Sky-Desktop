import { describe, expect, it } from 'vitest'
import type { Effort } from '@pixelsky/protocol'
import { effortLook } from './labels'

const TO_ULTRA: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const TO_MAX: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TO_XHIGH: Effort[] = ['low', 'medium', 'high', 'xhigh']

describe('推理强度的特效', () => {
  it('Codex 的 Ultra 是彩虹，不走最高档的单色流光', () => {
    expect(effortLook('ultra', TO_ULTRA, 'codex')).toEqual({
      className: 'effort-ultra',
      accent: '',
      top: false,
      ultra: true,
    })
  })

  it('Codex 的 Max 和 Claude 同色，不管是不是最高档', () => {
    const same = { className: 'effort-max', accent: 'var(--engine-claude)', top: true, ultra: false }
    expect(effortLook('max', TO_ULTRA, 'codex')).toEqual(same)
    expect(effortLook('max', TO_MAX, 'codex')).toEqual(same)
    expect(effortLook('max', TO_MAX, 'claude')).toEqual(same)
  })

  it('其余档位不加特效；模型最高只到 XHigh 时还是原来的单色流光', () => {
    expect(effortLook('high', TO_ULTRA, 'codex')).toEqual({ className: '', accent: '', top: false, ultra: false })
    expect(effortLook(null, TO_ULTRA, 'codex').className).toBe('')
    expect(effortLook('xhigh', TO_XHIGH, 'codex')).toMatchObject({ className: 'effort-max', accent: '', top: true })
  })

  it('像素星空不变：没有品牌色，最高档单色流光', () => {
    expect(effortLook('max', TO_MAX, 'pixel')).toEqual({ className: 'effort-max', accent: '', top: true, ultra: false })
  })
})
