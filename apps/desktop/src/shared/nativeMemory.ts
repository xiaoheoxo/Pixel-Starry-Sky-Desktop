// 界面进程内存分项（docs/memory-tier2.md §2）：preload 在转发内存采样前同步取三组数，换成 MB。
// 每组单独 try/catch：某组拿不到只缺那一组，不能让整条采样丢掉（memorySampler 会吞掉 reject，看门狗会当成界面卡住）
import type { NativeMemory } from './types/memory'

/** process.getHeapStatistics() 用到的字段（KB） */
interface HeapStats {
  usedHeapSize: number
  totalHeapSize: number
  totalPhysicalSize: number
  totalHeapSizeExecutable: number
  mallocedMemory: number
}
/** process.getBlinkMemoryInfo()（KB） */
interface BlinkInfo {
  allocated: number
  total: number
}
interface UsageDetail {
  size: number
}
/** webFrame.getResourceUsage()（字节，2026-11-17 在 Electron 44.5.1 实测） */
interface ResourceUsage {
  images: UsageDetail
  scripts: UsageDetail
  cssStyleSheets: UsageDetail
  fonts: UsageDetail
  other: UsageDetail
}

export interface NativeSources {
  heap?: () => HeapStats
  blink?: () => BlinkInfo
  usage?: () => ResourceUsage
}

const fromKb = (kb: number): number => Math.round((kb / 1024) * 10) / 10
const fromBytes = (b: number): number => Math.round((b / 1048576) * 10) / 10

function attempt<T>(get: (() => T) | undefined): T | null {
  if (!get) return null
  try {
    return get()
  } catch {
    return null
  }
}

/** 三组都拿不到时返回 undefined（采样里就不带这个字段） */
export function nativeMemoryFrom(sources: NativeSources): NativeMemory | undefined {
  const out: NativeMemory = {}
  const heap = attempt(sources.heap)
  if (heap) {
    out.v8UsedMb = fromKb(heap.usedHeapSize)
    out.v8TotalMb = fromKb(heap.totalHeapSize)
    out.v8PhysicalMb = fromKb(heap.totalPhysicalSize)
    out.v8CodeMb = fromKb(heap.totalHeapSizeExecutable)
    out.v8MallocMb = fromKb(heap.mallocedMemory)
  }
  const blink = attempt(sources.blink)
  if (blink) {
    out.blinkAllocMb = fromKb(blink.allocated)
    out.blinkTotalMb = fromKb(blink.total)
  }
  const usage = attempt(sources.usage)
  if (usage) {
    out.cacheImagesMb = fromBytes(usage.images.size)
    out.cacheScriptsMb = fromBytes(usage.scripts.size)
    out.cacheCssMb = fromBytes(usage.cssStyleSheets.size)
    out.cacheFontsMb = fromBytes(usage.fonts.size)
    out.cacheOtherMb = fromBytes(usage.other.size)
  }
  return Object.keys(out).length ? out : undefined
}
