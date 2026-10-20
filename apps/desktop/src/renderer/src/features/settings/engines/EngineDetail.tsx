import { translateMessage } from '../../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 设置 › 本机引擎 › 一个引擎的详情（docs/ui/engine-settings-redesign.md §3.2、§5，参考 Mirasim 设置 › 智能体 › Claude Code）：
// 头部（版本、路径、重新检测、检查更新、设为默认）→ 新会话默认值 → 对话 → 上下文 → 高级。
// 改了立刻保存。除「新会话默认值」外，对已开始的会话也生效：下一条消息开始前用新设置重启引擎进程并接上原对话。
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, CircleCheck, Download, RefreshCw } from 'lucide-react'
import {
  AUTO_COMPACT_PCTS,
  EFFORT_PANEL_FACTORY,
  EFFORT_PANEL_KEYS,
  type Effort,
  type EngineCatalog,
  type EngineConfigPatch,
  type EngineLocalConfig,
  type PermissionMode,
} from '@pixelsky/protocol'
import { Button, CopyButton, EngineIcon, Select, Switch, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useUnmountFlush } from '@/ui/useUnmountFlush'
import { platformModels, usePlatform } from '@/features/account/platform'
import { EFFORT_LABEL, PERMISSION_INFO, bridge, isLive, redetectEngines } from '@/features/engine'
import { envLines, parseEnvLines } from './envLines'
import { migrateEnv, providerEnvKeys } from './migrateEnv'
import { LaunchCard } from './LaunchCard'
import { splitInstallCommand } from './installCommand'
import { DefaultBadge, ENGINE_INTRO, ENGINE_STATUS, FIELD } from './parts'
import {
  canInstall,
  canUpdate,
  hasNewer,
  installEngine,
  outcomeTitle,
  updateEngine,
  useEngineUpdate,
  type UpdateOutcome,
} from './engineUpdate'
import { JobProgress } from './JobProgress'
import { ContextWindowInput } from '../models/ContextWindowInput'
import { useEngineCatalog } from '@/features/engine/catalog'
import { demo, isDemo } from '@/data/demo'
import type { EngineLite } from '@/data/types'

