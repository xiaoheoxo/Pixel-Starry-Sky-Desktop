// 输入框上方的模式胶囊「每步问我 · Sonnet 4.5 · 中 ˅」：点开改权限模式、模型、强度（C2，docs/mobile-remote.md §21.5）。
// 改了马上发给电脑（engine:updateSession），电脑推回来的会话记录变了，胶囊跟着变。
// 往更宽的权限切确认一次；完全放行手机上开不了，电脑上已经开着的只能往下降。只看档的手机只能看。
// 能力和模型目录按「下一个引擎」算（运行中选了别的引擎还没生效时，设置算它的，和电脑网关一致）；
// 用自定义接口的会话模型来自那个接口，不在引擎目录里，手机上只显示不让改。
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { ENGINES, type Effort, type PermissionMode, type SessionRecord } from '@pixelsky/protocol'
import type { DesktopLink } from '@/connection'
import { useCatalog } from '@/data/hooks'
import { effortOptions, modeChip, modelLabel, modelOptions, permissionOptions, widens } from '@/data/mode'
import { ModeSheet } from '@/ui/ModeSheet'

type Patch = Partial<Pick<SessionRecord, 'permissionMode' | 'model' | 'effort' | 'thinkingSummaries'>>

const ERRORS: Record<string, string> = {
  MOBILE_FORBIDDEN: '这部手机是「只看」，改不了。',
  MOBILE_UNSUPPORTED: '电脑上的像素星空版本较旧，先更新电脑版。',
  MOBILE_BAD_ARGUMENT: '电脑不接受这个设置。',
}

export function ModeChip({
  deviceId,
  link,
  sessionId,
  record,
  canAct,
}: {
  deviceId: string
  link: DesktopLink | undefined
  sessionId: string
  record: SessionRecord
  canAct: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const engine = record.nextEngine ?? record.engine
  const custom = !!record.provider
  const catalog = useCatalog(deviceId, engine, open && !custom)
  const chip = modeChip(record)
  const text = [chip.permission, chip.model, chip.effort].filter(Boolean).join(' · ')
  const caps = ENGINES[engine]?.caps
  const model = catalog.models?.find(m => m.id === record.model)

  const apply = async (patch: Patch) => {
    if (!link) return
    setBusy(true)
    setError(null)
    try {
      await link.call('engine:updateSession', sessionId, patch)
    } catch (e) {
      const code = (e as Error).message
      setError(ERRORS[code] ?? code)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex px-4 pb-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-line-subtle bg-surface py-0.5 pr-1.5 pl-2.5 text-label text-fg-muted active:bg-hover"
        >
          <span className="truncate">{text}</span>
          <ChevronDown size={13} className="shrink-0" />
        </button>
      </div>
      {open && (
        <ModeSheet
          title="这个会话的模式"
          busy={busy}
          readOnly={!canAct || catalog.unsupported}
          error={
            error ??
            (catalog.unsupported
              ? '电脑上的像素星空版本较旧，手机还不能改模式。'
              : !canAct
                ? '没连上电脑，或这部手机是「只看」。'
                : null)
          }
          note={[
            caps && !caps.liveModelSwitch && '模型和强度下一轮生效。',
            caps && !caps.livePermissionSwitch && '正在运行时改权限，下一轮生效。',
            '换模型、调高强度会改变费用。',
          ]
            .filter(Boolean)
            .join('')}
          onClose={() => setOpen(false)}
          groups={[
            {
              key: 'permission',
              title: '权限',
              options: permissionOptions(engine, record.permissionMode),
              value: record.permissionMode,
              onPick: v => {
                const to = v as PermissionMode
                if (widens(record.permissionMode, to) && !confirm('放宽权限：AI 改文件时不再先问你。确定吗？')) return
                void apply({ permissionMode: to })
              },
            },
            {
              key: 'model',
              title: custom
                ? '模型（自定义接口的，在电脑上改）'
                : catalog.models === null && !catalog.unsupported
                  ? '模型（正在取）'
                  : '模型',
              options: custom
                ? [{ value: record.model ?? '', label: record.model ? modelLabel(record.model) : '默认' }]
                : modelOptions(catalog.models, record.model),
              value: record.model ?? '',
              onPick: v => {
                // 新模型不支持现在的强度：一起退回默认，免得留下一个新模型不认的强度
                const next = catalog.models?.find(m => m.id === v)
                const drop = !!record.effort && !!next?.efforts.length && !next.efforts.includes(record.effort)
                void apply({ model: v || null, ...(drop ? { effort: null } : {}) })
              },
            },
            {
              key: 'effort',
              title: '推理强度',
              options: effortOptions(engine, model, record.effort),
              value: record.effort ?? '',
              onPick: v => void apply({ effort: (v || null) as Effort | null }),
            },
          ]}
          toggles={
            caps?.thinkingSummaries
              ? [
                  {
                    key: 'thinking',
                    label: '显示思考摘要',
                    value: record.thinkingSummaries,
                    onChange: v => void apply({ thinkingSummaries: v }),
                  },
                ]
              : []
          }
        />
      )}
    </>
  )
}
