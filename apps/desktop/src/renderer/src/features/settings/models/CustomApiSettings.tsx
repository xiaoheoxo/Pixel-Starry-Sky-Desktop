// 设置 › 模型与额度 › 自定义 API（docs/ui/custom-api.md §3.1）：接口列表、添加 / 编辑对话框、测试连接、读取模型、计价参照。
// Key 只进不出：对话框里 Key 留空表示不改，附加请求头已保存的值显示为打码
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CheckCircle2, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { officialModels, officialPrice } from '@pixelsky/protocol'
import { Button, IconButton, Select, Spinner, Switch, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import {
  readProviderModels,
  removeProvider,
  saveProvider,
  testProvider,
  useProviders,
} from '@/features/account/providers'
import type {
  ProviderAuth,
  ProviderInput,
  ProviderModel,
  ProviderProtocol,
  ProviderTemplate,
  ProviderTestResult,
  ProviderView,
} from '../../../../../shared/types/providers'
import { FIELD } from '../engines/parts'
import { ContextWindowInput } from './ContextWindowInput'
import { mergeLatest, shouldConfirmClose, type ProviderDraft } from './providerDraft'
import { useUnsavedCheck } from '../unsavedEdits'

/** 打码的请求头值，和主进程 MASKED_SECRET 一致 */
const MASKED = '••••••••'

const TEMPLATES: Record<Exclude<ProviderTemplate, 'custom'>, { protocol: ProviderProtocol; baseUrl: string }> = {
  anthropic: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  openai: { protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
}

export const protocolLabel = (p: ProviderProtocol): string =>
  p === 'anthropic'
    ? tr('customApi.protocolAnthropic')
    : p === 'chat'
      ? tr('customApi.protocolChat')
      : tr('customApi.protocolResponses')

const PROTOCOLS = [
  {
    value: 'anthropic',
    label: 'customApi.protocolAnthropic',
    path: '/v1/messages',
    desc: 'modelChannels.protocol.anthropic',
  },
  {
    value: 'responses',
    label: 'customApi.protocolResponses',
    path: '/v1/responses',
    desc: 'modelChannels.protocol.responses',
  },
  { value: 'chat', label: 'customApi.protocolChat', path: '/v1/chat/completions', desc: 'modelChannels.protocol.chat' },
] as const satisfies ReadonlyArray<{ value: ProviderProtocol; label: string; path: string; desc: string }>

export function CustomApiSettings() {
  useI18n()
  const providers = useProviders()
  const [editing, setEditing] = useState<ProviderView | 'new' | null>(null)
  const [removing, setRemoving] = useState<ProviderView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <div data-setting-title={tr('settings.models.ModelsSection.customApi')} className="mt-3 scroll-mt-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <p className="text-meta text-fg-muted">{tr('customApi.intro')}</p>
        <Button variant="outline" icon={Plus} onClick={() => setEditing('new')}>
          {tr('customApi.add')}
        </Button>
      </div>
      {(!providers.persistent || providers.warning) && (
        <p className="mb-2 flex items-center gap-1.5 text-meta text-warn">
          <AlertTriangle size={13} className="shrink-0" />
          {providers.warning ? translateMessage(providers.warning) : tr('customApi.notPersistent')}
        </p>
      )}
      {providers.providers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-4 text-meta text-fg-muted">
          {tr('customApi.empty')}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line">
          {providers.providers.map(p => (
            <div
              key={p.id}
              className="flex items-center gap-3 border-t border-line-subtle px-4 py-2.5 first:border-t-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui text-fg">
                  {p.name}
                  <span className="ml-2 text-meta text-fg-muted">
                    {protocolLabel(p.protocol)} · {tr('customApi.modelCount', { n: p.models.length })}
                  </span>
                </span>
                <span className="block truncate text-meta text-fg-muted">
                  <span className="font-mono">{p.baseUrl}</span>
                  {p.insecure && <span className="ml-2 text-warn">{tr('customApi.insecure')}</span>}
                  <span className={cn('ml-2', !p.keyHint && 'text-danger')}>
                    {p.keyHint ? tr('customApi.keyHint', { p0: p.keyHint }) : tr('customApi.noKey')}
                  </span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => setEditing(p)}
                className="shrink-0 rounded-md px-2 py-1 text-meta text-accent-fg hover:bg-hover"
              >
                {tr('customApi.edit')}
              </button>
              <IconButton icon={Trash2} label={tr('customApi.delete')} onClick={() => setRemoving(p)} />
            </div>
          ))}
        </div>
      )}
      {editing && <ProviderDialog provider={editing === 'new' ? null : editing} close={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog
          danger
          title={tr('customApi.deleteTitle', { p0: removing.name })}
          description={tr('customApi.deleteBody')}
          confirmLabel={tr('customApi.delete')}
          cancelLabel={tr('customApi.cancel')}
          busy={busy}
          error={error}
          onCancel={() => {
            setRemoving(null)
            setError(null)
          }}
          onConfirm={() => {
            setBusy(true)
            removeProvider(removing.id)
              .then(() => setRemoving(null))
              .catch(e => setError(translateMessage((e as Error).message)))
              .finally(() => setBusy(false))
          }}
        />
      )}
    </div>
  )
}