export function EngineDetail({
  engine: e,
  config,
  isDefault,
  onSave,
  onSetDefault,
  onBack,
  onOpenModels,
}: {
  engine: EngineLite
  config: EngineLocalConfig
  isDefault: boolean
  onSave: (patch: EngineConfigPatch) => Promise<void>
  onSetDefault: () => Promise<void>
  onBack: () => void
  onOpenModels?: () => void
}) {
  useI18n()
  const [error, setError] = useState<string | null>(null)
  const run = (patch: EngineConfigPatch): void => {
    setError(null)
    onSave(patch).catch((err: unknown) => setError((err as Error).message))
  }
  const d = config.defaults
  // 新会话默认改成完全放行：影响以后所有新任务，先弹窗确认（docs/ui/full-access-confirm.md P4）
  const [confirmFull, setConfirmFull] = useState(false)

  return (
    <section>
      {confirmFull && (
        <ConfirmDialog
          title={tr('fullAccess.default.title')}
          description={
            <>
              <p>{tr('fullAccess.default.body', { p0: e.name })}</p>
              <p className="mt-1.5 text-fg-muted">{tr('fullAccess.default.note')}</p>
            </>
          }
          confirmLabel={tr('fullAccess.default.ok')}
          cancelLabel={tr('fullAccess.confirm.cancel')}
          warn
          busy={false}
          onCancel={() => setConfirmFull(false)}
          onConfirm={() => {
            setConfirmFull(false)
            run({ defaults: { permissionMode: 'full' } })
          }}
        />
      )}
      <button
        type="button"
        onClick={onBack}
        className="-ml-1 mb-4 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-meta text-fg-muted hover:text-fg"
      >
        <ChevronLeft size={14} />
        {tr('settings.engines.EngineDetail.allEngines')}{' '}
      </button>

      <Header engine={e} isDefault={isDefault} onSetDefault={onSetDefault} />
      <p className="mt-4 mb-2 rounded-lg bg-subtle px-3 py-2 text-meta text-fg-muted">
        {tr('settings.engines.EngineDetail.changesTakeEffectImmediately', { p0: e.name })}
      </p>

      {error && (
        <p role="alert" className="mt-3 text-meta text-danger">
          {translateMessage(error)}
        </p>
      )}

      {/* 引擎运行时报的配置类警告（docs/ui/ai-commit-codex-warnings-history.md §3）：不进对话，放在这里 */}
      {e.configWarnings?.length ? (
        <Group title={tr('engineConfigWarnings.title')} note={tr('engineConfigWarnings.note', { p0: e.name })}>
          {e.configWarnings.map(text => (
            <p
              key={text}
              className="-mx-2 border-t border-line-subtle px-2 py-3 text-meta whitespace-pre-wrap break-words text-fg-secondary first:border-t-0"
            >
              {text}
            </p>
          ))}
        </Group>
      ) : null}

      <Group
        title={tr('settings.engines.EngineDetail.newConversationDefaults')}
        note={tr(config.rememberChoices ? 'engineDefaults.noteRemember' : 'engineDefaults.note')}
      >
        <Row
          title={tr('session.Composer.reasoningEffort')}
          description={tr('settings.engines.EngineDetail.higherEffortSpendsMore')}
          control={
            <Select
              label={tr('settings.engines.EngineDetail.defaultReasoningEffort')}
              value={d.effort ?? ''}
              onChange={v => run({ defaults: { effort: (v || null) as Effort | null } })}
              options={[
                { value: '', label: tr('settings.engines.EngineDetail.default', { p0: e.name }) },
                ...e.caps.efforts.map(x => ({ value: x, label: EFFORT_LABEL[x] })),
              ]}
            />
          }
        />
        <Row
          title={tr('settings.engines.EngineDetail.permissions')}
          description={PERMISSION_INFO[d.permissionMode].hint}
          control={
            <Select
              label={tr('settings.engines.EngineDetail.defaultPermissions')}
              value={d.permissionMode}
              onChange={v =>
                v === 'full' && d.permissionMode !== 'full'
                  ? setConfirmFull(true)
                  : run({ defaults: { permissionMode: v as PermissionMode } })
              }
              options={e.caps.permissionModes.map(m => ({ value: m, label: PERMISSION_INFO[m].label }))}
            />
          }
        />
        <Row
          title={tr('session.ModelSourceMenu.model')}
          description={tr('settings.engines.EngineDetail.defaultModelsForPlatform')}
          control={
            onOpenModels && (
              <button
                type="button"
                onClick={onOpenModels}
                className="shrink-0 text-meta text-accent-fg hover:underline"
              >
                {tr('settings.engines.EngineDetail.manageModels')}{' '}
              </button>
            )
          }
        />
        {e.caps.fast && (
          <Row
            title={tr('session.ComposerMenus.fastMode')}
            description={tr('settings.engines.EngineDetail.fasterRepliesWithHigher')}
            control={
              <Switch
                checked={d.fast}
                label={tr('settings.engines.EngineDetail.enableFastModeBy')}
                onChange={on => run({ defaults: { fast: on } })}
              />
            }
          />
        )}
        {e.caps.ultracode && (
          <Row
            title="Ultracode"
            description={tr('settings.engines.EngineDetail.orchestrateMultipleSubagentsFor')}
            control={
              <Switch
                checked={d.ultracode}
                tone="ultracode"
                label={tr('settings.engines.EngineDetail.enableUltracodeByDefault')}
                onChange={on => run({ defaults: { ultracode: on } })}
              />
            }
          />
        )}
        {e.caps.thinkingSummaries && (
          <Row
            title={tr('settings.engines.EngineDetail.showThinking')}
            description={tr('settings.engines.EngineDetail.onRequestAndShow')}
            control={
              <Switch
                checked={d.thinkingSummaries}
                label={tr('settings.engines.EngineDetail.showThinkingByDefault')}
                onChange={on => run({ defaults: { thinkingSummaries: on } })}
              />
            }
          />
        )}
        <Row
          title={tr('engineDefaults.remember')}
          description={tr('engineDefaults.rememberDesc')}
          control={
            <Switch
              checked={config.rememberChoices}
              label={tr('engineDefaults.remember')}
              onChange={on => run({ rememberChoices: on })}
            />
          }
        />
        <Row
          title={tr('engineDefaults.factory')}
          description={tr('engineDefaults.factoryHint')}
          control={
            <Button
              variant="outline"
              className="h-7 px-2.5 text-meta"
              disabled={EFFORT_PANEL_KEYS.every(k => d[k] === EFFORT_PANEL_FACTORY[k])}
              onClick={() => run({ defaults: { ...EFFORT_PANEL_FACTORY } })}
            >
              {tr('engineDefaults.factory')}
            </Button>
          }
        />
      </Group>

      {e.caps.launchSettings && (
        <Group title={tr('settings.engines.EngineDetail.conversation')}>
          <OutputStyleRow engine={e} value={config.outputStyle} onChange={outputStyle => run({ outputStyle })} />
          <Row
            title={tr('settings.engines.EngineDetail.allowQuestionsDuringTasks')}
            description={tr('settings.engines.EngineDetail.onPauseToAsk')}
            control={
              <Switch
                checked={config.askQuestions}
                label={tr('settings.engines.EngineDetail.allowQuestionsDuringTasks')}
                onChange={on => run({ askQuestions: on })}
              />
            }
          />
        </Group>
      )}

      {!e.caps.launchSettings && <p className="mt-4 text-meta text-fg-muted">{tr('codex.nativeSettings')}</p>}
      {/* 上下文（GitHub #20）：Codex 也有自动压缩和模型窗口；压缩用的模型只有 Claude Code 能换 */}
      <Group title={tr('session.ContextWindowButton.context2')}>
        <Row
          title={tr('settings.engines.EngineDetail.autocompactThreshold')}
          description={tr('settings.engines.EngineDetail.automaticallyCompactAtThis')}
          hint={e.id === 'codex' ? tr('contextWindow.codexCompactHint') : undefined}
          control={
            <Select
              label={tr('settings.engines.EngineDetail.autocompactThreshold')}
              value={config.autoCompactPct === null ? '' : String(config.autoCompactPct)}
              onChange={v => run({ autoCompactPct: v ? Number(v) : null })}
              options={[
                {
                  value: '',
                  get label() {
                    return tr('settings.engines.EngineDetail.defaultBuiltInThreshold')
                  },
                },
                ...AUTO_COMPACT_PCTS.map(p => ({
                  value: String(p),
                  label: tr('settings.engines.EngineDetail.atUsage', { p0: p }),
                })),
              ]}
            />
          }
        />
        {e.caps.launchSettings && (
          <CompactModelRow engine={e} value={config.compactModel} onChange={compactModel => run({ compactModel })} />
        )}
        <ModelWindowsRow
          engine={e}
          windows={config.contextWindows.self}
          onChange={(model, value) => run({ contextWindows: { self: { [model]: value } } })}
        />
      </Group>

      <Group title={tr('settings.engines.EngineDetail.advanced')}>
        <Row
          title={tr('settings.engines.EngineDetail.showInEngineMenu')}
          description={tr('settings.engines.EngineDetail.hideThisEngineFrom')}
          hint={isDefault ? tr('settings.engines.EngineDetail.defaultEngineCannotBe') : undefined}
          control={
            <Switch
              checked={!config.hidden}
              disabled={isDefault}
              label={tr('settings.engines.EngineDetail.showInEngineMenu')}
              onChange={on => run({ hidden: !on })}
            />
          }
        />
        <LaunchRows engine={e} config={config} onSave={onSave} />
      </Group>
    </section>
  )
}

