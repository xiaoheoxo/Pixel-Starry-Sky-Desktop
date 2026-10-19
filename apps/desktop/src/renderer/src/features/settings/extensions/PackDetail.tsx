import { useEffect, useState } from 'react'
import { ArrowLeft, FolderOpen } from 'lucide-react'
import type { ExtPackInfo, ExtPackIssue } from '@pixelsky/protocol'
import { forSource, packDescription } from '@pixelsky/protocol'
import { Button, Switch } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { readPackText, refreshPacks } from '@/features/extpacks/store'
import { contributionRows, grammarConflicts, issueText, packTitle, type ContributionRow } from './model'
import { SourceBadge } from '@/features/extstore/installed/InstalledBadges'
import { StoreReadme } from '@/features/extstore/detail/StoreReadme'
import { PackBadge } from './PackBadge'
import { PackIcon, PackStatus } from './PackList'

const KIND_LABELS = {
  grammars: 'extensions.kind.grammars',
  themes: 'extensions.kind.themes',
  snippets: 'extensions.kind.snippets',
  iconThemes: 'extensions.kind.iconThemes',
  taskTemplates: 'extensions.kind.taskTemplates',
  skills: 'extensions.kind.skills',
  prompts: 'extensions.kind.prompts',
} as const

const errorText = (e: unknown): string => translateMessage((e as Error)?.message ?? String(e))

function SubTitle({ children }: { children: string }) {
  return <h5 className="mt-5 mb-2 text-label font-medium text-fg-muted">{children}</h5>
}