/** 附加请求头：每行「名称: 值」 */
export function parseHeaderLines(text: string): { headers: Record<string, string>; bad: string | null } {
  const headers: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const i = line.indexOf(':')
    const name = i > 0 ? line.slice(0, i).trim() : ''
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) return { headers, bad: line }
    headers[name] = line.slice(i + 1).trim()
  }
  return { headers, bad: null }
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-fg-secondary">{label}</span>
      {children}
      {hint && <span className="text-meta text-fg-faint">{hint}</span>}
    </div>
  )
}

/** 已存接口在对话框里的样子（和对话框打开时的初始值一致） */
const draftOf = (p: ProviderView): ProviderDraft => ({
  template: p.template,
  name: p.name,
  protocol: p.protocol,
  baseUrl: p.baseUrl,
  apiKey: '',
  auth: p.auth,
  models: p.models,
  smallModel: p.smallModel,
  fallback: p.modelFallback,
  headersText: p.headerNames.map(n => `${n}: ${MASKED}`).join('\n'),
})

function ProviderDialog({ provider, close }: { provider: ProviderView | null; close(): void }) {
  useI18n()
  const providers = useProviders()
  const [template, setTemplate] = useState<ProviderTemplate>(provider?.template ?? 'anthropic')
  const [name, setName] = useState(provider?.name ?? '')
  const [protocol, setProtocol] = useState<ProviderProtocol>(provider?.protocol ?? 'anthropic')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? TEMPLATES.anthropic.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [auth, setAuth] = useState<ProviderAuth>(provider?.auth ?? 'x-api-key')
  const [models, setModels] = useState<ProviderModel[]>(provider?.models ?? [])
  // 上下文长度填得不对的模型：有的话不能保存
  const [badContext, setBadContext] = useState<ReadonlySet<string>>(new Set())
  // 上下文长度输入框里文字和当前值对不上的模型（打字中就记，Esc 不离开输入框也能拦住）
  const [dirtyContext, setDirtyContext] = useState<ReadonlySet<string>>(new Set())
  const [newModel, setNewModel] = useState('')
  const [smallModel, setSmallModel] = useState<string | null>(provider?.smallModel ?? null)
  const [fallback, setFallback] = useState(provider?.modelFallback ?? true)
  const [headersText, setHeadersText] = useState((provider?.headerNames ?? []).map(n => `${n}: ${MASKED}`).join('\n'))
  const [busy, setBusy] = useState<'save' | 'test' | 'models' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [readCount, setReadCount] = useState<number | null>(null)
  const official = useMemo(() => officialModels(protocol === 'anthropic' ? 'anthropic' : 'openai'), [protocol])
  // 打开时的草稿快照：关闭前和当前内容比，有改动先确认，免得误碰空白处 / Esc 丢掉刚填的 Key 和模型
  const draft: ProviderDraft = {
    template,
    name,
    protocol,
    baseUrl,
    apiKey,
    auth,
    models,
    smallModel,
    fallback,
    headersText,
  }
  const contextInvalid = models.some(m => badContext.has(m.id))
  const initialDraft = useRef(draft)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // 点空白处要 mousedown 和 click 都落在背景上才关，避免在输入框里拖选文字时松手在外面误关
  const backdropDown = useRef(false)
  // 关设置、切分区也问（unsavedEdits.tsx）
  useUnsavedCheck(() =>
    shouldConfirmClose({
      initial: initialDraft.current,
      current: draft,
      newModel,
      contextInvalid,
      contextDirty: models.some(m => dirtyContext.has(m.id)),
    }),
  )
  const requestClose = (): void => {
    // 「新增模型」输入框里还有没添加的字、认不出的上下文长度也算没存的改动
    const contextDirty = models.some(m => dirtyContext.has(m.id))
    if (shouldConfirmClose({ initial: initialDraft.current, current: draft, newModel, contextInvalid, contextDirty }))
      setConfirmDiscard(true)
    else close()
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    document.querySelector<HTMLElement>('[data-provider-dialog] input')?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])

  const pickTemplate = (t: ProviderTemplate): void => {
    setTemplate(t)
    if (t === 'custom') return
    setProtocol(TEMPLATES[t].protocol)
    setBaseUrl(TEMPLATES[t].baseUrl)
    setAuth(TEMPLATES[t].protocol === 'anthropic' ? 'x-api-key' : 'bearer')
    if (!name.trim()) setName(t === 'anthropic' ? 'Anthropic' : 'OpenAI')
  }

  const input = (d: ProviderDraft = draft): ProviderInput | null => {
    const parsed = parseHeaderLines(d.headersText)
    if (parsed.bad) {
      setError(tr('customApi.headersBad', { p0: parsed.bad }))
      return null
    }
    return {
      ...(provider ? { id: provider.id } : {}),
      name: d.name,
      template: d.template,
      protocol: d.protocol,
      baseUrl: d.baseUrl,
      auth: d.auth,
      models: d.models,
      // 只发还在模型列表里的后台小模型
      smallModel:
        d.protocol === 'anthropic' && d.smallModel && d.models.some(m => m.id === d.smallModel) ? d.smallModel : null,
      modelFallback: d.fallback,
      ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
      headers: parsed.headers,
    }
  }

  const run = async (kind: 'save' | 'test' | 'models'): Promise<void> => {
    // 对话框开着时这个接口在别处（另一个设置窗口）改过：保存时这边没动的字段用最新的
    const latest = provider && providers.providers.find(p => p.id === provider.id)
    const data = input(
      kind === 'save' && latest && latest.updatedAt !== provider.updatedAt
        ? mergeLatest(initialDraft.current, draft, draftOf(latest))
        : draft,
    )
    if (!data) return
    setBusy(kind)
    setError(null)
    if (kind === 'test') setResult(null)
    if (kind === 'models') setReadCount(null)
    try {
      if (kind === 'save') {
        await saveProvider(data)
        close()
      } else if (kind === 'test') setResult(await testProvider(data))
      else {
        const ids = await readProviderModels(data)
        setModels(current => [...current, ...ids.filter(id => !current.some(m => m.id === id)).map(id => ({ id }))])
        setReadCount(ids.length)
      }
    } catch (e) {
      setError(translateMessage((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const addModel = (): void => {
    const id = newModel.trim()
    if (id && !models.some(m => m.id === id)) setModels([...models, { id }])
    setNewModel('')
  }
  const patchModel = (id: string, patch: Partial<ProviderModel>): void =>
    setModels(models.map(m => (m.id === id ? { ...m, ...patch } : m)))

  const title = provider ? tr('customApi.titleEdit') : tr('customApi.titleAdd')
  const locked = busy !== null
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-provider-dialog
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onMouseDown={e => {
        backdropDown.current = e.target === e.currentTarget
      }}
      onClick={e => {
        const full = backdropDown.current && e.target === e.currentTarget
        backdropDown.current = false
        if (full && !locked) requestClose()
      }}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape' && !locked) requestClose()
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line-card bg-popover shadow-menu">
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="flex-1 text-ui font-semibold">{title}</h2>
          <IconButton icon={X} label={tr('customApi.close')} disabled={locked} onClick={requestClose} />
        </header>
        <div className="flex min-h-0 flex-col gap-4 overflow-auto p-5">
          {!provider && (
            <Field label={tr('customApi.template')}>
              <div className="flex flex-wrap gap-2">
                {(['anthropic', 'openai', 'custom'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={template === t}
                    onClick={() => pickTemplate(t)}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-ui',
                      template === t
                        ? 'border-line-strong bg-selected text-fg'
                        : 'border-line text-fg-secondary hover:bg-hover',
                    )}
                  >
                    {t === 'anthropic'
                      ? tr('customApi.templateAnthropic')
                      : t === 'openai'
                        ? tr('customApi.templateOpenai')
                        : tr('customApi.templateCustom')}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label={tr('customApi.name')}>
            <input
              className={FIELD}
              value={name}
              maxLength={60}
              placeholder={tr('customApi.namePlaceholder')}
              onChange={e => setName(e.target.value)}
            />
          </Field>
          <Field label={tr('customApi.protocol')} hint={provider ? tr('customApi.protocolLocked') : undefined}>
            {/* 三张单选卡：协议决定交给哪个执行者跑（docs/ui/model-channels.md §2.2） */}
            <div role="radiogroup" aria-label={tr('customApi.protocol')} className="grid gap-2">
              {PROTOCOLS.map(p => {
                const selected = protocol === p.value
                const locked = !!provider || template !== 'custom'
                return (
                  <button
                    key={p.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={locked && !selected}
                    onClick={() => {
                      if (locked || selected) return
                      setProtocol(p.value)
                      setAuth(p.value === 'anthropic' ? 'x-api-key' : 'bearer')
                    }}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left disabled:opacity-45',
                      selected ? 'border-line-strong bg-selected' : 'border-line hover:bg-hover',
                      locked && 'cursor-default',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                        selected ? 'border-accent' : 'border-line-strong',
                      )}
                    >
                      {selected && <span className="size-1.5 rounded-full bg-accent" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="text-ui font-medium text-fg">{tr(p.label)}</span>
                        <span className="font-mono text-label text-fg-faint">{p.path}</span>
                      </span>
                      <span className="block text-meta text-fg-muted">{tr(p.desc)}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label={tr('customApi.baseUrl')} hint={tr('customApi.baseUrlHint')}>
            <input
              className={cn(FIELD, 'font-mono')}
              value={baseUrl}
              spellCheck={false}
              placeholder={protocol === 'anthropic' ? 'https://api.example.com' : 'https://api.example.com/v1'}
              onChange={e => setBaseUrl(e.target.value)}
            />
          </Field>
          <Field
            label={tr('customApi.apiKey')}
            hint={provider?.keyHint ? tr('customApi.apiKeyKeep', { p0: provider.keyHint }) : undefined}
          >
            <input
              className={cn(FIELD, 'font-mono')}
              type="password"
              autoComplete="off"
              value={apiKey}
              spellCheck={false}
              placeholder={tr('customApi.apiKeyPlaceholder')}
              onChange={e => setApiKey(e.target.value)}
            />
          </Field>
          <Field label={tr('customApi.auth')}>
            <Select<ProviderAuth>
              label={tr('customApi.auth')}
              className="w-full max-w-lg"
              value={auth}
              onChange={setAuth}
              options={[
                { value: 'x-api-key', label: tr('customApi.authXApiKey') },
                { value: 'bearer', label: tr('customApi.authBearer') },
              ]}
            />
          </Field>

          <Field label={tr('customApi.models')}>
            <div className="flex max-w-lg gap-2">
              <input
                className={cn(FIELD, 'font-mono')}
                value={newModel}
                spellCheck={false}
                placeholder={tr('customApi.modelPlaceholder')}
                onChange={e => setNewModel(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addModel()
                  }
                }}
              />
              <Button variant="outline" icon={Plus} onClick={addModel} disabled={!newModel.trim()}>
                {tr('customApi.addModel')}
              </Button>
              <Button
                variant="outline"
                icon={RefreshCw}
                disabled={locked}
                onClick={() => void run('models')}
                className="shrink-0"
              >
                {busy === 'models' ? tr('customApi.reading') : tr('customApi.readModels')}
              </Button>
            </div>
            {readCount !== null && (
              <span className="text-meta text-fg-faint">{tr('customApi.readModelsDone', { n: readCount })}</span>
            )}
            {models.length > 0 && (
              <div className="mt-1 overflow-hidden rounded-lg border border-line">
                {models.map(m => {
                  const auto = officialPrice(m.id)
                  return (
                    <div
                      key={m.id}
                      className="flex flex-wrap items-center gap-2 border-t border-line-subtle px-3 py-2 first:border-t-0"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg">{m.id}</span>
                      <ContextWindowInput
                        value={m.contextWindow ?? null}
                        onChange={contextWindow => patchModel(m.id, { contextWindow })}
                        onDraftDirty={dirty =>
                          setDirtyContext(prev => {
                            if (prev.has(m.id) === dirty) return prev
                            const next = new Set(prev)
                            if (dirty) next.add(m.id)
                            else next.delete(m.id)
                            return next
                          })
                        }
                        onValidity={ok =>
                          setBadContext(prev => {
                            const next = new Set(prev)
                            if (ok) next.delete(m.id)
                            else next.add(m.id)
                            return next
                          })
                        }
                      />
                      <Select<string>
                        label={tr('customApi.priceRef')}
                        className="w-52"
                        mono
                        value={m.priceRef ?? ''}
                        onChange={v => patchModel(m.id, { priceRef: v || null })}
                        options={[
                          {
                            value: '',
                            label: auto ? tr('customApi.priceAuto', { p0: auto.model }) : tr('customApi.priceNone'),
                          },
                          ...official.map(o => ({ value: o, label: o })),
                        ]}
                      />
                      <IconButton
                        icon={X}
                        label={tr('customApi.removeModel', { p0: m.id })}
                        onClick={() => {
                          setModels(models.filter(x => x.id !== m.id))
                          // 一并去掉这个模型的「填错 / 改过」标记：再加回同名模型时不会残留，保存一直灰着
                          const without = (prev: ReadonlySet<string>) => new Set([...prev].filter(id => id !== m.id))
                          setBadContext(without)
                          setDirtyContext(without)
                          // 删的是后台小模型：回到「默认」，别让下拉框显示空、保存时还带着删掉的模型
                          if (smallModel === m.id) setSmallModel(null)
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </Field>

          {protocol === 'anthropic' && (
            <Field label={tr('customApi.smallModel')} hint={tr('customApi.smallModelHint')}>
              <Select<string>
                label={tr('customApi.smallModel')}
                className="w-full max-w-lg"
                mono
                value={smallModel ?? ''}
                onChange={v => setSmallModel(v || null)}
                options={[
                  { value: '', label: tr('customApi.smallModelDefault') },
                  ...models.map(m => ({ value: m.id, label: m.id })),
                ]}
              />
            </Field>
          )}
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-meta font-medium text-fg-secondary">{tr('customApi.fallback')}</div>
              <div className="text-meta text-fg-faint">{tr('customApi.fallbackHint')}</div>
            </div>
            <Switch checked={fallback} label={tr('customApi.fallback')} onChange={setFallback} />
          </div>
          <Field label={tr('customApi.headers')} hint={tr('customApi.headersHint')}>
            <textarea
              className={cn(FIELD, 'min-h-16 font-mono text-meta')}
              value={headersText}
              spellCheck={false}
              placeholder="OpenAI-Organization: org-…"
              onChange={e => setHeadersText(e.target.value)}
            />
          </Field>

          {result && (
            <p className={cn('flex items-start gap-1.5 text-meta', result.ok ? 'text-success' : 'text-danger')}>
              {result.ok ? (
                <CheckCircle2 size={14} className="mt-px shrink-0" />
              ) : (
                <AlertTriangle size={14} className="mt-px shrink-0" />
              )}
              {result.ok
                ? result.model
                  ? tr('customApi.testOkModel', { p0: result.model })
                  : tr('customApi.testOk')
                : translateMessage(result.message)}
            </p>
          )}
          {contextInvalid && <p className="text-meta text-danger">{tr('customApi.contextWindowHint')}</p>}
          {error && <p className="text-meta text-danger">{error}</p>}
        </div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-line px-5 py-3">
          <Button variant="outline" disabled={locked} onClick={() => void run('test')}>
            {busy === 'test' ? (
              <span className="inline-flex items-center gap-1.5">
                <Spinner />
                {tr('customApi.testing')}
              </span>
            ) : (
              tr('customApi.test')
            )}
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" disabled={locked} onClick={requestClose}>
            {tr('customApi.cancel')}
          </Button>
          <Button variant="primary" disabled={locked || contextInvalid} onClick={() => void run('save')}>
            {busy === 'save' ? tr('customApi.saving') : tr('customApi.save')}
          </Button>
        </footer>
      </div>
      {confirmDiscard && (
        <ConfirmDialog
          title={tr('customApi.discardTitle')}
          description={tr('customApi.discardBody')}
          confirmLabel={tr('customApi.discard')}
          cancelLabel={tr('customApi.keepEditing')}
          busy={false}
          danger
          onConfirm={close}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>,
    document.body,
  )
}