/** 头部：图标、名字、默认角标、版本 · 路径、介绍；右侧设为默认、重新检测、检查更新 */
function Header({
  engine: e,
  isDefault,
  onSetDefault,
}: {
  engine: EngineLite
  isDefault: boolean
  onSetDefault: () => Promise<void>
}) {
  useI18n()
  // 和列表那一行共用（engineUpdate.ts）：在列表点了「更新」，进详情也看得到进度和结果
  const { updating, action, job, result } = useEngineUpdate(e.id)
  const [redetecting, setRedetecting] = useState(false)
  const newer = hasNewer(e)
  const installable = canInstall(e)
  const redetect = async (): Promise<void> => {
    if (!isLive) return
    setRedetecting(true)
    try {
      await redetectEngines()
    } finally {
      setRedetecting(false)
    }
  }

  const ready = e.status === 'ready'
  return (
    <div>
      <div data-setting-title={e.name} className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-line bg-subtle">
          <EngineIcon engine={e.id} size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-section font-semibold text-fg">{e.name}</h3>
            {isDefault && <DefaultBadge />}
            {ready ? (
              <span className="inline-flex items-center gap-1 text-meta text-success">
                <CircleCheck size={12} />
                {tr('settings.editor.EditorSection.available')}{' '}
              </span>
            ) : (
              <span className="text-meta text-warn">{ENGINE_STATUS[e.status] ?? e.status}</span>
            )}
          </div>
          <div className="selectable mt-0.5 truncate font-mono text-meta text-fg-muted" title={e.path ?? undefined}>
            {[e.version ? `v${e.version}` : null, e.path].filter(Boolean).join(' · ') ||
              tr('settings.engines.EngineDetail.executableNotDetected')}
          </div>
          <p className="mt-1 text-meta text-fg-secondary">{ENGINE_INTRO[e.id]}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {!isDefault && ready && (
            <Button variant="outline" className="h-8 px-3 text-meta" onClick={() => void onSetDefault()}>
              {tr('session.ModelSourceMenu.setAsDefault')}{' '}
            </Button>
          )}
          <Button
            variant="outline"
            icon={RefreshCw}
            className="h-8 px-3 text-meta"
            disabled={redetecting || !isLive}
            onClick={() => void redetect()}
          >
            {redetecting ? tr('settings.engines.EngineDetail.detecting') : tr('session.SourceHintBar.detectAgain')}
          </Button>
          {(installable || (updating && action === 'install')) && (
            <Button
              variant="primary"
              icon={Download}
              className="h-8 px-3 text-meta"
              disabled={updating}
              title={tr('engineJob.installTitle', { p0: e.name })}
              onClick={() => void installEngine(e)}
            >
              {updating ? tr('engineJob.installing') : tr('engineJob.install')}
            </Button>
          )}
          {canUpdate(e) && (
            <span data-setting-title="检查更新" className="rounded-md">
              <Button
                variant={newer ? 'primary' : 'outline'}
                icon={Download}
                className="h-8 px-3 text-meta"
                disabled={updating}
                onClick={() => void updateEngine(e)}
              >
                {updating
                  ? newer
                    ? tr('settings.engines.engineUpdate.updatingShort')
                    : tr('settings.engines.EngineDetail.checkingForUpdates')
                  : newer
                    ? tr('settings.engines.engineUpdate.updateTo', { p0: e.latestVersion })
                    : tr('settings.AboutSection.checkForUpdates')}
              </Button>
            </span>
          )}
        </div>
      </div>
      {!ready && e.message && !(updating && action === 'install') && (
        <div className="selectable mt-3 rounded-lg border border-line px-3 py-2 text-meta">
          <InstallMessage message={translateMessage(e.message)} />
          {installable && (
            <p className="mt-1 text-fg-secondary">
              {tr(
                e.id === 'claude'
                  ? 'engineJob.installHintClaude'
                  : e.id === 'codex'
                    ? 'engineJob.installHintCodex'
                    : 'engineJob.installHint',
              )}
            </p>
          )}
        </div>
      )}
      {newer && !updating && !result && (
        <p className="mt-3 text-meta text-fg-secondary">
          {tr('settings.engines.engineUpdate.newVersionAvailable', { p0: e.latestVersion, p1: e.version })}
        </p>
      )}
      {updating && job && <JobProgress job={job} />}
      {updating && action === 'update' && (
        <p className="mt-2 text-meta text-fg-muted">
          {e.id === 'codex'
            ? tr('settings.engines.engineUpdate.runningNpmUpdate')
            : tr('settings.engines.EngineDetail.runningClaudeUpdateThis')}
        </p>
      )}
      {result && <UpdateResult result={result} />}
    </div>
  )
}

