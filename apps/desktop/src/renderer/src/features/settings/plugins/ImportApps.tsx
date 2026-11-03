import { useEffect, useState } from 'react'
import type { ExtensionScope, ImportApp, ImportAppScan, ImportItem } from '@pixelsky/protocol'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { Button, cn } from '@/ui'
import { usePluginText } from './text'

// 从本机其他软件导入（docs/ui/extension-remaining-plan.md §H，示意图 docs/ui/import-from-apps-mockup.html）：
// 第 1 步选软件（没找到配置的灰着），第 2 步勾选、选范围。已有同名的默认不勾，勾了导入后自动改名。

const KIND_ORDER: Array<ImportItem['kind']> = ['mcp', 'skill']

export function ImportApps({
  refTarget,
  projectName,
  projectPath,
  onDone,
  onCancel,
}: {
  refTarget: WorkspaceRef | null
  /** 当前项目名；没有项目时只能装到全局 */
  projectName: string | null
  projectPath: string | null
  onDone(note: string): void
  onCancel(): void
}) {
  const t = usePluginText()
  const bridge = window.pixelsky?.extensions
  const [scans, setScans] = useState<ImportAppScan[] | null>(null)
  const [app, setApp] = useState<ImportApp | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [toProject, setToProject] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    bridge
      ?.scanApps(refTarget)
      .then(r => alive && setScans(r))
      .catch(e => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
  }, [])

  const current = scans?.find(s => s.app === app) ?? null
  const choose = (s: ImportAppScan): void => {
    setApp(s.app)
    setPicked(new Set(s.items.filter(i => !i.exists).map(i => i.key)))
    // 来自项目配置的默认装到项目
    setToProject(!!projectName && s.items.some(i => i.project) && s.items.every(i => i.project))
  }
  const toggle = (key: string, on: boolean): void => {
    const next = new Set(picked)
    if (on) next.add(key)
    else next.delete(key)
    setPicked(next)
  }

  const submit = async (): Promise<void> => {
    if (!current || !picked.size || busy) return
    setBusy(true)
    setError(null)
    try {
      const scope: ExtensionScope =
        toProject && projectPath ? { kind: 'project', path: projectPath } : { kind: 'global' }
      const r = await bridge!.importApp(refTarget, current.app, [...picked], scope)
      const note = t('已从 {app} 导入 {n} 项，下一轮生效。')
        .replace('{app}', current.name)
        .replace('{n}', String(r.imported))
      if (!r.failed.length) return onDone(note)
      // 有失败的：面板留着显示原因，只留下没导入成功的勾（列表经 extensions:changed 自己刷新）
      const failed = new Set(r.failed.map(f => f.name))
      setPicked(new Set(current.items.filter(i => picked.has(i.key) && failed.has(i.name)).map(i => i.key)))
      setError(
        [r.imported ? note : '', t('这些没导入：'), ...r.failed.map(f => `${f.name}：${f.error}`)]
          .filter(Boolean)
          .join('\n'),
      )
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-import-apps className="flex flex-col gap-3 rounded-xl border border-line-card bg-surface p-4">
      <div>
        <h4 className="text-section font-semibold">
          {current ? t('从 {app} 导入').replace('{app}', current.name) : t('从其他软件导入')}
        </h4>
        <p className="text-meta text-fg-muted">
          {current ? (
            <button type="button" className="press no-drag text-accent-fg" onClick={() => setApp(null)}>
              ‹ {t('换一个软件')}
            </button>
          ) : (
            t('选一个软件，列出它配置好的 MCP 和技能。只读取，不会改动那个软件的设置。')
          )}
        </p>
      </div>

      {!scans && !error && <p className="text-meta text-fg-muted">{t('加载中…')}</p>}

      {scans && !current && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {scans.map(s => {
            const mcp = s.items.filter(i => i.kind === 'mcp').length
            const skill = s.items.filter(i => i.kind === 'skill').length
            const found = [
              mcp && t('{n} 个 MCP').replace('{n}', String(mcp)),
              skill && t('{n} 个技能').replace('{n}', String(skill)),
            ]
              .filter(Boolean)
              .join('、')
            const off = !s.items.length
            return (
              <button
                key={s.app}
                type="button"
                data-import-app={s.app}
                disabled={off}
                onClick={() => choose(s)}
                className={cn(
                  'press no-drag flex flex-col items-start gap-0.5 rounded-lg border border-line p-3 text-left',
                  off ? 'opacity-50' : 'hover:bg-subtle',
                )}
              >
                <span className="text-list font-medium text-fg">{s.name}</span>
                <span className="text-meta text-fg-muted">
                  {off ? (s.errors.length ? t('读不了配置') : t('没有找到配置')) : t('找到 {x}').replace('{x}', found)}
                </span>
                <span className="text-meta break-all text-fg-faint">{s.places.join('、')}</span>
              </button>
            )
          })}
        </div>
      )}

      {current && (
        <>
          {KIND_ORDER.filter(k => current.items.some(i => i.kind === k)).map(kind => {
            const items = current.items.filter(i => i.kind === kind)
            return (
              <div key={kind} className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-meta text-fg-muted">
                  <span>{kind === 'mcp' ? t('MCP 连接器') : t('技能')}</span>
                  <button
                    type="button"
                    className="press no-drag text-accent-fg"
                    onClick={() => setPicked(new Set([...picked, ...items.map(i => i.key)]))}
                  >
                    {t('全选')}
                  </button>
                </div>
                {items.map(i => (
                  <label
                    key={i.key}
                    data-import-item={i.name}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-subtle',
                      i.exists && 'opacity-70',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(i.key)}
                      onChange={e => toggle(i.key, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-list font-medium text-fg">
                        {i.name}
                        {i.project && <span className="ml-2 text-meta font-normal text-fg-faint">{t('项目')}</span>}
                      </span>
                      <span className="block truncate font-mono text-meta text-fg-muted" title={i.detail}>
                        {i.detail}
                      </span>
                    </span>
                    {i.secrets.map(s => (
                      <span
                        key={s}
                        className="rounded bg-subtle px-1.5 text-meta text-fg-muted"
                        title={t('密钥加密保存，不显示原文')}
                      >
                        {s} ••••
                      </span>
                    ))}
                    {i.needsInput && <span className="text-meta text-warn">{t('导入后要自己填 ${input:…}')}</span>}
                    {i.exists && <span className="text-meta text-warn">{t('已有同名，导入后自动改名')}</span>}
                  </label>
                ))}
              </div>
            )
          })}
          {current.errors.length > 0 && (
            <p className="text-meta whitespace-pre-wrap text-warn">
              {t('有些没读出来：')}
              {'\n' + current.errors.join('\n')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-4 text-list text-fg-secondary">
            <span>{t('装到：')}</span>
            <label className="flex items-center gap-1">
              <input type="radio" checked={!toProject} onChange={() => setToProject(false)} />
              {t('全局')}
            </label>
            <label className={cn('flex items-center gap-1', !projectName && 'opacity-50')}>
              <input type="radio" disabled={!projectName} checked={toProject} onChange={() => setToProject(true)} />
              {t('当前项目')}
              {projectName ? `（${projectName}）` : ''}
            </label>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-meta whitespace-pre-wrap text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-meta text-fg-muted">{t('导入的是副本，之后那个软件里的改动不会同步过来。')}</span>
        <Button variant="ghost" onClick={onCancel}>
          {t('取消')}
        </Button>
        {current && (
          <Button data-import-go variant="primary" disabled={busy || !picked.size} onClick={() => void submit()}>
            {t('导入 {n} 项').replace('{n}', String(picked.size))}
          </Button>
        )}
      </div>
    </div>
  )
}
