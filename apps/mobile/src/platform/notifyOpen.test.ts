import { describe, expect, it } from 'vitest'
import { readNotifyTarget } from './notifyOpen'

describe('readNotifyTarget', () => {
  it('reads the session and device from the hash', () => {
    expect(readNotifyTarget('#open=0b7e2f4c-1d2a&device=dev_123')).toEqual({
      device: 'dev_123',
      session: '0b7e2f4c-1d2a',
    })
    // 远程机器的会话 id 带机器前缀和 ~（sw.js 用 encodeURIComponent 拼，~ 不转义）
    const ssh = 'ssh-0b7e2f4c-1d2a-4c3b-9e8f-123456789abc~5d1c0a2b-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
    expect(readNotifyTarget(`#open=${encodeURIComponent(ssh)}&device=m-Ab_9`)).toEqual({
      device: 'm-Ab_9',
      session: ssh,
    })
  })

  it('opens the overview when there is no single session', () => {
    expect(readNotifyTarget('#open=&device=dev_123')).toEqual({ device: 'dev_123', session: null })
    expect(readNotifyTarget('#open=../x&device=dev_123')).toEqual({ device: 'dev_123', session: null })
  })

  it('ignores other hashes and bad device ids', () => {
    expect(readNotifyTarget('')).toBeNull()
    expect(readNotifyTarget('#pair=abc')).toBeNull()
    expect(readNotifyTarget('#open=s1')).toBeNull()
    expect(readNotifyTarget('#open=s1&device=a/b')).toBeNull()
  })
})
