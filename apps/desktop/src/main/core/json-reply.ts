// 从模型回复里抠 JSON 对象：先从后往前试 ```代码块```，再试第一个 { 到最后一个 }。频道拟计划、一句话建成员共用
export function jsonObjects(reply: string): Record<string, unknown>[] {
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1].trim())
  const bare = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)
  const found: Record<string, unknown>[] = []
  for (const text of [...fenced.reverse(), bare]) {
    if (!text.startsWith('{')) continue
    try {
      const value: unknown = JSON.parse(text)
      if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value as Record<string, unknown>)
    } catch {
      // 不是 JSON：试下一个
    }
  }
  return found
}
