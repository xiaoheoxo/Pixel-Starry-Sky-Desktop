import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type {
  ExtStoreCheckReport,
  ExtStoreMyExtension,
  ExtStorePickUploadResult,
  ExtStorePublisherState,
} from '@pixelsky/protocol'
import { Button } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { translateMessage } from '@/i18n/core'
import { PackBadge } from '@/features/settings/extensions/PackBadge'
import { DelistConfirm } from './DelistConfirm'
import { RegisterPanel } from './RegisterPanel'
import { UploadPanel } from './UploadPanel'
import { VersionRow } from './VersionRow'
import { delistedByAdmin, extensionActions, liveVersion, maskedEmail, schedulePoll } from './publishModel'

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

export interface PublishTabProps {
  signedIn: boolean
  /** 账号邮箱；顶上只显示打码的 */
  email: string | null
  /** 还没读到时是 null */
  state: ExtStorePublisherState | null
  loadError?: string | null
  onSignIn(): void
  /** 重新读 extstore.publisher()；有待审核版本时每 2 分钟自动调一次 */
  onRefresh(): void
  onRegister(name: string): Promise<unknown>
  onWithdraw(id: string, version: string): Promise<unknown>
  onDelist(id: string): Promise<unknown>
  onRelist(id: string): Promise<unknown>
  /** 点开一个版本：读本机存的逐条结果，没有回 null */
  onLoadReport(id: string, version: string): Promise<ExtStoreCheckReport | null>
  /** 上传面板 */
  picked: ExtStorePickUploadResult | null
  uploading: boolean
  uploadError?: string | null
  /** 云端回 check_failed 时带回来的检查结果 */
  cloudReport?: ExtStoreCheckReport | null
  onPick(input: null | { bytes: ArrayBuffer; name: string }): void
  onSubmitUpload(token: string): void
  onCancelUpload(): void
  /** 测试 / 外部控制用的初始状态 */
  initialUploadOpen?: boolean
  initialExpanded?: string[]
  initialReports?: Record<string, ExtStoreCheckReport | null>
  initialDelist?: string | null
}

function ExtensionCard({
  ext,
  expanded,
  reports,
  onToggle,
  onWithdraw,
  onDelist,
  onRelist,
  busy,
}: {
  ext: ExtStoreMyExtension
  expanded: Set<string>
  reports: Record<string, ExtStoreCheckReport | null>
  onToggle(version: string): void
  onWithdraw(version: string): void
  onDelist(): void
  onRelist(): void
  busy: boolean
}) {
  const { t } = useI18n()
  const actions = extensionActions(ext)
  const live = liveVersion(ext)
  return (
    <li data-extension={ext.id} className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-start gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-list font-medium text-fg">{ext.name || ext.id}</span>
            <span className="font-mono text-meta text-fg-faint">{ext.id}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-meta text-fg-muted">
            <span>{t('extstore.publish.ext.downloads', { count: ext.downloads })}</span>
            <span>
              {live ? t('extstore.publish.ext.latest', { version: live }) : t('extstore.publish.ext.notLive')}
            </span>
            {ext.delisted && !delistedByAdmin(ext) && (
              <PackBadge>{t('extstore.publish.ext.delistedByAuthor')}</PackBadge>
            )}
          </div>
          {delistedByAdmin(ext) && (
            <p data-delisted-by-admin className="mt-1 text-meta text-danger">
              {t('extstore.publish.ext.delistedByAdmin', { reason: ext.delistReason })}
            </p>
          )}
          {ext.blocked && (
            <p className="mt-1 text-meta text-danger">
              {t('extstore.publish.ext.blocked', { reason: ext.blockReason })}
            </p>
          )}
        </div>
        {actions.delist && (
          <Button disabled={busy} onClick={onDelist}>
            {t('extstore.publish.ext.delist')}
          </Button>
        )}
        {actions.relist && (
          <Button disabled={busy} onClick={onRelist}>
            {t('extstore.publish.ext.relist')}
          </Button>
        )}
      </div>
      <ul>
        {[...ext.versions].reverse().map(v => {
          const key = `${ext.id}@${v.version}`
          const open = expanded.has(key)
          return (
            <VersionRow
              key={v.version}
              version={v}
              open={open}
              report={key in reports ? reports[key] : undefined}
              busy={busy}
              onToggle={() => onToggle(v.version)}
              onWithdraw={() => onWithdraw(v.version)}
            />
          )
        })}
      </ul>
    </li>
  )
}

