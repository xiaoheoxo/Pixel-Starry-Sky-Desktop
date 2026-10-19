import { describe, expect, it } from 'vitest'
import { codedError } from '@pixelsky/protocol'
import { CHECK_FAILED_KEY, isCheckFailed } from './usePublish'

describe('usePublish 纯逻辑', () => {
  it('isCheckFailed：认出带代码的 check_failed，其它错误不算', () => {
    expect(isCheckFailed(codedError(CHECK_FAILED_KEY).message)).toBe(true)
    expect(isCheckFailed(`上传失败：${codedError(CHECK_FAILED_KEY).message}`)).toBe(true)
    expect(isCheckFailed(codedError('extstore.api.noPublisher').message)).toBe(false)
    expect(isCheckFailed(null)).toBe(false)
  })
})
