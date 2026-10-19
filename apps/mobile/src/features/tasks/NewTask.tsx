// 新建任务：选项目、引擎，写第一句话（可以带图片）。引擎默认用电脑上设的那个（docs/mobile-remote.md §17 第 7 项）；
// 权限模式、模型、强度默认用电脑上的设置，也可以在「模式」里先选好（C2，§21.5；完全放行只能在电脑上开）。线路总是用电脑上的。
import { useRef, useState } from 'react'
import { Check, ChevronRight, Folder, Send } from 'lucide-react'
import {
  ENGINES,
  ENGINE_ORDER,
  type Effort,
  type EngineId,
  type PermissionMode,
  type SessionRecord,
} from '@pixelsky/protocol'
import type { Pairing } from '@/connection'
import { useCatalog, useDefaultEngine, useDesktop } from '@/data/hooks'
import { effortOptions, modeChip, modelOptions, permissionOptions, widens } from '@/data/mode'
import { imageDataUrl, usePendingImages } from '@/data/images'
import { attemptFor, sendKey, type SendAttempt } from '@/data/retry'
import { Banner, Button, Empty, Screen, Section, Segmented, Spinner, cn } from '@/ui'
import { AttachButton, AttachmentStrip } from '@/ui/images'
import { ModeSheet } from '@/ui/ModeSheet'

/** 新会话的模式；null 都是「用电脑上的设置」 */
interface Settings {
  permissionMode: PermissionMode | null
  model: string | null
  effort: Effort | null
}
const DESKTOP: Settings = { permissionMode: null, model: null, effort: null }

export function NewTask({
  pairing,
  initialProject,
  initialText = '',
  onBack,
  onCreated,
}: {
  pairing: Pairing
  /** 在哪个项目里新建（抽屉里点的项目、当前项目） */
  initialProject?: string | null
  /** 输入框里先放好的（任务「交给 AI」） */
  initialText?: string
  onBack(): void
  onCreated(sessionId: string): void
}) {
  const { link, state, projects, loaded } = useDesktop(pairing.deviceId)
  const defaultEngine = useDefaultEngine(pairing.deviceId)
  const [projectId, setProjectId] = useState<string | null>(initialProject ?? null)
  // 没选过就跟电脑上的默认引擎；电脑版太旧拿不到时用 Claude
  const [picked, setPicked] = useState<EngineId | null>(null)
  const engine = picked ?? defaultEngine ?? 'claude'
  // 模型和强度跟引擎走：换了引擎（包括电脑上的默认引擎晚一点才取到）就回到电脑上的设置；
  // 权限模式留着（新引擎也支持这一档时），免得先选好的「只规划」被悄悄换成电脑上更宽的设置
  const [settings, setSettings] = useState<{ engine: EngineId; value: Settings }>({ engine, value: DESKTOP })
  const kept = settings.value.permissionMode
  const mode =
    settings.engine === engine
      ? settings.value
      : { ...DESKTOP, permissionMode: kept && ENGINES[engine]?.caps.permissionModes.includes(kept) ? kept : null }
  const setMode = (patch: Partial<Settings>) => setSettings({ engine, value: { ...mode, ...patch } })
  const [modeOpen, setModeOpen] = useState(false)
  const [text, setText] = useState(initialText)
  const images = usePendingImages()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = (projects.some(p => p.id === projectId) ? projectId : null) ?? projects[0]?.id ?? null
  const hasContent = !!text.trim() || images.images.length > 0

  // 上次建好了会话、但消息没发成功：重试时不再新建会话，消息沿用同一个 ID（data/retry.ts）
  const created = useRef<{ key: string; sessionId: string } | null>(null)
  const attempt = useRef<SendAttempt | null>(null)
  const create = async () => {
    if (!link || !chosen || !hasContent) return
    setBusy(true)
    setError(null)
    const value = text.trim()
    const ids = images.images.map(i => i.id)
    const picks = Object.fromEntries(Object.entries(mode).filter(([, v]) => v !== null))
    const target = JSON.stringify([chosen, engine, picks])
    try {
      if (created.current?.key !== target) {
        const record = await link.call<SessionRecord>('engine:createSession', { projectId: chosen, engine, ...picks })
        created.current = { key: target, sessionId: record.id }
      }
      const sessionId = created.current.sessionId
      const current = attemptFor(attempt.current, sendKey(sessionId, value, ids), () => crypto.randomUUID())
      attempt.current = current
      await link.call('engine:send', sessionId, {
        text: value,
        clientMessageId: current.id,
        ...(images.images.length ? { attachments: images.images } : {}),
      })
      created.current = null
      attempt.current = null
      onCreated(sessionId)
    } catch (e) {
      const code = (e as Error).message
      setError(code === 'MOBILE_BAD_ARGUMENT' ? '电脑不接受这个模式，换一个或用电脑上的设置。' : code)
      setBusy(false)
    }
  }

  return (
    <Screen
      title="新建会话"
      onBack={onBack}
      footer={
        <div className="border-t border-line-subtle p-3">
          <Button
            variant="primary"
            className="w-full"
            disabled={busy || images.busy || state !== 'ready' || !chosen || !hasContent}
            onClick={() => void create()}
          >
            {busy ? <Spinner size={16} /> : <Send size={17} />}
            {busy ? '正在创建…' : '开始'}
          </Button>
        </div>
      }
    >
      {loaded && projects.length === 0 ? (
        <Empty icon={Folder} title="电脑上还没有项目" body="先在电脑上的像素星空里添加一个项目文件夹。" />
      ) : (
        <div className="flex flex-col gap-6 py-4">
          <Section title="要做什么">
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={5}
              autoFocus
              placeholder="例如：把登录页的按钮改成圆角，并补上单元测试"
              className="block min-h-32 w-full resize-none bg-transparent px-4 py-3.5 text-prose text-fg outline-none placeholder:text-fg-faint"
            />
            <div className="flex items-end gap-1 border-t border-line-subtle px-2 pt-1.5 pb-1">
              <AttachButton disabled={busy} onFiles={files => void images.add(files)} />
              <div className="min-w-0 flex-1">
                {images.images.length || images.busy ? (
                  <AttachmentStrip
                    images={images.images.map(i => ({ id: i.id, src: imageDataUrl(i) }))}
                    busy={images.busy}
                    onRemove={images.remove}
                  />
                ) : (
                  <span className="block py-2.5 text-meta text-fg-faint">可以加截图或照片</span>
                )}
              </div>
            </div>
          </Section>
          {images.error && <Banner tone="danger">{images.error}</Banner>}
          <Section title="项目">
            {projects.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                className={cn(
                  'flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left active:bg-hover',
                  i > 0 && 'border-t border-line-subtle',
                )}
              >
                <Folder size={20} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui">{p.name}</span>
                  <span className="truncate font-mono text-label text-fg-faint" dir="rtl">
                    {p.path}
                  </span>
                </span>
                {chosen === p.id && <Check size={20} className="shrink-0 text-accent-fg" />}
              </button>
            ))}
          </Section>
          <div className="px-4">
            <div className="px-1 pb-2 text-meta font-medium text-fg-muted">引擎</div>
            <Segmented<EngineId>
              options={ENGINE_ORDER.map(id => ({ value: id, label: ENGINES[id].name }))}
              value={engine}
              onChange={setPicked}
            />
            {defaultEngine && !picked && <p className="mt-2 px-1 text-label text-fg-faint">默认用电脑上设的引擎。</p>}
          </div>
          <Section title="模式">
            <button
              type="button"
              onClick={() => setModeOpen(true)}
              className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-hover"
            >
              <span className="min-w-0 flex-1 truncate text-ui">{modeText(mode)}</span>
              <ChevronRight size={18} className="shrink-0 text-fg-faint" />
            </button>
          </Section>
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
      )}
      {modeOpen && (
        <NewMode
          deviceId={pairing.deviceId}
          engine={engine}
          mode={mode}
          onChange={setMode}
          onClose={() => setModeOpen(false)}
        />
      )}
    </Screen>
  )
}

