import { describe, expect, it } from 'vitest'
import { IPC_CONTRACT } from '@pixelsky/protocol'

const READ = ['catalog', 'detail', 'checkUpdates', 'state', 'publisher', 'publishCheck', 'refreshBlocklist']
const WRITE = ['install', 'cancel', 'report', 'register', 'pickUpload', 'upload', 'withdraw', 'delist', 'relist']

describe('extstore channels in the IPC contract', () => {
  const contract = IPC_CONTRACT as Record<string, { kind: string; route: string; trust: string }>
  const names = Object.keys(contract)
    .filter(name => name.startsWith('extstore:'))
    .sort()

  it('registers exactly the planned 17 channels', () => {
    expect(names).toEqual([...READ, ...WRITE, 'changed'].map(n => `extstore:${n}`).sort())
    expect(names).toHaveLength(17)
  })
  it('read-only channels are invoke + sender', () => {
    for (const n of READ) expect(contract[`extstore:${n}`], n).toMatchObject({ kind: 'invoke', trust: 'sender' })
  })
  it('channels that write are invoke + frame', () => {
    for (const n of WRITE) expect(contract[`extstore:${n}`], n).toMatchObject({ kind: 'invoke', trust: 'frame' })
  })
  it('changed is a push with no trust check', () => {
    expect(contract['extstore:changed']).toEqual({ kind: 'push', route: 'push', trust: 'none' })
  })
})