function UpdateResult({ result }: { result: UpdateOutcome }) {
  useI18n()
  if ('error' in result) {
    return (
      <p role="alert" className="mt-3 rounded-lg border border-line px-3 py-2 text-meta text-danger">
        {translateMessage(result.error)}
      </p>
    )
  }
  const changed = result.version && result.before && result.version !== result.before
  const title = outcomeTitle(result)
  return (
    <div role="status" className="mt-3 rounded-lg border border-line px-3 py-2">
      <p className={cn('text-meta', result.ok ? 'text-fg' : 'text-danger')}>{title}</p>
      {result.output && (
        <pre className="selectable mt-1.5 overflow-x-auto font-mono text-label whitespace-pre-wrap text-fg-muted">
          {result.output}
        </pre>
      )}
      {result.ok && changed && (
        <p className="mt-1.5 text-label text-fg-faint">
          {tr('settings.engines.EngineDetail.newConversationsUseUpdated')}
        </p>
      )}
    </div>
  )
}

/** 输出风格：列表从引擎的初始化握手里读（不发消息），读不到时只显示「跟随」和已经选的那个 */
function OutputStyleRow({
  engine: e,
  value,
  onChange,
}: {
  engine: EngineLite
  value: string | null
  onChange: (v: string | null) => void
}) {
  useI18n()
  const [catalog, setCatalog] = useState<EngineCatalog | null>(isDemo ? demo().engines.catalog : null)
  const [loading, setLoading] = useState(isLive)
  useEffect(() => {
    if (!bridge) return
    let alive = true
    void bridge
      .catalog(e.id)
      .then(c => alive && setCatalog(c))
      .catch(() => alive && setCatalog({ outputStyles: [], currentOutputStyle: null }))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [e.id])

  const styles = catalog?.outputStyles ?? []
  const follow = catalog?.currentOutputStyle
    ? tr('settings.engines.EngineDetail.useEngineSettings', { p0: catalog.currentOutputStyle })
    : tr('settings.engines.EngineDetail.useEngineSettings2')
  return (
    <Row
      title={tr('settings.engines.EngineDetail.outputStyle')}
      description={tr('settings.engines.EngineDetail.changesWritingStyleNot', { p0: e.name })}
      hint={
        !loading && styles.length === 0 ? tr('settings.engines.EngineDetail.couldNotLoadS', { p0: e.name }) : undefined
      }
      control={
        <Select
          label={tr('settings.engines.EngineDetail.outputStyle')}
          disabled={loading}
          value={value ?? ''}
          onChange={v => onChange(v || null)}
          options={[
            { value: '', label: loading ? tr('settings.engines.EngineDetail.loading') : follow },
            ...(value && !styles.includes(value)
              ? [{ value, label: tr('settings.engines.EngineDetail.notFound', { p0: value }) }]
              : []),
            ...styles.map(x => ({ value: x, label: x })),
          ]}
        />
      }
    />
  )
}

/**
 * 用自己账号时每个模型的上下文窗口（GitHub #20，docs/ui/context-settings-branch-switch.md §2.2）：
 * 列出引擎自己报的模型，再加上填过、但现在列表里没有的（好清掉）
 */
function ModelWindowsRow({
  engine: e,
  windows,
  onChange,
}: {
  engine: EngineLite
  windows: Record<string, number>
  onChange: (model: string, value: number | null) => void
}) {
  useI18n()
  const live = useEngineCatalog(e.id)
  const catalog = isLive ? live : isDemo && e.id === 'claude' ? demo().engines.catalog : null
  const listed = (catalog?.models ?? []).map(m => ({ id: m.id, label: m.label }))
  const extra = Object.keys(windows)
    .filter(id => !listed.some(m => m.id === id))
    .map(id => ({ id, label: id }))
  const models = [...listed, ...extra]
  return (
    <Row title={tr('contextWindow.engineTitle')} description={tr('contextWindow.engineHint', { engine: e.name })}>
      {models.length === 0 ? (
        <p className="text-meta text-fg-faint">{tr('contextWindow.noModels', { engine: e.name })}</p>
      ) : (
        <div data-model-windows className="overflow-hidden rounded-lg border border-line-subtle">
          {models.map(m => (
            <div
              key={m.id}
              className="flex items-center gap-3 border-t border-line-subtle px-3 py-1.5 first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate text-meta text-fg">
                {m.label}
                {m.label !== m.id && <span className="ml-2 font-mono text-fg-faint">{m.id}</span>}
              </span>
              <ContextWindowInput
                value={windows[m.id] ?? null}
                label={tr('contextWindow.of', { model: m.id })}
                commit="blur"
                onChange={value => onChange(m.id, value)}
              />
            </div>
          ))}
        </div>
      )}
    </Row>
  )
}

/** 压缩上下文用的模型（plan-search-panes-compact.md §3）：只对平台会话生效 */
function CompactModelRow({
  engine: e,
  value,
  onChange,
}: {
  engine: EngineLite
  value: string | null
  onChange: (v: string | null) => void
}) {
  useI18n()
  const platform = usePlatform()
  const models = platformModels(platform.groups)
  return (
    <Row
      title={tr('settings.engines.EngineDetail.contextCompactionModel')}
      description={tr('settings.engines.EngineDetail.platformConversationsOnlyUse', { p0: e.name })}
      control={
        <Select
          label={tr('settings.engines.EngineDetail.contextCompactionModel2', { p0: e.name })}
          mono
          value={value ?? ''}
          onChange={v => onChange(v || null)}
          options={[
            {
              value: '',
              get label() {
                return tr('settings.engines.EngineDetail.useConversationModel')
              },
            },
            ...(value && !models.includes(value) ? [{ value, label: value }] : []),
            ...models.map(m => ({ value: m, label: m })),
          ]}
        />
      }
    />
  )
}

/** 启动方式：「启动」卡片（替换的命令和追加的参数，docs/ui/engine-launch.md）、追加的环境变量（失焦保存） */
function LaunchRows({
  engine: e,
  config,
  onSave,
}: {
  engine: EngineLite
  config: EngineLocalConfig
  onSave: (patch: EngineConfigPatch) => Promise<void>
}) {
  useI18n()
  const [env, setEnv] = useState(envLines(config.env))
  const [error, setError] = useState<string | null>(null)
  const [migrating, setMigrating] = useState(false)
  const [migrated, setMigrated] = useState<string | null>(null)
  // 只在已存的内容真变了、且输入框没被改过时才跟着换：引擎配置每次广播都是新对象，按对象比会把正在写 / 没存进去（格式不对）的内容冲掉
  const saved = envLines(config.env)
  const shown = useRef(saved)
  useEffect(() => {
    // 输入框和上次已存的一致（写法不同但解析结果相同也算）才换成新的
    setEnv(current => {
      const parsed = parseEnvLines(current)
      return !parsed.bad && envLines(parsed.env) === shown.current ? saved : current
    })
    shown.current = saved
  }, [saved])
  const legacy = providerEnvKeys(config.env)
  const migrate = (): void => {
    setMigrating(true)
    setError(null)
    migrateEnv(e.id, config.env, onSave)
      .then(view => setMigrated(view?.name ?? null))
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setMigrating(false))
  }

  const save = (patch: EngineConfigPatch): void => {
    setError(null)
    onSave(patch).catch((err: unknown) => setError((err as Error).message))
  }
  const saveEnv = (): void => {
    unsavedEnv.current = false
    const { env: parsed, bad } = parseEnvLines(env)
    if (bad) {
      setError(tr('settings.engines.EngineDetail.thisLineIsNot', { p0: bad }))
      return
    }
    if (envLines(parsed) !== envLines(config.env)) save({ env: parsed })
  }
  // 改了还没离开输入框就关掉设置 / 切走：补存一次（格式不对的照旧不存）
  const unsavedEnv = useUnmountFlush(saveEnv)

  return (
    <>
      <LaunchCard engine={e} config={config} onSave={onSave} />
      <Row
        title={tr('settings.engines.EngineDetail.environmentVariables')}
        description={tr('settings.engines.EngineDetail.oneKeyValuePer')}
      >
        <textarea
          value={env}
          onChange={ev => {
            setEnv(ev.target.value)
            unsavedEnv.current = true
          }}
          onBlur={saveEnv}
          rows={4}
          placeholder="HTTPS_PROXY=http://127.0.0.1:7890"
          aria-label={tr('settings.engines.EngineDetail.environmentVariables')}
          className={cn(FIELD, 'resize-y font-mono text-meta')}
          spellCheck={false}
        />
      </Row>
      {legacy.length > 0 && (
        <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-meta text-fg-secondary">
          <span className="min-w-0 flex-1">
            {tr('customApi.envBanner')}
            <span className="ml-1 font-mono text-fg-muted">{legacy.join(', ')}</span>
          </span>
          <Button variant="outline" disabled={migrating} onClick={migrate}>
            {migrating ? tr('customApi.envMigrating') : tr('customApi.envMigrate')}
          </Button>
        </div>
      )}
      {migrated && (
        <p role="status" className="-mt-1 text-meta text-success">
          {tr('customApi.envMigrated', { p0: migrated })}
        </p>
      )}
      {error && (
        <p role="alert" className="-mt-2 text-meta text-danger">
          {translateMessage(error)}
        </p>
      )}
    </>
  )
}

