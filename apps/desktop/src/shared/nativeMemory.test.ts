import { describe, expect, it } from 'vitest'
import { nativeMemoryFrom } from './nativeMemory'

// 界面进程内存分项（docs/memory-tier2.md §2）
const usage = (bytes: number) => ({
  images: { size: bytes },
  scripts: { size: 2 * 1048576 },
  cssStyleSheets: { size: 0 },
  fonts: { size: 524288 },
  other: { size: 0 },
})
const heap = {
  usedHeapSize: 66560,
  totalHeapSize: 81920,
  totalPhysicalSize: 79872,
  totalHeapSizeExecutable: 5120,
  mallocedMemory: 2048,
}

describe('nativeMemoryFrom', () => {
  it('堆和 Blink 是 KB，资源缓存是字节，都换成 MB（1 位小数）', () => {
    expect(
      nativeMemoryFrom({
        heap: () => heap,
        blink: () => ({ allocated: 122880, total: 184320 }),
        usage: () => usage(31457280),
      }),
    ).toEqual({
      v8UsedMb: 65,
      v8TotalMb: 80,
      v8PhysicalMb: 78,
      v8CodeMb: 5,
      v8MallocMb: 2,
      blinkAllocMb: 120,
      blinkTotalMb: 180,
      cacheImagesMb: 30,
      cacheScriptsMb: 2,
      cacheCssMb: 0,
      cacheFontsMb: 0.5,
      cacheOtherMb: 0,
    })
  })

  it('某组抛错只缺那一组；三组都拿不到返回 undefined', () => {
    const boom = (): never => {
      throw new Error('not available')
    }
    const partial = nativeMemoryFrom({ heap: boom, blink: () => ({ allocated: 1024, total: 2048 }), usage: boom })
    expect(partial).toEqual({ blinkAllocMb: 1, blinkTotalMb: 2 })
    expect(nativeMemoryFrom({ heap: boom, blink: boom, usage: boom })).toBeUndefined()
    expect(nativeMemoryFrom({})).toBeUndefined()
  })
})