function IssueList({ title, issues, locale }: { title: string; issues: ExtPackIssue[]; locale: 'zh-CN' | 'en-US' }) {
  const { t } = useI18n()
  if (!issues.length) return null
  return (
    <div className="mb-2">
      <div className="mb-1 text-meta text-fg-faint">{title}</div>
      <ul className="space-y-1">
        {issues.map((i, n) => (
          <li key={n} className={i.severity === 'error' ? 'text-ui text-danger' : 'text-ui text-warn'}>
            {issueText(i, locale)}
            {i.path && <span className="ml-1 text-meta text-fg-faint">{i.path}</span>}
            {i.upload && (
              <span className="ml-1 text-meta text-fg-faint">
                {i.upload === 'reject' ? t('extensions.detail.uploadReject') : t('extensions.detail.uploadHint')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PackDetail({ pack, all, onClose }: { pack: ExtPackInfo; all: ExtPackInfo[]; onClose(): void }) {
  const { locale, t } = useI18n()
  const bridge = window.pixelsky?.extpacks
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [readme, setReadme] = useState<string | null>(null)
  const folder = pack.source === 'folder'
  const title = packTitle(pack, locale)

  useEffect(() => {
    let alive = true
    setReadme(null)
    if (pack.manifest) {
      readPackText(pack.key, 'README.md')
        .then(text => alive && setReadme(text))
        .catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [pack.key, pack.revision, pack.manifest])

  const run = async (job: () => Promise<unknown> | undefined): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(null)
    try {
      await job()
      await refreshPacks()
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  // 内置扩展只显示错误，作者提示没有意义（forSource）
  const issues = forSource(pack.issues, pack.source)
  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')
  const rows = contributionRows(pack, locale)
  const conflicts = grammarConflicts(pack, all)
  const grammars = pack.manifest?.contributes.grammars ?? []
  const overrides = pack.options.overrideBuiltin ?? []

  const row = (r: ContributionRow) => (
    <li key={`${r.kind}-${r.index}`} className="flex flex-wrap items-center gap-2 text-ui">
      <span className="w-20 shrink-0 text-meta text-fg-faint">{t(KIND_LABELS[r.kind])}</span>
      <span className={r.active ? 'text-fg' : 'text-fg-faint line-through'}>{r.label}</span>
      {!r.active && (
        <PackBadge tone={r.issues.length ? 'danger' : 'neutral'}>{t('extensions.detail.inactive')}</PackBadge>
      )}
    </li>
  )

  return (
    <div data-pack-detail={pack.key}>
      <button
        type="button"
        onClick={onClose}
        className="press no-drag mb-3 inline-flex items-center gap-1 text-ui text-fg-muted hover:text-fg"
      >
        <ArrowLeft size={14} strokeWidth={1.5} />
        {t('extensions.detail.close')}
      </button>

      <div className="flex items-start gap-3">
        <PackIcon pack={pack} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-section font-semibold text-fg">{title}</h4>
            {pack.manifest && <span className="text-meta text-fg-faint">{pack.manifest.version}</span>}
            <SourceBadge source={pack.source} />
            <PackStatus pack={pack} />
          </div>
          <div className="mt-0.5 text-meta text-fg-faint">
            {pack.id ?? pack.key}
            {pack.manifest && ` · ${t('extensions.detail.publisher')} ${pack.manifest.publisher}`}
          </div>
          {folder && (
            <div className="mt-1 flex items-center gap-2 text-meta text-fg-muted">
              <span className="shrink-0">{t('extensions.detail.path')}</span>
              <span className="min-w-0 truncate" title={pack.path}>
                {pack.path}
              </span>
              <button
                type="button"
                aria-label={t('extensions.detail.reveal')}
                title={t('extensions.detail.reveal')}
                onClick={() => void run(() => bridge?.reveal(pack.key))}
                className="press no-drag shrink-0 text-fg-muted hover:text-fg"
              >
                <FolderOpen size={14} strokeWidth={1.5} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => void run(() => bridge?.reload(pack.key))}>
          {t('extensions.detail.reload')}
        </Button>
        <Button
          disabled={busy || pack.status === 'error' || (!pack.enabled && !!pack.blocked)}
          onClick={() => void run(() => bridge?.setEnabled(pack.key, !pack.enabled))}
        >
          {pack.enabled ? t('extensions.detail.disable') : t('extensions.detail.enable')}
        </Button>
        {pack.source !== 'builtin' &&
          (confirming ? (
            <span className="inline-flex items-center gap-2 text-ui text-fg-muted">
              {folder ? t('extensions.detail.removeConfirm') : t('extstore.installed.uninstallConfirm')}
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() => bridge?.remove(pack.key)).then(ok => {
                    if (ok) onClose()
                  })
                }
              >
                {folder ? t('extensions.detail.removeYes') : t('extstore.installed.uninstallYes')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t('extensions.detail.removeNo')}
              </Button>
            </span>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
              {folder ? t('extensions.detail.remove') : t('extstore.installed.uninstall')}
            </Button>
          ))}
      </div>
      {!pack.enabled && pack.blocked && (
        <p data-enable-reason className="mt-2 text-ui text-danger">
          {t('extstore.detail.blockedReason', { reason: pack.blocked.reason })}
        </p>
      )}
      {pack.shadowedBy && (
        <p data-enable-reason className="mt-2 text-ui text-fg-muted">
          {t('extstore.detail.shadowedReason', { source: t(`extstore.installed.shadowSource.${pack.shadowedBy}`) })}
        </p>
      )}
      {error && <p className="mt-2 text-ui text-danger">{error}</p>}

      {pack.manifest ? (
        <p className="mt-4 text-ui text-fg-secondary">{packDescription(pack.manifest, locale)}</p>
      ) : (
        <p className="mt-4 text-ui text-fg-muted">{t('extensions.detail.noManifest')}</p>
      )}

      {issues.length > 0 && (
        <>
          <SubTitle>{t('extensions.detail.issues')}</SubTitle>
          <IssueList title={t('extensions.detail.errors')} issues={errors} locale={locale} />
          <IssueList title={t('extensions.detail.warnings')} issues={warnings} locale={locale} />
        </>
      )}

      <SubTitle>{t('extensions.detail.contents')}</SubTitle>
      {rows.length ? (
        <ul className="space-y-1">{rows.map(row)}</ul>
      ) : (
        <p className="text-ui text-fg-faint">{t('extensions.detail.contentsEmpty')}</p>
      )}

      {conflicts.length > 0 && (
        <>
          <SubTitle>{t('extensions.detail.grammars')}</SubTitle>
          <ul className="space-y-3">
            {conflicts.map(c => {
              const g = grammars[c.index]
              return (
                <li key={c.index} className="text-ui">
                  <div className="font-medium text-fg">{g?.language ?? g?.scopeName}</div>
                  {c.otherPacks.length > 0 && (
                    <div className="text-meta text-fg-muted">
                      {tr('extensions.detail.conflictsWith', { names: c.otherPacks.join(', ') })}
                    </div>
                  )}
                  {c.builtin.length > 0 && (
                    <>
                      <div className="text-meta text-fg-muted">
                        {tr('extensions.detail.builtinNote', { names: c.builtin.join(', ') })}
                      </div>
                      <div className="mt-1 flex items-center gap-3">
                        <Switch
                          checked={overrides.includes(c.overrideKey)}
                          disabled={busy}
                          label={t('extensions.detail.override')}
                          onChange={on => {
                            const next = on
                              ? [...new Set([...overrides, c.overrideKey])]
                              : overrides.filter(k => k !== c.overrideKey)
                            void run(() => bridge?.setOptions(pack.key, { overrideBuiltin: next }))
                          }}
                        />
                        <span className="text-meta text-fg-muted">{t('extensions.detail.override')}</span>
                      </div>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      {pack.skills.length > 0 && (
        <>
          <SubTitle>{t('extensions.detail.skills')}</SubTitle>
          <ul className="space-y-2">
            {pack.skills.map(s => (
              <li key={s.index} className="text-ui">
                <div className="font-medium text-fg">{s.name}</div>
                <div className="text-meta text-fg-muted">{s.description}</div>
                <div className="text-meta text-fg-faint">
                  {tr('extensions.detail.skillEngines', { engines: s.engines.join(' / ') })}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {readme && (
        <>
          <SubTitle>{t('extensions.detail.readme')}</SubTitle>
          {/* 按 Markdown 显示；和商店详情同一个渲染（不可信内容：图片只显示替代文字、链接只放行 http / https） */}
          <div data-pack-readme className="max-h-96 overflow-auto rounded-md border border-line-subtle p-4">
            <StoreReadme text={readme} />
          </div>
        </>
      )}
    </div>
  )
}
