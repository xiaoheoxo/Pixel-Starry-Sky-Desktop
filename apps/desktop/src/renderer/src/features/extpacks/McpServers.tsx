import { useState } from 'react'
import type { ExtLocale, ExtMcpServer, ExtPackMcpStatus } from '@pixelsky/protocol'
import { extText } from '@pixelsky/protocol'
import { Button } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { translateMessage } from '@/i18n/core'
import { FIELD } from '@/features/settings/engines/parts'
import { PackBadge } from '@/features/settings/extensions/PackBadge'
import { refreshPacks } from './store'

// 扩展里的 MCP 连接器（docs/ui/extension-remaining-plan.md §G.2）：它会在用户电脑上运行的程序、来源；
// 装在本机时（packKey）可以填值、同意启用、停用。同意记的是当前这一份，更新改了命令要重新同意（主进程 extension-packs/mcp.ts）

/** 给人看的启动方式：stdio 是整条命令，http / sse 是地址 */
export function mcpCommandLine(s: ExtMcpServer): string {
  return s.type === 'stdio' ? [s.command ?? '', ...(s.args ?? [])].join(' ') : (s.url ?? '')
}

function ServerRow({
  server,
  status,
  packKey,
  locale,
}: {
  server: ExtMcpServer
  status?: ExtPackMcpStatus
  packKey?: string
  locale: ExtLocale
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputs = server.inputs ?? []
  const filled = new Set(status?.filled ?? [])

  const save = async (approved: boolean): Promise<void> => {
    if (!packKey) return
    setBusy(true)
    setError(null)
    try {
      // 没动的输入框不传（null = 不动），免得把已存的密钥清掉
      const patch: Record<string, string | null> = {}
      for (const i of inputs) patch[i.name] = values[i.name]?.trim() || null
      await window.pixelsky?.extpacks.setMcp(packKey, server.name, approved, patch)
      setValues({})
      await refreshPacks()
    } catch (e) {
      setError(translateMessage((e as Error)?.message ?? String(e)))
    } finally {
      setBusy(false)
    }
  }
  const missingNow = inputs.filter(i => i.required && !filled.has(i.name) && !values[i.name]?.trim())

  return (
    <li data-mcp-server={server.name} className="rounded-md border border-line-subtle p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui font-medium text-fg">{server.name}</span>
        <span className="text-meta text-fg-faint">{server.type}</span>
        {status &&
          (status.approved ? (
            status.missing.length ? (
              <PackBadge tone="warn">{t('extensions.mcp.needsValues')}</PackBadge>
            ) : (
              <PackBadge tone="info">{t('extensions.mcp.on')}</PackBadge>
            )
          ) : (
            <PackBadge tone="warn">{t('extensions.mcp.needsApproval')}</PackBadge>
          ))}
      </div>
      {server.description && (
        <div className="mt-0.5 text-meta text-fg-muted">{extText(server.description, locale)}</div>
      )}
      <code className="selectable mt-2 block break-all rounded bg-subtle px-2 py-1 font-mono text-meta text-fg">
        {mcpCommandLine(server)}
      </code>
      <div className="mt-1 text-meta text-fg-faint">
        {t('extensions.mcp.source')}{' '}
        <a href={server.source} target="_blank" rel="noreferrer" className="text-accent hover:underline">
          {server.source}
        </a>
      </div>

      {packKey && inputs.length > 0 && (
        <div className="mt-3 space-y-2">
          {inputs.map(i => (
            <label key={i.name} className="block">
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
                value={values[i.name] ?? ''}
                placeholder={filled.has(i.name) ? t('extensions.mcp.keep') : ''}
                onChange={e => setValues(v => ({ ...v, [i.name]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}

      {packKey && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {status?.approved ? (
            <>
              {inputs.length > 0 && (
                <Button disabled={busy || !Object.values(values).some(v => v.trim())} onClick={() => void save(true)}>
                  {t('extensions.mcp.save')}
                </Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => void save(false)}>
                {t('extensions.mcp.revoke')}
              </Button>
            </>
          ) : (
            <Button
              data-mcp-approve
              variant="primary"
              disabled={busy || missingNow.length > 0}
              onClick={() => void save(true)}
            >
              {t('extensions.mcp.approve')}
            </Button>
          )}
          {!status?.approved && missingNow.length > 0 && (
            <span className="text-meta text-fg-muted">
              {t('extensions.mcp.fillFirst', { names: missingNow.map(i => i.name).join(', ') })}
            </span>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="selectable mt-2 break-words text-meta text-danger">
          {error}
        </p>
      )}
    </li>
  )
}

/** 扩展详情里的「会运行的程序」：没有连接器时不显示 */
export function McpServers({
  servers,
  status,
  packKey,
}: {
  servers: ExtMcpServer[] | undefined
  status?: ExtPackMcpStatus[]
  /** 装在本机的那份；不传就只显示（商店里还没装） */
  packKey?: string
}) {
  const { locale, t } = useI18n()
  if (!servers?.length) return null
  return (
    <section data-mcp-servers className="mt-5">
      <h5 className="mb-2 text-label font-medium text-fg-muted">{t('extensions.mcp.title')}</h5>
      <p className="mb-3 text-ui text-danger">{t('extensions.mcp.warning')}</p>
      <ul className="space-y-3">
        {servers.map(s => (
          <ServerRow
            key={s.name}
            server={s}
            status={status?.find(x => x.name === s.name)}
            packKey={packKey}
            locale={locale}
          />
        ))}
      </ul>
      {packKey && <p className="mt-2 text-meta text-fg-faint">{t('extensions.mcp.footnote')}</p>}
    </section>
  )
}
