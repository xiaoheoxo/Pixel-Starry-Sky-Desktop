import { Download } from 'lucide-react'
import type { ExtPackContributionKind, ExtStoreItem } from '@pixelsky/protocol'
import { cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { cardAction, cardFields, formatDownloads } from '@/features/extstore/storeModel'
import { InstallButton } from '@/features/extstore/InstallButton'
import { PackBadge } from './PackBadge'
import { PackIcon } from './PackList'

// 发现页上的一项：大卡片（首屏前 3 个）和列表行共用同一套字段和按钮（docs/ui/extension-store-client.md §2.1）

const KIND_KEYS = {
  grammars: 'extstore.kind.grammars',
  themes: 'extstore.kind.themes',
  snippets: 'extstore.kind.snippets',
  iconThemes: 'extstore.kind.iconThemes',
  taskTemplates: 'extstore.kind.taskTemplates',
  skills: 'extstore.kind.skills',
  prompts: 'extstore.kind.prompts',
} as const satisfies Record<ExtPackContributionKind, TranslationKey>

/** 一项上的动作要用到的状态，由 DiscoverTab 算好传下来 */
export interface CardState {
  installed: boolean
  /** 本机装的版本；有了才能判断商店的版本是不是真的更新 */
  installedVersion?: string | null
  update?: Parameters<typeof cardAction>[0]['update']
  progress?: Parameters<typeof cardAction>[0]['progress']
  /** 最近一次安装失败的提示 */
  error?: string
}

export interface CardHandlers {
  onOpen(id: string): void
  onInstall(item: ExtStoreItem, version: string): void
  onCancel(id: string): void
}

/** 贡献种类小标签（只显示认识的种类） */
function KindTags({ kinds }: { kinds: ExtPackContributionKind[] }) {
  const { t } = useI18n()
  return (
    <>
      {kinds.map(kind => (
        <PackBadge key={kind}>{t(KIND_KEYS[kind])}</PackBadge>
      ))}
    </>
  )
}

function Downloads({ n }: { n: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-meta text-fg-faint"
      title={tr('extstore.downloads', { n: formatDownloads(n) })}
    >
      <Download size={11} strokeWidth={1.75} aria-hidden />
      {formatDownloads(n)}
    </span>
  )
}

function Heading({
  name,
  publisher,
  official,
  stacked,
}: {
  name: string
  publisher: string
  official: boolean
  stacked?: boolean
}) {
  const { t } = useI18n()
  const badge = official && <PackBadge tone="info">{t('extstore.official')}</PackBadge>
  const by = <span className="truncate text-meta text-fg-faint">{publisher}</span>
  return stacked ? (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-ui font-medium text-fg">{name}</span>
      <span className="flex items-center gap-1.5">
        {by}
        {badge}
      </span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-ui font-medium text-fg">{name}</span>
      {by}
      {badge}
    </span>
  )
}

/** 大卡片：图标、名称、发布者、说明、种类小标签，按钮在右下 */
export function StoreFeaturedCard({
  item,
  state,
  handlers,
}: {
  item: ExtStoreItem
  state: CardState
  handlers: CardHandlers
}) {
  const f = cardFields(item)
  const action = cardAction(state)
  return (
    <li
      data-store-item={item.id}
      data-store-card="featured"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3 hover:bg-hover"
    >
      <button
        type="button"
        onClick={() => handlers.onOpen(item.id)}
        className="no-drag flex min-w-0 flex-1 flex-col gap-2 text-left"
      >
        <span className="flex items-center gap-2.5">
          <PackIcon src={f.iconSrc} name={f.name} size={32} />
          <Heading name={f.name} publisher={f.publisher} official={f.official} stacked />
        </span>
        <span className="line-clamp-2 min-h-[2.8em] text-meta text-fg-muted">{f.description}</span>
      </button>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <KindTags kinds={f.kinds} />
        </span>
        <InstallButton
          id={item.id}
          version={item.version}
          action={action}
          onInstall={v => handlers.onInstall(item, v)}
          onCancel={handlers.onCancel}
        />
      </div>
      {state.error && <p className="text-meta text-danger">{state.error}</p>}
    </li>
  )
}

/** 列表行：图标、名称、发布者、官方标、说明、种类小标签、下载量，右边是按钮 */
export function StoreRow({ item, state, handlers }: { item: ExtStoreItem; state: CardState; handlers: CardHandlers }) {
  const f = cardFields(item)
  const action = cardAction(state)
  return (
    <li
      data-store-item={item.id}
      data-store-card="row"
      className={cn('px-3 py-2.5 first:rounded-t-lg last:rounded-b-lg hover:bg-hover')}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => handlers.onOpen(item.id)}
          className="no-drag flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <PackIcon src={f.iconSrc} name={f.name} size={32} />
          <span className="min-w-0 flex-1">
            <Heading name={f.name} publisher={f.publisher} official={f.official} />
            <span className="mt-0.5 block truncate text-meta text-fg-muted">{f.description}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1">
              <KindTags kinds={f.kinds} />
              <Downloads n={f.downloads} />
            </span>
          </span>
        </button>
        <InstallButton
          id={item.id}
          version={item.version}
          action={action}
          onInstall={v => handlers.onInstall(item, v)}
          onCancel={handlers.onCancel}
        />
      </div>
      {state.error && <p className="mt-1.5 pl-11 text-meta text-danger">{state.error}</p>}
    </li>
  )
}
