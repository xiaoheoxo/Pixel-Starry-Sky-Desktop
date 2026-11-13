// 概况 › 产出：这个会话 7 天内交付的文件（和产物页「交付」同一份数据）。按类型筛；最新一个放大成一张小卡（类型、大小、多久前、目录，
// 「预览」是主按钮），其余一行；工作区外的标出来，已经删掉的划线、不能预览。点一下在产物页预览
import { useEffect, useState } from 'react'
import {
  ExternalLink,
  Eye,
  File,
  FileArchive,
  FileText,
  Film,
  FolderOpen,
  Globe,
  Image,
  Package,
  Sheet,
  type LucideIcon,
} from 'lucide-react'
import type { ArtifactDelivery, DeliveryType } from '@pixelsky/protocol'
import { cn, IconButton, useToast } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage, type TranslationKey } from '@/i18n/core'
import { machineOf } from '@/features/machines/store'
import { formatBytes, nextArtifactsRequest, splitArtifactPath } from '../artifacts/artifactsModel'
import { previewDelivery } from '../artifacts/focus'
import { ago } from '../git/gitModel'
import { openRightTab } from '../workspaceStore'
import type { SectionProps } from './OverviewPanel'
import { FilterChips, Pill, ROW_HIDE, ROW_OPS, Section, SECTION_LINKS, SectionLink, Tag } from './Section'

const DAYS = 7
/** 放大的那个之外再列几个 */
const MORE_ROWS = 4

type Kind = DeliveryType | 'other'

const ICON: Record<Kind, LucideIcon> = {
  document: FileText,
  image: Image,
  table: Sheet,
  web: Globe,
  archive: FileArchive,
  media: Film,
  other: File,
}

export function OutputsSection({ sessionId, active }: SectionProps) {
  useI18n()
  const items = useDelivered(sessionId, active)
  const [filter, setFilter] = useState<'all' | Kind>('all')
  if (!active || !items.length) return null
  const sorted = [...items].sort((a, b) => b.at - a.at)
  const types = [...new Set(sorted.map(d => d.type))]
  const options = [
    { id: 'all' as const, label: tr('artifacts.type.all'), count: items.length },
    ...types.map(t => ({
      id: t,
      label: tr(`artifacts.type.${t}` as TranslationKey),
      count: items.filter(d => d.type === t).length,
    })),
  ]
  const shown = filter === 'all' || types.includes(filter) ? filter : 'all'
  const [first, ...rest] = sorted.filter(d => shown === 'all' || d.type === shown)
  return (
    <Section
      id="outputs"
      icon={Package}
      title={tr('overview.outputs')}
      count={items.length}
      summary={tr('overview.outputsLatest', { name: nameOf(sorted[0]!) })}
    >
      {types.length > 1 && (
        <FilterChips<'all' | Kind> value={shown} onChange={setFilter} options={options} className="mb-0.5" />
      )}
      {first && <Featured d={first} />}
      {rest.slice(0, MORE_ROWS).map(d => (
        <OutputRow key={d.absolute} d={d} />
      ))}
      <div className={SECTION_LINKS}>
        <SectionLink onClick={() => openRightTab('artifacts')}>
          <ExternalLink size={13} strokeWidth={1.6} />
          {tr('overview.outputsAll', { count: items.length })}
        </SectionLink>
      </div>
    </Section>
  )
}

const nameOf = (d: ArtifactDelivery): string => splitArtifactPath(d.local ?? d.absolute).name
const dirOf = (d: ArtifactDelivery): string => splitArtifactPath(d.local ?? d.absolute).dir

/** 本机、文件还在、不是演示：才能打开和在文件夹中显示 */
function useFileOps(d: ArtifactDelivery) {
  const toast = useToast()
  const can = machineOf(d.sessionId) === 'local' && d.exists && !isDemo
  const run = (fn: () => Promise<unknown> | undefined): void =>
    void fn()?.catch(e => toast(translateMessage((e as Error).message)))
  const target = { sessionId: d.sessionId, path: d.absolute }
  return {
    can,
    open: () => run(() => window.pixelsky?.artifacts.open(target)),
    reveal: () => run(() => window.pixelsky?.artifacts.reveal(target)),
  }
}

