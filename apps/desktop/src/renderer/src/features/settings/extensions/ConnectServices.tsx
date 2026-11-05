import { useEffect, useState, type ReactNode } from 'react'
import type { ExtPackInfo, ExtStoreDetail, ExtStoreItem } from '@pixelsky/protocol'
import { extText } from '@pixelsky/protocol'
import { Button } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { FIELD } from '@/features/settings/engines/parts'
import { getPackState, refreshPacks, usePackState } from '@/features/extpacks/store'
import { mcpCommandLine, noProgramText } from '@/features/extpacks/McpServers'
import { openExtDetail } from '@/features/extstore/nav'
import {
  connectExtension,
  connectorNoProgram,
  connectorOn,
  disconnectExtension,
  isConnector,
  type ConnectDeps,
} from '@/features/extstore/connectors'
import { fetchCatalog, getExtStore, installExtension, storeBridge } from '@/features/extstore/store'
import { PackBadge } from './PackBadge'
import { StoreFeaturedCard } from './StoreCard'

// 发现页最上面的「连接常用服务」（docs/ui/one-click-connectors.md）：不写死名单，商店里官方发布的 MCP 连接器都放在这，
// 上架一个新的不用发版。确认框看到什么、装什么、同意什么都是同一份（features/extstore/connectors.ts）

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

const extpacks = () => window.pixelsky?.extpacks

const DEPS: ConnectDeps = {
  install: (id, version, kind, name) => installExtension(id, version, { silent: true, kind, name }),
  installError: id => getExtStore().installErrors[id],
  refresh: refreshPacks,
  packs: () => getPackState().packs,
  setEnabled: async (key, enabled) => {
    await extpacks()?.setEnabled(key, enabled)
  },
  setMcp: async (key, name, approved, values) => {
    await extpacks()?.setMcp(key, name, approved, values)
  },
}

/** 上次取到的：从详情页回来时直接有，不会等请求回来才把下面的列表往下推（滚动位置就错了） */
let lastConnectors: ExtStoreItem[] = []

