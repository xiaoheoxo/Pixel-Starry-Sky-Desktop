import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: vi.fn() } }))
vi.mock('../ipc/guard', () => ({ handle: vi.fn() }))

import { glassMaterials } from './glass'

describe('glassMaterials', () => {
  it('Windows 11 22H2 起才有材质', () => {
    expect(glassMaterials('win32', '10.0.26100')).toContain('acrylic')
    expect(glassMaterials('win32', '10.0.22621')).toContain('acrylic')
    expect(glassMaterials('win32', '10.0.22000')).toEqual([])
    expect(glassMaterials('win32', '10.0.19045')).toEqual([])
  })

  it('macOS 有材质，Linux 没有', () => {
    expect(glassMaterials('darwin', '24.0.0')).toContain('under-window')
    expect(glassMaterials('linux', '6.8.0')).toEqual([])
  })
})
