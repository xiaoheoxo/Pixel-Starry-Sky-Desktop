import { describe, expect, it } from 'vitest'
import { openWs } from './ws-open'

describe('openWs', () => {
  it('IP 那档还没连上就关掉（清掉 onerror 之后）：不抛未捕获的异常', async () => {
    // 连本机一个没人听的端口：握手一定没完成
    const ws = openWs({ tier: 'ip', url: 'wss://localhost:9/v1/bridge/ws', ip: '127.0.0.1' }, ['x'])
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    ws.close()
    // ws 在下一拍发 error；没有监听时会变成未捕获的异常，vitest 会把这条测试判失败
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(ws.readyState).not.toBe(1)
  })
})
