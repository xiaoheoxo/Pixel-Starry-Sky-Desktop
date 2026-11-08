import { SUBAGENT_EFFORTS, type Effort, type EngineCatalog } from '@pixelsky/protocol'

/** null 表示还没有这个模型的能力，不当成「不支持推理」。 */
export function subagentModelEfforts(
  catalog: EngineCatalog | null,
  model: string | null,
  useCatalog = true,
): readonly Effort[] | null {
  if (!useCatalog) return null
  if (!model) return null
  const found = catalog?.models?.find(m => m.id === model) ?? catalog?.models?.find(m => m.id.endsWith(`/${model}`))
  return found ? found.efforts.filter(e => SUBAGENT_EFFORTS.includes(e)) : null
}