/** 商店里官方发布的连接器；取不到就当没有，下面的列表会说连不上 */
export function useConnectors(): ExtStoreItem[] {
  const [items, setItems] = useState(lastConnectors)
  useEffect(() => {
    let alive = true
    fetchCatalog({ category: 'mcpServers' })
      .then(page => {
        lastConnectors = page.items.filter(isConnector)
        if (alive) setItems(lastConnectors)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return items
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-t border-line-subtle py-2">
      <dt className="text-meta text-fg-muted">{label}</dt>
      <dd className="text-ui text-fg-secondary">{children}</dd>
    </div>
  )
}

function ConnectDialog({
  detail,
  pack,
  onClose,
}: {
  detail: ExtStoreDetail
  pack: ExtPackInfo | undefined
  onClose(): void
}) {
  const { locale, t } = useI18n()
  const servers = detail.manifest?.contributes.mcpServers ?? []
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const filledBefore = (server: string, input: string): boolean =>
    !!pack?.mcp?.find(s => s.name === server)?.filled.includes(input)
  const missing = servers.some(s =>
    (s.inputs ?? []).some(i => i.required && !filledBefore(s.name, i.name) && !values[s.name]?.[i.name]?.trim()),
  )
  const hasInputs = servers.some(s => s.inputs?.length)

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await connectExtension(detail, values, DEPS, {
        changed: tr('extstore.connect.changed'),
        failed: tr('extstore.connect.failed'),
        noProgram: noProgramText,
      })
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      title={detail.extension.name}
      confirmLabel={busy ? t('extstore.connect.busy') : t('extstore.connect.action')}
      cancelLabel={t('extensions.detail.removeNo')}
      busy={busy}
      error={error}
      focusInput={hasInputs}
      confirmDisabled={missing}
      onConfirm={() => void connect()}
      onCancel={onClose}
      description={
        <div data-connect-dialog={detail.extension.id}>
          {servers.some(s => s.type === 'stdio') && (
            <p className="mb-2 text-ui text-danger">{t('extensions.mcp.warning')}</p>
          )}
          <dl>
            {servers.map(s => (
              <Fact key={s.name} label={t(s.type === 'stdio' ? 'extstore.connect.run' : 'extstore.connect.url')}>
                <code className="selectable block break-all font-mono text-meta text-fg">{mcpCommandLine(s)}</code>
                <a href={s.source} target="_blank" rel="noreferrer" className="text-meta text-accent hover:underline">
                  {t('extensions.mcp.source')}
                </a>
              </Fact>
            ))}
            <Fact label={t('extstore.connect.can')}>
              {t(hasInputs ? 'extstore.connect.canApp' : 'extstore.connect.canAccount')}
            </Fact>
            {servers.some(s => s.type !== 'stdio') && (
              <Fact label={t('extstore.connect.login')}>{t('extstore.connect.loginText')}</Fact>
            )}
            <Fact label={t('extstore.connect.scope')}>{t('extstore.connect.scopeText')}</Fact>
            {servers.flatMap(s =>
              (s.inputs ?? []).map(i => (
                <div key={`${s.name}:${i.name}`} className="border-t border-line-subtle py-2">
                  <label className="block">
                    <span className="text-meta text-fg-muted">
                      <span className="font-mono">{i.name}</span>
                      {i.required && <span className="ml-1 text-danger">*</span>}
                      <span className="ml-2">{extText(i.description, locale)}</span>
                    </span>
                    <input
                      className={`${FIELD} mt-1 font-mono`}
                      type={i.secret ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={busy}
                      value={values[s.name]?.[i.name] ?? ''}
                      placeholder={filledBefore(s.name, i.name) ? t('extensions.mcp.keep') : ''}
                      onChange={e => setValues(v => ({ ...v, [s.name]: { ...v[s.name], [i.name]: e.target.value } }))}
                    />
                  </label>
                </div>
              )),
            )}
          </dl>
        </div>
      }
    />
  )
}

export function ConnectServices({ items }: { items: ExtStoreItem[] }) {
  const { t } = useI18n()
  const packs = usePackState().packs
  const [dialog, setDialog] = useState<ExtStoreDetail | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const packOf = (id: string): ExtPackInfo | undefined => packs.find(p => p.id === id && !p.shadowedBy)

  const open = async (id: string): Promise<void> => {
    setOpening(id)
    setErrors(({ [id]: _drop, ...rest }) => rest)
    try {
      const detail = await storeBridge()?.detail(id)
      if (!detail) throw new Error(tr('extstore.connect.failed'))
      setDialog(detail)
    } catch (e) {
      setErrors(all => ({ ...all, [id]: errorText(e) }))
    } finally {
      setOpening(null)
    }
  }

  const turnOff = async (pack: ExtPackInfo, id: string): Promise<void> => {
    setOpening(id)
    try {
      await disconnectExtension(pack, DEPS)
    } catch (e) {
      setErrors(all => ({ ...all, [id]: errorText(e) }))
    } finally {
      setOpening(null)
    }
  }

  if (!items.length) return null
  return (
    <section data-connect-services className="mb-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
        <h4 className="text-meta font-semibold text-fg-secondary">{t('extstore.connect.title')}</h4>
        <span className="text-meta text-fg-muted">{t('extstore.connect.hint')}</span>
      </div>
      <ul className="grid grid-cols-1 gap-3 @min-[30rem]:grid-cols-3">
        {items.map(item => {
          const pack = packOf(item.id)
          const on = connectorOn(pack)
          const noProgram = on ? connectorNoProgram(pack) : undefined
          const remote = pack?.manifest?.contributes.mcpServers?.some(s => s.type !== 'stdio')
          return (
            <StoreFeaturedCard
              key={item.id}
              item={item}
              state={{ installed: !!pack, error: errors[item.id] }}
              handlers={{ onOpen: openExtDetail, onInstall: () => {}, onCancel: () => {} }}
              footer={
                <>
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    {noProgram ? (
                      <PackBadge tone="warn">{t('extstore.connect.cantStart')}</PackBadge>
                    ) : on ? (
                      <PackBadge tone="info">{t('extensions.mcp.on')}</PackBadge>
                    ) : (
                      <PackBadge>{t('extstore.kind.mcpServers')}</PackBadge>
                    )}
                  </span>
                  {on && pack ? (
                    <Button
                      variant="ghost"
                      className="h-7 px-2.5 text-meta"
                      disabled={opening === item.id}
                      data-connect-off={item.id}
                      onClick={() => void turnOff(pack, item.id)}
                    >
                      {t('extensions.mcp.revoke')}
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      className="h-7 px-2.5 text-meta"
                      disabled={opening === item.id}
                      data-connect-on={item.id}
                      onClick={() => void open(item.id)}
                    >
                      {t('extstore.connect.action')}
                    </Button>
                  )}
                  {noProgram ? (
                    <p className="w-full text-meta text-warn">{noProgramText(noProgram)}</p>
                  ) : (
                    on && (
                      <p className="w-full text-meta text-fg-muted">
                        {t(remote ? 'extstore.connect.nextLogin' : 'extstore.connect.nextReady')}
                      </p>
                    )
                  )}
                </>
              }
            />
          )
        })}
      </ul>
      {dialog && <ConnectDialog detail={dialog} pack={packOf(dialog.extension.id)} onClose={() => setDialog(null)} />}
    </section>
  )
}
