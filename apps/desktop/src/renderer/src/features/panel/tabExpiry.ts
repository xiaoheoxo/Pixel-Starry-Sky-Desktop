// 右栏长时间没看的标签卸载（docs/memory-tier3.md §2.3）：下次点开重新挂载、重新读数据。
// 只卸没有输入内容的标签：Git（提交信息）、任务 / 环境 / 副本 / 连接器（表单）的草稿在组件里，卸了会丢；
// 浏览器的页面在主进程，卸了只省一个外壳；终端、文件不在这张表里管

/** 多久没看就卸 */
export const TAB_IDLE_MS = 10 * 60_000

/** 会卸的标签 */
export const EXPIRING_TABS: ReadonlySet<string> = new Set(['overview', 'artifacts', 'comments'])

/** 该卸的标签：挂着、会卸、不在眼前，且上次看到是 TAB_IDLE_MS 以前（没记过的按现在算，不卸） */
export function expiredTabs(
  visited: ReadonlySet<string>,
  lastSeen: ReadonlyMap<string, number>,
  shown: string | null,
  now: number,
): string[] {
  return [...visited].filter(
    kind => kind !== shown && EXPIRING_TABS.has(kind) && now - (lastSeen.get(kind) ?? now) >= TAB_IDLE_MS,
  )
}
