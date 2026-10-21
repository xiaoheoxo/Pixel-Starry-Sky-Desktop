/**
 * 往输入框已有的附件后面补一批（回退放回原消息的图片、文件）：按顺序一个个试，放得下的留下，
 * 超了数量或大小上限（validate 报错）的跳过，交给调用方提示，不整批丢掉
 */
export function fitAttachments<T extends { id: string }>(
  current: T[],
  incoming: T[],
  validate: (value: unknown) => T[],
): { items: T[]; added: T[]; dropped: T[] } {
  let items = current
  const added: T[] = [],
    dropped: T[] = []
  for (const item of incoming) {
    if (items.some(c => c.id === item.id)) continue
    try {
      items = validate([...items, item])
      added.push(item)
    } catch {
      dropped.push(item)
    }
  }
  return { items, added, dropped }
}
