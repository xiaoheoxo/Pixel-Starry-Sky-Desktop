import { useEffect, useRef, useState } from 'react'
import { useUnsavedCheck } from '../unsavedEdits'
import {
  ENGINES,
  type ExtensionEntry,
  type ExtensionKind,
  type ExtensionScope,
  type McpConfig,
} from '@pixelsky/protocol'
import { Button } from '@/ui'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { usePluginText } from './text'
import { tr } from '@/i18n/core'
export type FormMode = 'save' | 'local' | 'git' | 'json'
export interface FormTarget {
  kind: ExtensionKind
  mode: FormMode
  entry?: ExtensionEntry
  copy?: ExtensionEntry
  preset?: { name: string; description: string; mcp: McpConfig }
}
const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-list text-fg outline-none focus:border-accent-line'
const lines = (value: Record<string, string> | undefined): string =>
  Object.entries(value ?? {})
    .map(([key, v]) => key + '=' + v)
    .join('\n')
const pairs = (value: string): Record<string, string> =>
  Object.fromEntries(
    value
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => {
        const i = line.indexOf('=')
        if (i < 1) throw new Error('每行使用 KEY=value')
        return [line.slice(0, i).trim(), line.slice(i + 1)]
      }),
  )
export function ExtensionForm({
  target,
  scope,
  refTarget,
  onDone,
  onCancel,
}: {
  target: FormTarget
  scope: ExtensionScope
  refTarget: WorkspaceRef | null
  onDone: () => void
  onCancel: () => void
}) {
  const t = usePluginText(),
    e = target.entry,
    copy = target.copy,
    bridge = window.pixelsky?.extensions
  const [name, setName] = useState(e?.name ?? target.preset?.name ?? ''),
    [description, setDescription] = useState(e?.description ?? target.preset?.description ?? ''),
    [type, setType] = useState<McpConfig['type']>(e?.mcp?.type ?? target.preset?.mcp.type ?? 'stdio')
  const [command, setCommand] = useState(e?.command ?? e?.mcp?.command ?? target.preset?.mcp.command ?? ''),
    [args, setArgs] = useState(
      JSON.stringify(
        e?.args ?? e?.mcp?.args ?? target.preset?.mcp.args ?? (target.kind === 'cli' ? ['--version'] : []),
      ),
    )
  const [env, setEnv] = useState(lines(e?.mcp?.env)),
    [headers, setHeaders] = useState(lines(e?.mcp?.headers)),
    [url, setUrl] = useState(e?.mcp?.url ?? '')
  const [location, setLocation] = useState(copy?.path ?? ''),
    [subdir, setSubdir] = useState(''),
    [json, setJson] = useState(''),
    [source, setSource] = useState(
      '---\nname: my-skill\ndescription: 描述技能的用途\n---\n\n# 执行步骤\n\n在这里填写技能说明。\n',
    )
  const [version, setVersion] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [engines, setEngines] = useState<Array<'claude' | 'codex' | 'pixel'>>(e?.engines ?? ['claude'])
  // 关设置、切分区前比较打开时的样子，有改动先问（unsavedEdits.tsx）；技能正文读进来后以读到的为准
  const snapshot = JSON.stringify({ name, description, type, command, args, env, headers, url, location, subdir, json })
  const origin = useRef({ snapshot, source, engines: engines.join() })
  useUnsavedCheck(
    () =>
      !busy &&
      (snapshot !== origin.current.snapshot ||
        source !== origin.current.source ||
        engines.join() !== origin.current.engines),
  )
  useEffect(() => {
    if (e?.kind === 'skill' && bridge) {
      setBusy(true)
      bridge
        .skillText(e.id, refTarget)
        .then(value => {
          origin.current.source = value.text
          setSource(value.text)
          setVersion(value.version)
        })
        .catch(error => setError(error.message))
        .finally(() => setBusy(false))
    }
  }, [e?.id])
  const field = (label: string, value: string, set: (v: string) => void, multiline = false) => (
    <label className="flex min-w-0 flex-col gap-1.5 text-meta text-fg-secondary">
      <span>{t(label)}</span>
      {multiline ? (
        <textarea
          className={INPUT + ' min-h-24 resize-y font-mono'}
          value={value}
          onChange={event => set(event.target.value)}
        />
      ) : (
        <input className={INPUT} value={value} onChange={event => set(event.target.value)} />
      )}
    </label>
  )
  const choose = async (kind: 'directory' | 'program'): Promise<void> => {
    try {
      const path = await bridge?.choose(kind)
      if (path) (kind === 'directory' ? setLocation : setCommand)(path)
    } catch (error) {
      setError((error as Error).message)
    }
  }
  const submit = async (): Promise<void> => {
    if (!bridge || busy) return
    setError(null)
    setBusy(true)
    try {
      if (target.mode === 'json') await bridge.importMcp(json, scope)
      else if (target.mode === 'local' || target.mode === 'git')
        await bridge.import({
          kind: target.kind as 'plugin' | 'skill',
          source: target.mode === 'git' ? 'git' : 'local',
          location,
          subdir,
          scope,
          name: name || undefined,
          engines,
        })
      else {
        const parsed = JSON.parse(args)
        await bridge.save({
          id: e?.id,
          kind: target.kind,
          name,
          description,
          scope: e?.scope ?? scope,
          // 编辑已有项不传开关：表单开着时列表里的开关可能已单独改过，由主进程沿用已存的值
          ...(e ? {} : { enabled: true }),
          engines,
          ...(target.kind === 'mcp'
            ? {
                mcp:
                  type === 'stdio'
                    ? { type, command, args: parsed, env: pairs(env) }
                    : { type, url, headers: pairs(headers) },
              }
            : {}),
          ...(target.kind === 'cli' ? { command, args: parsed } : {}),
          ...(target.kind === 'skill' ? { text: source, expectedVersion: version } : {}),
        })
      }
      onDone()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      data-extension-form
      className="mt-4 flex min-w-0 flex-col gap-4 rounded-xl border border-line-card bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-section font-semibold">
          {t(
            e
              ? '详情'
              : target.mode === 'json'
                ? '导入 MCP JSON'
                : target.kind === 'plugin'
                  ? '插件目录'
                  : target.kind === 'skill'
                    ? '创建或导入技能'
                    : target.kind === 'cli'
                      ? '添加命令行工具'
                      : '添加 MCP',
          )}
        </h4>
        <span className="text-meta text-fg-muted">
          {t((e?.scope ?? scope).kind === 'global' ? '全局' : '当前项目')}
        </span>
      </div>
      {target.mode === 'json' ? (
        field('JSON 配置', json, setJson, true)
      ) : (
        <>
          {field(target.mode === 'save' ? '名称' : '副本名称（可选，冲突时改名）', name, setName)}
          {target.mode === 'local' || target.mode === 'git' ? (
            <>
              {field('来源目录或 Git 仓库', location, setLocation)}
              {target.mode === 'local' && <Button onClick={() => void choose('directory')}>{t('选择目录')}</Button>}
              {field('仓库内子目录（可选）', subdir, setSubdir)}
            </>
          ) : (
            <>
              {field('描述', description, setDescription)}
              {target.kind === 'skill' ? (
                field('技能正文', source, setSource, true)
              ) : (
                <>
                  {target.kind === 'mcp' && (
                    <label className="flex flex-col gap-1.5 text-meta">
                      <span>{t('传输方式')}</span>
                      <select
                        className={INPUT}
                        value={type}
                        onChange={event => setType(event.target.value as McpConfig['type'])}
                      >
                        <option value="stdio">stdio</option>
                        <option value="http">HTTP</option>
                        <option value="sse">SSE</option>
                      </select>
                    </label>
                  )}
                  {target.kind === 'cli' || type === 'stdio' ? (
                    <>
                      {field('命令或程序路径', command, setCommand)}
                      <Button onClick={() => void choose('program')}>{t('选择程序')}</Button>
                      {field('参数（JSON 数组）', args, setArgs)}
                      {target.kind === 'mcp' && field('环境变量（每行 KEY=value）', env, setEnv, true)}
                    </>
                  ) : (
                    <>
                      {field('服务地址', url, setUrl)}
                      {field('请求头（每行 KEY=value）', headers, setHeaders, true)}
                    </>
                  )}
                  {target.kind === 'mcp' && (
                    <p className="text-meta text-fg-muted">{t('保留遮掩值表示沿用已有凭据；清空某行会移除该项。')}</p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {target.kind !== 'plugin' && target.mode !== 'json' && (
        <fieldset className="flex flex-wrap items-center gap-3 text-meta text-fg-secondary">
          <legend className="mb-2">{tr('codex.targets')}</legend>
          {(['claude', 'codex', 'pixel'] as const).map(engine => (
            <label key={engine} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={engines.includes(engine)}
                onChange={event =>
                  setEngines(current =>
                    event.target.checked
                      ? [...current, engine]
                      : current.length > 1
                        ? current.filter(e => e !== engine)
                        : current,
                  )
                }
              />
              {engine === 'pixel' ? tr('engine.pixel.name') : ENGINES[engine].name}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-meta whitespace-pre-wrap text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void submit()}>
          {t(busy ? '操作中…' : target.mode === 'save' ? '保存' : '导入')}
        </Button>
        <Button disabled={busy} onClick={onCancel}>
          {t('取消')}
        </Button>
      </div>
    </section>
  )
}