function Featured({ d }: { d: ArtifactDelivery }) {
  const Icon = ICON[d.type]
  const ops = useFileOps(d)
  const meta = [tr(`artifacts.type.${d.type}` as TranslationKey), d.bytes !== null && formatBytes(d.bytes), ago(d.at)]
  return (
    <div data-overview-output={d.absolute} className="-mx-0.5 mt-0.5 mb-1 flex gap-2.5 rounded-xl bg-ov-tile p-2">
      <span className="grid size-11 shrink-0 place-items-center rounded-[10px] bg-ov-chip text-fg-muted">
        <Icon size={20} strokeWidth={1.5} />
      </span>
      <span className="min-w-0 flex-1">
        <b title={d.absolute} className={cn('block truncate font-medium', !d.exists && 'text-fg-faint line-through')}>
          {nameOf(d)}
        </b>
        <span className="mt-px block truncate text-label text-fg-muted">
          {meta.filter(Boolean).join(' · ')}
          {!d.inside && ` · ${tr('artifacts.outsideBadge')}`}
        </span>
        {dirOf(d) && <span className="block truncate font-mono text-label text-fg-faint">{dirOf(d)}</span>}
        <span className="flex items-center gap-0.5 pt-1.5">
          {d.exists ? (
            <Pill tone="primary" onClick={() => previewDelivery(d)}>
              <Eye size={13} strokeWidth={1.6} />
              {tr('overview.preview')}
            </Pill>
          ) : (
            <Tag>{tr('artifacts.missing')}</Tag>
          )}
          {ops.can && (
            <>
              <IconButton icon={ExternalLink} label={tr('artifacts.open')} size={22} iconSize={13} onClick={ops.open} />
              <IconButton
                icon={FolderOpen}
                label={tr('artifacts.reveal')}
                size={22}
                iconSize={13}
                onClick={ops.reveal}
              />
            </>
          )}
        </span>
      </span>
    </div>
  )
}

function OutputRow({ d }: { d: ArtifactDelivery }) {
  const Icon = ICON[d.type]
  const ops = useFileOps(d)
  return (
    <div className="group/row relative">
      <button
        type="button"
        title={d.absolute}
        data-overview-output={d.absolute}
        disabled={!d.exists}
        onClick={() => previewDelivery(d)}
        className="press -mx-1.5 flex min-h-7 w-[calc(100%+12px)] items-center gap-[9px] rounded-full px-1.5 text-left text-fg-secondary enabled:hover:bg-hover disabled:cursor-default"
      >
        <Icon size={15} strokeWidth={1.6} className="shrink-0 text-fg-muted" />
        <span className={cn('min-w-0 flex-1 truncate', !d.exists && 'text-fg-faint line-through')}>
          {nameOf(d)}
          {dirOf(d) && <small className="ml-[5px] text-label text-fg-faint no-underline">{dirOf(d)}</small>}
        </span>
        {!d.inside && <Tag>{tr('artifacts.outsideBadge')}</Tag>}
        {!d.exists && <Tag>{tr('artifacts.missing')}</Tag>}
        <span className={cn('shrink-0 text-label text-fg-faint', ops.can && ROW_HIDE)}>{ago(d.at)}</span>
      </button>
      {/* 按钮不能套按钮：操作浮在行的右端 */}
      {ops.can && (
        <span className={cn(ROW_OPS, 'absolute top-1/2 right-0 -translate-y-1/2')}>
          <IconButton
            icon={Eye}
            label={tr('overview.preview')}
            size={22}
            iconSize={13}
            onClick={() => previewDelivery(d)}
          />
          <IconButton icon={FolderOpen} label={tr('artifacts.reveal')} size={22} iconSize={13} onClick={ops.reveal} />
        </span>
      )}
    </div>
  )
}

/** 打开概况时读一次，这个会话一轮结束（去抖）再读；看不见时不读 */
function useDelivered(sessionId: string, active: boolean): ArtifactDelivery[] {
  const [items, setItems] = useState<ArtifactDelivery[]>([])
  useEffect(() => {
    if (!active) return
    if (isDemo) return setItems(demo().artifacts.response.delivered)
    const api = window.pixelsky
    if (!api) return
    let gone = false,
      latest = 0,
      timer = 0
    const load = (): void => {
      const id = (latest = nextArtifactsRequest())
      api.artifacts
        .list({ requestId: id, sessionId, days: DAYS })
        // 被产物页更新的扫描顶掉（cancelled）时留着上一次的
        .then(res => !gone && id === latest && !res.cancelled && setItems(res.delivered))
        .catch(() => undefined)
    }
    load()
    const off = api.engine.onEvent(e => {
      if (e.kind === 'session' && e.sessionId === sessionId && e.event.type === 'turn_completed') {
        window.clearTimeout(timer)
        timer = window.setTimeout(load, 800)
      }
    })
    return () => {
      gone = true
      window.clearTimeout(timer)
      off()
    }
  }, [sessionId, active])
  return items
}
