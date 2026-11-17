// 界面进程的内存采样（docs/ui/renderer-memory.md §3.2.1）：界面每隔一阵经 log.sample() 报给主进程
export interface RendererMemorySample {
  /** performance.memory */
  heapUsedMb: number
  heapTotalMb: number
  heapLimitMb: number
  /** 和「界面卡住」同一个数法（document.getElementsByTagName('*').length） */
  elements: number
  /** 挂着内容的标签数 */
  mountedTabs: number
  /** 挂着的对话流（LiveTranscript）个数 */
  sessionViews: number
  /** 各对话流实际显示的轮数，取最大 */
  shownTurnsMax: number
  /** 快照个数 */
  snapshots: number
  /** 快照里的条目总数 */
  snapshotItems: number
  /** 条目里字符串长度之和（不含 dataBase64），按 2 字节 / 字符折算 */
  snapshotTextMb: number
  /** 所有 dataBase64 的长度之和 */
  imageB64Mb: number
  /** xterm 个数、各终端 buffer.normal.length 之和 */
  terminals: number
  terminalLines: number
  /** CodeEditor 实例数 */
  codeEditors: number
  lightweight: boolean
  /** preload 附上的内存分项（docs/memory-tier2.md §2）；界面自己不填 */
  native?: NativeMemory
}

/**
 * 界面进程的内存分项（docs/memory-tier2.md §2），preload 取的，单位 MB；某组拿不到时那几项缺省。
 * v8*：process.getHeapStatistics()（已用 / 总量 / 物理提交 / 代码空间 / V8 自己 malloc 的）；
 * blink*：process.getBlinkMemoryInfo()（DOM、排版对象所在的 GC 堆）；cache*：webFrame.getResourceUsage() 的内存缓存
 */
export interface NativeMemory {
  v8UsedMb?: number
  v8TotalMb?: number
  v8PhysicalMb?: number
  v8CodeMb?: number
  v8MallocMb?: number
  blinkAllocMb?: number
  blinkTotalMb?: number
  cacheImagesMb?: number
  cacheScriptsMb?: number
  cacheCssMb?: number
  cacheFontsMb?: number
  cacheOtherMb?: number
}
