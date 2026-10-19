import { useEffect, useRef, useState } from 'react'
import { tr } from '@/i18n/core'
import {
  ExternalLink,
  FolderOpen,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Star,
  Terminal,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  ENGINES,
  type ExtensionEntry,
  type ExtensionKind,
  type ExtensionScope,
  type ExtensionState,
} from '@pixelsky/protocol'
import { Button, cn, IconButton, Popover, Switch } from '@/ui'
import { useSettingsWorkspace } from '../useSettingsWorkspace'
import { usePluginText } from './text'
import { ExtensionForm, type FormTarget } from './ExtensionForm'
import { extensionTemplates } from '@/data/extensionTemplates'
const ICONS: Record<ExtensionKind, LucideIcon> = { plugin: Puzzle, mcp: Plug, cli: Terminal, skill: Star }
const NAMES: Record<ExtensionKind, string> = { plugin: '插件', mcp: '连接器', cli: '命令行', skill: '技能' }
interface Row {
  key: string
  entry: ExtensionEntry
  name: string
  description: string
  component: boolean
}
export function PluginsSection() {
  const t = usePluginText(),
    workspace = useSettingsWorkspace(),
    bridge = window.pixelsky?.extensions
  const [state, setState] = useState<ExtensionState | null>(null),
    [tab, setTab] = useState<ExtensionKind>('plugin'),
    [query, setQuery] = useState(''),
    [group, setGroup] = useState('all'),
    [range, setRange] = useState('global')
  const [form, setForm] = useState<FormTarget | null>(null),
    [detail, setDetail] = useState<string | null>(null),
    [catalog, setCatalog] = useState(false),
    [adding, setAdding] = useState(false),
    [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [error, setError] = useState<string | null>(null),
    [update, setUpdate] = useState<string | null>(null),
    [nativeSkill, setNativeSkill] = useState('')
  const generation = useRef(0)
  const refresh = async (): Promise<void> => {
    const n = ++generation.current
    try {
      const next = await bridge?.state(workspace.ref)
      if (n === generation.current && next) {
        setState(next)
        setError(null)
      }
    } catch (error) {
      if (n === generation.current) setError((error as Error).message)
    }
  }
  useEffect(() => {
    void refresh()
    return bridge?.onChange(() => void refresh())
  }, [workspace.key])
  const scope: ExtensionScope =
    range === 'project' && workspace.path ? { kind: 'project', path: workspace.path } : { kind: 'global' }
  const entries = state?.entries ?? []
  const rows = (kind: ExtensionKind): Row[] =>
    entries.flatMap(e => {
      const own =
        e.kind === kind ? [{ key: e.id, entry: e, name: e.name, description: e.description, component: false }] : []
      return [
        ...own,
        ...(e.kind === 'plugin'
          ? e.components
              .filter(c => c.kind === kind)
              .map((c, i) => ({
                key: e.id + ':' + i,
                entry: e,
                name: e.name + ' / ' + c.name,
                description: c.description,
                component: true,
              }))
          : []),
      ]
    })
  const shown = rows(tab).filter(
    row =>
      (group === 'all' || row.entry.origin === group) &&
      `${row.name} ${row.description}`.toLowerCase().includes(query.toLowerCase()) &&
      (range === 'project' || row.entry.scope.kind === 'global'),
  )
  const selected = entries.find(e => e.id === detail)
  const act = async (fn: () => Promise<unknown>, success = '下一轮生效，当前任务继续运行。'): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      if (success) setMessage(success)
      await refresh()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const open = (target: FormTarget): void => {
    setForm(target)
    setDetail(null)
    setAdding(false)
    setCatalog(false)
    setError(null)
  }
  const select = (row: Row): void => {
    setForm(null)
    setDetail(row.entry.id)
    setConfirm(null)
    setUpdate(null)
    setNativeSkill('')
    if (row.entry.kind === 'skill')
      void bridge
        ?.skillText(row.entry.id, workspace.ref)
        .then(v => setNativeSkill(v.text))
        .catch(error => setError(error.message))
  }
  const switchTab = (kind: ExtensionKind): void => {
    setTab(kind)
    setDetail(null)
    setForm(null)
    setAdding(false)
  }
  const keyTab = (event: React.KeyboardEvent, kind: ExtensionKind): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const kinds = Object.keys(NAMES) as ExtensionKind[],
      next = kinds[(kinds.indexOf(kind) + (event.key === 'ArrowRight' ? 1 : -1) + 4) % 4]
    switchTab(next)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-extension-tab="${next}"]`)?.focus())
  }
  const input =
    'rounded-md border border-line bg-surface px-2.5 py-2 text-list text-fg outline-none focus:border-accent-line'
  return (
    <section data-plugin-config data-setting-title="插件配置" className="flex min-w-0 flex-col gap-4">
      <div>
        <h3 className="text-section font-semibold">{t('插件配置')}</h3>
        <p className="mt-2 text-list text-fg-muted">
          {t('配置插件、MCP、命令行工具与技能，供会话中的 Claude Code 使用。')}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label={t('插件配置')} className="flex max-w-full flex-wrap rounded-lg bg-subtle p-0.5">
          {(Object.keys(NAMES) as ExtensionKind[]).map(kind => {
            const Icon = ICONS[kind]
            return (
              <button
                key={kind}
                role="tab"
                aria-selected={tab === kind}
                tabIndex={tab === kind ? 0 : -1}
                data-extension-tab={kind}
                onKeyDown={e => keyTab(e, kind)}
                onClick={() => switchTab(kind)}
                className={cn(
                  'press flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-list',
                  tab === kind
                    ? 'border-line bg-surface text-fg shadow-sm'
                    : 'border-transparent text-fg-muted hover:text-fg',
                )}
              >
                <Icon size={15} />
                {t(NAMES[kind])}
                <span className="text-meta tabular-nums text-fg-faint">{rows(kind).length}</span>
              </button>
            )
          })}
        </div>
        <Button
          variant="ghost"
          icon={ExternalLink}
          onClick={() => {
            setCatalog(!catalog)
            setForm(null)
          }}
        >
          {t('市场')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('作用范围')}
          className={input}
          value={range}
          onChange={e => {
            setRange(e.target.value)
            setForm(null)
            setDetail(null)
          }}
        >
          <option value="global">{t('全局')}</option>
          <option value="project" disabled={!workspace.ref}>
            {t('当前项目')}
            {workspace.name ? ' · ' + workspace.name : ''}
          </option>
        </select>
        <select aria-label={t('来源')} className={input} value={group} onChange={e => setGroup(e.target.value)}>
          <option value="all">{t('全部')}</option>
          <option value="managed">{t('像素星空管理')}</option>
          <option value="native">{t('智能体自带')}</option>
        </select>
        <label className="flex min-w-36 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2.5">
          <Search size={14} className="shrink-0 text-fg-muted" />
          <input
            aria-label={t('搜索插件…')}
            placeholder={t('搜索插件…')}
            value={query}
            onChange={e => setQuery(e.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent text-list outline-none"
          />
        </label>
        <IconButton icon={RefreshCw} label={t('刷新')} disabled={busy} onClick={() => void refresh()} />
        <div className="relative">
          <Button variant="primary" icon={Plus} onClick={() => setAdding(!adding)}>
            {t('添加')}
          </Button>
          <Popover open={adding} onClose={() => setAdding(false)} align="end" className="flex flex-col gap-1">
            {(tab === 'mcp' || tab === 'cli' || tab === 'skill') && (
              <Button variant="ghost" onClick={() => open({ kind: tab, mode: 'save' })}>
                {t(tab === 'mcp' ? '添加 MCP' : tab === 'cli' ? '添加命令行工具' : '新建技能')}
              </Button>
            )}
            {tab === 'mcp' && (
              <Button variant="ghost" onClick={() => open({ kind: 'mcp', mode: 'json' })}>
                {t('导入 MCP JSON')}
              </Button>
            )}
            {(tab === 'plugin' || tab === 'skill') && (
              <>
                <Button variant="ghost" onClick={() => open({ kind: tab, mode: 'local' })}>
                  {t('导入本地目录')}
                </Button>
                <Button variant="ghost" onClick={() => open({ kind: tab, mode: 'git' })}>
                  {t('从 Git 导入')}
                </Button>
              </>
            )}
          </Popover>
        </div>
      </div>
      {message && (
        <p role="status" className="text-meta text-accent-fg">
          {t(message)}
        </p>
      )}
      {error && (
        <p role="alert" className="text-meta whitespace-pre-wrap text-danger">
          {error}
        </p>
      )}
      {state && !state.secretsPersistent && (
        <p className="text-meta text-warn">{t('无法加密保存，凭据仅本次运行有效。')}</p>
      )}
      {catalog && (
        <div className="flex flex-col gap-3 rounded-xl border border-line-card bg-surface p-4">
          <h4 className="text-section font-semibold">{t('市场')}</h4>
          <p className="text-list text-fg-muted">{t('使用自己的本地目录或 Git 仓库添加插件与技能。')}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => open({ kind: 'plugin', mode: 'local' })}>{t('导入本地目录')}</Button>
            <Button onClick={() => open({ kind: 'plugin', mode: 'git' })}>{t('从 Git 导入')}</Button>
            <a
              className="text-list text-accent-fg underline"
              href="https://code.claude.com/docs/en/plugins/overview"
              target="_blank"
              rel="noreferrer"
            >
              Claude · {t('官方文档')}
            </a>
            <a
              className="text-list text-accent-fg underline"
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noreferrer"
            >
              MCP · {t('官方文档')}
            </a>
          </div>
          {extensionTemplates.map(template => (
            <div
              key={template.name}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-subtle p-3"
            >
              <span className="text-list">
                {template.name} · {t(template.description)}
              </span>
              <div className="flex items-center gap-3">
                <a href={template.docs} target="_blank" rel="noreferrer" className="text-meta text-accent-fg underline">
                  {t('官方文档')}
                </a>
                <Button onClick={() => open({ kind: 'mcp', mode: 'save', preset: template })}>{t('添加 MCP')}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {form && (
        <ExtensionForm
          key={form.entry?.id ?? form.kind + form.mode + (form.preset?.name ?? '')}
          target={form}
          scope={scope}
          refTarget={workspace.ref}
          onDone={() => {
            setForm(null)
            setMessage('下一轮生效，当前任务继续运行。')
            void refresh()
          }}
          onCancel={() => setForm(null)}
        />
      )}
      {selected && (
        <div
          data-extension-detail
          className="flex min-w-0 flex-col gap-3 rounded-xl border border-line-card bg-surface p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="break-words text-section font-semibold">{selected.name}</h4>
              <p className="mt-1 text-list text-fg-muted">{selected.description}</p>
            </div>
            <IconButton icon={X} label={t('关闭详情')} onClick={() => setDetail(null)} />
          </div>
          <p className="break-all text-meta text-fg-muted">
            {t('来源')} · {selected.source.location || t('像素星空管理')}
          </p>
          {selected.origin === 'native' && (
            <p className="text-meta text-fg-muted">
              {t('原生配置请在 Claude Code 中管理；导入副本后可在这里单独配置。')}
            </p>
          )}
          {selected.components.length > 0 && (
            <ul className="flex flex-col gap-1 text-list">
              {selected.components.map((c, i) => (
                <li key={i} className="break-words">
                  {t(NAMES[c.kind])} · {c.name}
                  {c.description ? ' — ' + c.description : ''}
                </li>
              ))}
            </ul>
          )}
          {nativeSkill && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-subtle p-3 text-meta">
              {nativeSkill}
            </pre>
          )}
          {selected.check && (
            <>
              <p className="text-meta text-fg-secondary">{selected.check.message}</p>
              {selected.check.tools && (
                <ul className="max-h-56 overflow-auto text-list">
                  {selected.check.tools.map(tool => (
                    <li className="mb-2 break-words" key={tool.name}>
                      <strong>{tool.name}</strong>
                      <p className="text-meta text-fg-muted">{tool.description}</p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              icon={FolderOpen}
              disabled={busy}
              onClick={() => void act(() => bridge!.reveal(selected.id, workspace.ref), '')}
            >
              {t('查看位置')}
            </Button>
            {selected.origin === 'managed' ? (
              <>
                {selected.kind !== 'plugin' && (
                  <Button disabled={busy} onClick={() => open({ kind: selected.kind, mode: 'save', entry: selected })}>
                    {t('编辑')}
                  </Button>
                )}
                {(selected.kind === 'mcp' || selected.kind === 'cli') && (
                  <Button disabled={busy} onClick={() => void act(() => bridge!.check(selected.id, workspace.ref), '')}>
                    {t(busy ? '操作中…' : selected.kind === 'mcp' ? '检测连接' : '检测程序')}
                  </Button>
                )}
                {['local', 'git'].includes(selected.source.kind) && (
                  <>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await bridge!.update(selected.id, false)
                          setMessage(result.message)
                          setUpdate(result.changed ? selected.id : null)
                        }, '')
                      }
                    >
                      {t('检查更新')}
                    </Button>
                    {update === selected.id && (
                      <Button disabled={busy} onClick={() => void act(() => bridge!.update(selected.id, true))}>
                        {t('应用更新')}
                      </Button>
                    )}
                  </>
                )}
                <Button
                  disabled={busy}
                  className="text-danger"
                  onClick={() => {
                    if (confirm !== selected.id) setConfirm(selected.id)
                    else
                      void act(async () => {
                        await bridge!.remove(selected.id)
                        setDetail(null)
                      })
                  }}
                >
                  {t(confirm === selected.id ? '确认移除' : '移除')}
                </Button>
              </>
            ) : (
              <>
                {(selected.kind === 'plugin' || selected.kind === 'skill') && (
                  <Button onClick={() => open({ kind: selected.kind, mode: 'local', copy: selected })}>
                    {t('导入为应用管理')}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {!state ? (
        <p className="py-8 text-list text-fg-muted">{t('加载中…')}</p>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-line-card p-6 text-center">
          <p className="text-list">{t('暂无内容')}</p>
          <p className="mt-2 text-meta text-fg-muted">{t('添加配置，或选择当前项目查看已有的原生安装。')}</p>
        </div>
      ) : (
        (['managed', 'native'] as const).map(origin => {
          const list = shown.filter(row => row.entry.origin === origin)
          if (!list.length) return null
          return (
            <div key={origin} className="flex flex-col gap-2">
              <h4 className="text-label text-fg-muted">
                {t(origin === 'managed' ? '像素星空管理' : '智能体自带')} · {list.length}
              </h4>
              {list.map(row => {
                const e = row.entry,
                  Icon = ICONS[tab]
                return (
                  <div
                    key={row.key}
                    data-extension-row={row.key}
                    className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-line-card bg-surface p-3"
                  >
                    <Icon size={20} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
                    <button className="min-w-32 flex-1 text-left" onClick={() => select(row)}>
                      <span className="block break-words text-list font-medium">{row.name}</span>
                      <span className="mt-1 block break-words text-meta text-fg-muted">{row.description}</span>
                      <span className="mt-1 block text-meta text-fg-faint">
                        {(e.engines ?? ['claude'])
                          .map(engine => (engine === 'pixel' ? tr('engine.pixel.name') : ENGINES[engine].name))
                          .join(' / ')}{' '}
                        · {t(e.scope.kind === 'global' ? '全局' : '当前项目')}
                        {e.version ? ' · ' + e.version : ''}
                        {!row.component && e.kind === 'plugin' ? ' · ' + e.components.length + ' ' + t('组件') : ''}
                        {row.component ? ' · ' + t('随插件启用') : ''}
                      </span>
                    </button>
                    <span className="text-meta text-fg-muted">
                      {t(
                        !e.enabled
                          ? '已停用'
                          : e.check?.status === 'connected'
                            ? '已连接'
                            : e.check?.status === 'auth'
                              ? '需要登录'
                              : e.check?.status === 'error'
                                ? '检测失败'
                                : e.check?.status === 'ready'
                                  ? '程序可用'
                                  : '已配置',
                      )}
                    </span>
                    {origin === 'managed' && !row.component ? (
                      <Switch
                        checked={e.enabled}
                        disabled={busy}
                        label={`${e.name} · ${t('已启用')}`}
                        onChange={on => void act(() => bridge!.toggle(e.id, on))}
                      />
                    ) : (
                      <span className="text-label text-fg-faint">{t(row.component ? '随插件启用' : '只读')}</span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })
      )}
      {!!state?.warnings.length && (
        <details className="text-meta text-warn">
          <summary>
            {t('配置提示')} · {state.warnings.length}
          </summary>
          <ul>
            {state.warnings.map((warning, i) => (
              <li key={i} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-meta text-fg-faint">{tr('codex.extensionInfo')}</p>
    </section>
  )
}