/** 一组设置：小标题 + 带边框的卡片（参考 Mirasim 设置 › 智能体） */
function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  useI18n()
  return (
    <div className="mt-7">
      <h4 data-setting-title={title} className="mb-2 rounded-md text-label font-medium text-fg-muted">
        {title}
      </h4>
      {note && <p className="-mt-1 mb-2 text-meta text-fg-faint">{note}</p>}
      <div className="rounded-xl border border-line bg-surface/60 px-4">{children}</div>
    </div>
  )
}

/** 卡片里的一行：左边标题和说明，右边控件；有 children 时控件放在下面（输入框） */
function Row({
  title,
  description,
  hint,
  control,
  children,
}: {
  title: string
  description: string
  hint?: string
  control?: ReactNode
  children?: ReactNode
}) {
  useI18n()
  return (
    <div
      data-setting-title={title}
      className="-mx-2 rounded-md border-t border-line-subtle px-2 py-3.5 first:border-t-0"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-ui font-medium text-fg">{title}</div>
          <p className="mt-0.5 text-meta text-fg-muted">{description}</p>
          {hint && <p className="mt-1 text-meta text-fg-faint">{hint}</p>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  )
}

/** 「没找到」的提示：整段能选中复制；里面的安装命令单独成一行等宽字，带复制按钮 */
function InstallMessage({ message }: { message: string }) {
  const { before, command, after } = splitInstallCommand(message)
  if (!command) return <p className="whitespace-pre-line text-warn">{message}</p>
  return (
    <>
      <p className="whitespace-pre-line text-warn">{before}</p>
      <div className="mt-1.5 flex items-center gap-1 rounded-md bg-subtle py-1 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 font-mono text-meta break-all text-fg">{command}</code>
        <CopyButton text={command} iconOnly label={tr('engineJob.copyCommand')} />
      </div>
      {after && <p className="mt-1 whitespace-pre-line text-warn">{after}</p>}
    </>
  )
}