/**
 * 「我的发布」页签：props 驱动，不读状态单例。
 * 没登录 → 说明和登录按钮；没有发布者 → 注册表单；有发布者 → 顶栏、我的扩展列表、上传面板。
 * 不显示「作者文档」链接（用户已定：以后有确定能打开的地址再加）。
 */
export function PublishTab(props: PublishTabProps) {
  const { t } = useI18n()
  const { state } = props
  const [uploadOpen, setUploadOpen] = useState(props.initialUploadOpen ?? false)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(props.initialExpanded))
  const [reports, setReports] = useState<Record<string, ExtStoreCheckReport | null>>(props.initialReports ?? {})
  const [delistTarget, setDelistTarget] = useState<string | null>(props.initialDelist ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useRef(props.onRefresh)
  refresh.current = props.onRefresh

  // 有待审核的版本、页面又开着时，每 2 分钟刷新一次；state 变了（刷新回来）重新排
  useEffect(() => schedulePoll(state, () => refresh.current()), [state])

  if (!props.signedIn) {
    return (
      <div data-publish="signed-out" className="rounded-lg border border-line px-4 py-8 text-center">
        <p className="text-list font-medium text-fg">{t('extstore.publish.signIn.title')}</p>
        <p className="mt-1 mb-4 text-meta text-fg-muted">{t('extstore.publish.signIn.hint')}</p>
        <Button variant="primary" onClick={props.onSignIn}>
          {t('extstore.publish.signIn.button')}
        </Button>
      </div>
    )
  }
  if (!state) {
    return props.loadError ? (
      <div data-publish="error" className="text-ui text-danger">
        {t('extstore.publish.loadFailed', { error: props.loadError })}
        <Button className="ml-3" onClick={props.onRefresh}>
          {t('extstore.publish.retry')}
        </Button>
      </div>
    ) : (
      <p data-publish="loading" className="text-ui text-fg-muted">
        {t('extstore.publish.loading')}
      </p>
    )
  }
  if (!state.publisher) {
    return (
      <div data-publish="register">
        <RegisterPanel
          onRegister={async name => {
            await props.onRegister(name)
          }}
        />
      </div>
    )
  }

  const publisher = state.publisher
  const run = async (job: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await job()
      props.onRefresh()
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const toggle = (id: string, version: string): void => {
    const key = `${id}@${version}`
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else {
      next.add(key)
      if (!(key in reports)) {
        props
          .onLoadReport(id, version)
          .then(r => setReports(prev => ({ ...prev, [key]: r })))
          .catch(() => setReports(prev => ({ ...prev, [key]: null })))
      }
    }
    setExpanded(next)
  }
  const delistName = state.extensions.find(e => e.id === delistTarget)?.name || delistTarget || ''

  return (
    <div data-publish="ready">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-ui text-fg-muted">
          {t('extstore.publish.header.publisher')} <b className="text-fg">{publisher.name}</b>
          {props.email && <span className="ml-2 text-fg-faint">（{maskedEmail(props.email)}）</span>}
        </span>
        <span className="flex-1" />
        <Button variant="primary" icon={Plus} onClick={() => setUploadOpen(true)}>
          {t('extstore.publish.header.upload')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-ui text-danger">
          {error}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div>
          {state.extensions.length === 0 ? (
            <p className="rounded-lg border border-line px-3 py-6 text-center text-ui text-fg-faint">
              {t('extstore.publish.empty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {state.extensions.map(ext => (
                <ExtensionCard
                  key={ext.id}
                  ext={ext}
                  expanded={expanded}
                  reports={reports}
                  busy={busy}
                  onToggle={v => toggle(ext.id, v)}
                  onWithdraw={v => void run(() => props.onWithdraw(ext.id, v))}
                  onDelist={() => setDelistTarget(ext.id)}
                  onRelist={() => void run(() => props.onRelist(ext.id))}
                />
              ))}
            </ul>
          )}
        </div>
        {uploadOpen && (
          <UploadPanel
            publisherName={publisher.name}
            picked={props.picked}
            previous={props.picked?.previousContributes ?? null}
            uploading={props.uploading}
            error={props.uploadError}
            cloudReport={props.cloudReport}
            onPick={props.onPick}
            onSubmit={props.onSubmitUpload}
            onCancel={() => {
              setUploadOpen(false)
              props.onCancelUpload()
            }}
          />
        )}
      </div>
      {delistTarget && (
        <DelistConfirm
          name={delistName}
          busy={busy}
          error={error}
          onCancel={() => setDelistTarget(null)}
          onConfirm={() => {
            const id = delistTarget
            void run(() => props.onDelist(id)).then(ok => ok && setDelistTarget(null))
          }}
        />
      )}
    </div>
  )
}