/** 「每步问我 · Opus 4.1 · 高」；没选的项不显示，全没选是「用电脑上的设置」 */
function modeText(mode: Settings): string {
  const chip = modeChip({ permissionMode: mode.permissionMode ?? 'ask', model: mode.model, effort: mode.effort })
  const parts = [mode.permissionMode && chip.permission, chip.model, chip.effort].filter(Boolean)
  return parts.length ? parts.join(' · ') : '用电脑上的设置'
}

function NewMode({
  deviceId,
  engine,
  mode,
  onChange,
  onClose,
}: {
  deviceId: string
  engine: EngineId
  mode: Settings
  onChange(patch: Partial<Settings>): void
  onClose(): void
}) {
  const catalog = useCatalog(deviceId, engine)
  const model = catalog.models?.find(m => m.id === mode.model)
  return (
    <ModeSheet
      title="新会话的模式"
      readOnly={catalog.unsupported}
      error={catalog.unsupported ? '电脑上的像素星空版本较旧，新会话用电脑上的设置。' : null}
      note="没选的项用电脑上的设置。"
      onClose={onClose}
      groups={[
        {
          key: 'permission',
          title: '权限',
          options: permissionOptions(engine, null),
          value: mode.permissionMode ?? '',
          onPick: v => {
            const to = (v || null) as PermissionMode | null
            if (to && widens(null, to) && !confirm('放宽权限：AI 改文件时不再先问你。确定吗？')) return
            onChange({ permissionMode: to })
          },
        },
        {
          key: 'model',
          title: catalog.models === null && !catalog.unsupported ? '模型（正在取）' : '模型',
          options: modelOptions(catalog.models, mode.model),
          value: mode.model ?? '',
          // 换了模型：强度可能不在新模型的范围里，回到默认
          onPick: v => onChange({ model: v || null, effort: null }),
        },
        {
          key: 'effort',
          title: '推理强度',
          options: effortOptions(engine, model, mode.effort),
          value: mode.effort ?? '',
          onPick: v => onChange({ effort: (v || null) as Effort | null }),
        },
      ]}
    />
  )
}
