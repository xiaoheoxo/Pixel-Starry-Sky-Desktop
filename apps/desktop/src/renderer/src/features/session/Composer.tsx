import { translateMessage } from '../../i18n/core'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { ArrowUp, AtSign, ChevronDown, Mic, Paperclip, Plus, ShieldOff, Square, SquareSlash } from 'lucide-react'
import { settledResizeObserver } from '@/features/panes/motion'
import { IconButton, cn, useComingSoon, useToast } from '@/ui'
import { attachments as initialAttachments, composer, isDemo } from '@/data'
import {
  SOURCE_ACTION_EVENT,
  bridge,
  takePendingSourceAction,
  useDemoSourceController,
  type ComposerController,
  type QueueController,
  type SourceAction,
  type StatusBarController,
} from '@/features/engine'
import {
  MAX_FILE_BYTES,
  MAX_FILE_COUNT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_TOTAL,
  type FileAttachment,
} from '@pixelsky/protocol'
import { useAccount } from '@/features/account/useAccount'
import type { CreditSource } from '@/features/account/platform'
import { sourceOfChannel, type ChannelChoice } from '@/features/model-channels/channelModel'
import type { SourceSwitch } from './SourceHintBar'
import { useSettings } from '@/features/settings/SettingsProvider'
import { AttachmentChip } from './AttachmentChip'
import { EffortMenu, PermissionMenu } from './ComposerMenus'
import { ModelSourceMenu } from './ModelSourceMenu'
import { SourceHintBar } from './SourceHintBar'
import { FullAccessStrip } from './FullAccessStrip'
import { ResizeHandle } from '@/ui/ResizeHandle'
import { setLayoutSize, useLayoutSize } from '@/features/layout/sizes'
import { useComposerDraft } from '@/features/engine/drafts'
import { QueuedMessages } from './QueuedMessages'
import { ContextWindowButton } from './ContextWindowButton'
import { QuotaButton } from './quota/QuotaButton'
import { useComposerStyle } from '@/features/settings/composerStyle'
import { useStopBackgroundAgents } from '@/features/settings/stopBackgroundAgents'
import { ComposerStatusBar } from './ComposerStatusBar'
import './composerCompact.css'
import { useI18n } from '@/i18n/I18nProvider'
import { useCommands } from '@/features/settings/plugins/useCommands'
import { CommandMenu } from './CommandMenu'
import { activeEditorSelection, usePromptCommands } from '@/features/extpacks/prompts/usePromptCommands'
import { fillPrompt } from '@/features/extpacks/prompts/model'
import { loadPromptBody } from '@/features/extpacks/prompts/load'
import { fileLanguage } from '@/features/editor/code/languages'
import { getFiles } from '@/features/files/store'
import { MentionMenu, useMentionEntries } from './MentionMenu'
import { applyMention, folderMention, insertAt, insertMention, mentionAt } from './mention'
import { machineOf } from '@/features/machines/store'
import { composerWorkspace } from './composerWorkspace'
import { useResumeCommand } from '@/features/resume/useResumeCommand'
import { parseResumeCommand } from '@/features/resume/model'
import { openResumePicker } from '@/features/resume/store'
import { escapeStops } from './escapeStop'
import { compactThenRetry } from './live/errorKind'
import { tr } from '../../i18n/core'
import { ImageAttachments } from '@/features/session/attachments/ImageAttachments'
import { FileAttachments } from '@/features/session/attachments/FileAttachments'
import { readImage } from '@/features/session/attachments/images'
import { needsConversion } from '@/features/session/attachments/convertImage'
import { isImageFile, readTextFile } from '@/features/session/attachments/files'
import { stageFile } from '@/features/session/attachments/stage'
import { updateFiles, updateImages, useFileDraft, useImageDraft } from '@/features/session/attachments/drafts'
import { Popover, PopoverItem } from '@/ui'
import { ComposerInput, type ComposerInputHandle } from './composerInput/ComposerInput'

/** text-prose 是 14px / 1.7，行高取整成 24px，增高计算和样式共用 */
const LINE_HEIGHT = 24
const MAX_ROWS = 8
/** 输入区上下内边距（pt-3.5 + pb-3.5） */
export const CARD_STYLE =
  'composer-card rounded-2xl border border-line-composer bg-surface shadow-composer transition-[border-color,box-shadow] duration-(--dur-base) ease-(--ease-out) focus-within:border-line-composer-focus focus-within:ring-2 focus-within:ring-composer-ring'
/**
 * 输入框：附件与文本、发送 / 停止；设置工具行在框外。
 * 传入 live（引擎的真实逻辑）时能真正发送，Enter 发送、Shift+Enter 换行，运行中发送键变成停止键；
 * 不传（演示模式）时按钮只提示「即将推出」。
 */
/** 输入框的草稿键；对话区右键菜单往输入框里放引用，要和输入框用同一个（演示模式是 demo） */
export const composerDraftKey = (
  draftKey: string | undefined,
  live: { sessionId: string | null } | null | undefined,
): string => draftKey ?? live?.sessionId ?? (live ? 'new-session' : 'demo')

export function Composer({
  live,
  status,
  autoFocus,
  draftKey,
  onSideQuestion,
  statusExtra,
  demoQueue,
  newTask,
}: {
  live?: ComposerController
  /** 演示模式没有 live，消息队列面板用演示的（features/engine/demoQueue.ts） */
  demoQueue?: QueueController
  status?: StatusBarController
  autoFocus?: boolean
  draftKey?: string
  /** 「/btw 问题」：交给旁聊，不发进主对话（docs/ui/rewind-fork-sidechat.md §3） */
  onSideQuestion?: (question: string) => void
  /** 输入框上方那一行右边的按钮（旁聊） */
  statusExtra?: ReactNode
  /** 欢迎页（新任务）的输入框：模型按钮旁边写「接着上次」（docs/ui/model-channels.md §2.6） */
  newTask?: boolean
}) {
  useI18n()
  const comingSoon = useComingSoon()
  const toast = useToast()
  const { text: translate } = useI18n()
  const style = useComposerStyle()
  const chatgpt = style === 'chatgpt'
  const paddingY = chatgpt ? 22 : 28
  const [items, setItems] = useState(initialAttachments)
  const key = composerDraftKey(draftKey, live)
  const imageDraft = useImageDraft(key)
  const images = imageDraft.images
  const fileDraft = useFileDraft(key)
  const textFiles = fileDraft.files
  const [reading, setReading] = useState(0)
  const adding = useRef(Promise.resolve())
  const pendingReads = useRef(0)
  const [draggingImages, setDraggingImages] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [text, setText] = useComposerDraft(key)
  const submission = useRef<{ text: string; images: string; id: string } | null>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<ComposerInputHandle>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const composerHeight = useLayoutSize('composerHeight')
  const [maxHeight, setMaxHeight] = useState(LINE_HEIGHT * MAX_ROWS + paddingY)
  /** 输入框内容的高度（含内边距），输入框报上来 */
  const [contentHeight, setContentHeight] = useState(56)
  // 引擎 / 额度来源 / 模型菜单；已开始的会话切换平台 ↔ 自有前先确认（docs/ui/source-switch.md §3.4）
  const [menuOpen, setMenuOpen] = useState(false)
  const [addMenu, setAddMenu] = useState(false)
  const [confirmSource, setConfirmSource] = useState<SourceSwitch | null>(null)
  const account = useAccount()
  const settings = useSettings()
  const demoSource = useDemoSourceController()
  const commands = useCommands(live?.sessionId, live?.engine?.id),
    listId = useId()
  // 扩展提示词跟技能命令一起出现在「/」菜单里；要选中内容的提示词只在编辑器里有选中时才列出
  const promptCommands = usePromptCommands(!!activeEditorSelection())
  // 「/resume」是像素星空自己的命令（接着终端里的 Claude Code / Codex 会话）：执行者是 Claude Code 或 Codex 才有；引擎哪天也给了同名命令就丢掉它的
  const resumeWorkspace = composerWorkspace(live?.sessionId, status, draftKey)
  const resumeEngineId = (live ?? demoSource).engine?.id
  const resumeCommand = useResumeCommand(resumeEngineId, resumeWorkspace?.sessionId ?? resumeWorkspace?.projectId)
  const menuCommands = useMemo(
    () => [
      ...(resumeCommand ? commands.filter(c => !(c.name === 'resume' && c.invocation !== 'skill')) : commands),
      ...promptCommands,
      ...(resumeCommand ? [resumeCommand] : []),
    ],
    [commands, promptCommands, resumeCommand],
  )
  const [commandIndex, setCommandIndex] = useState(0),
    [commandDismissed, setCommandDismissed] = useState(false)
  const commandQuery = /^[/$]([^\s]*)$/.exec(text)?.[1].toLowerCase()
  const commandPrefix = text[0]
  const commandMatches = useMemo(
    () =>
      commandQuery !== undefined && !commandDismissed
        ? menuCommands.filter(
            command =>
              (commandPrefix === '$' ? command.invocation === 'skill' : command.invocation !== 'skill') &&
              (command.name.toLowerCase().includes(commandQuery) ||
                (command.invocation === 'prompt' && command.prompt.title.toLowerCase().includes(commandQuery))),
          )
        : [],
    [menuCommands, commandQuery, commandDismissed, commandPrefix],
  )
  const activeCommandIndex = Math.min(commandIndex, Math.max(0, commandMatches.length - 1))
  // 输入 @ 引用项目文件（docs/ui/workbench-ux-3.md §2.6）：光标前是 @ 词时弹出文件列表
  const canMention = !!live && !!window.pixelsky?.files
  const mentionListId = useId()
  const [caret, setCaret] = useState<number | null>(null)
  const [mentionDismissed, setMentionDismissed] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const mentionTarget = canMention ? composerWorkspace(live?.sessionId, status, draftKey) : null
  const mention =
    mentionTarget && caret !== null && commandQuery === undefined && !mentionDismissed ? mentionAt(text, caret) : null
  const mentions = useMentionEntries(mentionTarget, mention?.query ?? null)
  const activeMentionIndex = Math.min(mentionIndex, Math.max(0, mentions.entries.length - 1))
  useEffect(() => {
    setCommandIndex(0)
    setCommandDismissed(false)
    setMentionIndex(0)
    setMentionDismissed(false)
  }, [text])
  useEffect(() => {
    setCommandIndex(index => Math.min(index, Math.max(0, commandMatches.length - 1)))
  }, [commandMatches])
  // 选择框选中时才取输入框的设置：打开时输入框可能还没准备好（刚启动），模型目录也可能还在加载
  const liveRef = useRef(live)
  liveRef.current = live
  const executorRef = useRef(resumeEngineId)
  executorRef.current = resumeEngineId
  /** 打开「接着 Claude Code / Codex 会话」选择框（列当前执行者的）；关掉回到这个输入框，打开了新对话就清掉输入框里的 /resume */
  const openResume = (parsed: { id: string | null; query: string } = { id: null, query: '' }): void => {
    setCommandDismissed(true)
    openResumePicker({
      engine: resumeEngineId === 'codex' ? 'codex' : 'claude',
      projectId: status?.project?.id ?? (isDemo ? 'demo' : null),
      query: parsed.query,
      id: parsed.id,
      settingsFor: sessionModel => liveRef.current?.resumeSettings(sessionModel),
      executorNow: () => executorRef.current,
      onOpened: () => setText(''),
      onClosed: () => ref.current?.focus(),
    })
  }
  const chooseCommand = (index: number): void => {
    const command = commandMatches[index]
    if (command?.invocation === 'app') {
      // 菜单里选中：输入框里只有刚敲的「/resu」这一个词（commandQuery 的正则要求整段文字就是它），清掉，回到敲「/」之前
      setText('')
      openResume()
    } else if (command?.invocation === 'prompt') {
      setCommandDismissed(true)
      const selected = activeEditorSelection()
      const file = getFiles().tabs.find(t => t.id === getFiles().active)?.path ?? ''
      void loadPromptBody(command.prompt)
        .then(body => {
          const filled = fillPrompt(body, {
            selection: selected?.text ?? '',
            file,
            language: file ? fileLanguage(file) : '',
            project:
              (status?.project?.path ?? '')
                .replace(/[\\/]+$/, '')
                .split(/[\\/]/)
                .pop() ?? '',
          })
          setText(filled)
          placeCaret(filled.length)
        })
        .catch((e: unknown) => toast(tr('prompts.loadFailed', { error: (e as Error).message })))
    } else if (command) {
      setText((command.invocation === 'skill' ? '$' : '/') + command.name + ' ')
      setCommandDismissed(true)
      ref.current?.focus()
    }
  }

  /** 改了文字后把光标放到指定位置（等这次渲染把新文字写进输入框） */
  const placeCaret = (at: number): void => {
    requestAnimationFrame(() => {
      if (!ref.current) return
      ref.current.setCaret(at)
      setCaret(at)
    })
  }
  const chooseMention = (index: number): void => {
    const entry = mentions.entries[index]
    if (!entry || !mention || caret === null) return
    const next = applyMention(text, mention, caret, entry)
    setText(next.text)
    placeCaret(next.caret)
  }

  const requestSource = (next: CreditSource): void => {
    if (!live || next === live.source) return
    if (live.started) setConfirmSource({ source: next, choice: null })
    else void live.setSource(next).catch((e: unknown) => setError((e as Error).message))
  }
  /**
   * 模型菜单里换到别的通道 / 引擎：已开始的对话先确认（换通道会重启引擎并接上原对话，换引擎会把之前的对话交接过去，
   * docs/ui/model-channels.md §2.3）。已记着「下一条消息换引擎」时选回原来的引擎只是撤销，同通道就不用确认
   */
  const requestChoice = (choice: ChannelChoice): void => {
    if (!live) return
    const undoEngine =
      !!live.pendingEngine && choice.engine === live.sessionEngine?.id && choice.channel === live.channel
    if (live.started && !undoEngine) setConfirmSource({ source: sourceOfChannel(choice.channel), choice })
    else void live.applyChoice(choice).catch((e: unknown) => setError((e as Error).message))
  }

  // 换会话时收起确认
  const sessionId = live?.sessionId ?? null
  useEffect(() => setConfirmSource(null), [sessionId])

  // 对话流里错误卡片的按钮（features/engine/sourceActions.ts）：只处理发给这个会话的
  const actionRef = useRef<(a: SourceAction) => void>(() => undefined)
  const retrying = useRef(false)
  actionRef.current = a => {
    // 重试：用输入框现在选的模型和线路发一条「继续」，接着出错前的上下文做；连点只发一次
    if (a === 'retry') {
      if (!live || live.running || retrying.current) return
      retrying.current = true
      setError(null)
      void live
        .submit(tr('session.live.NoticeActions.retryMessage'))
        .catch((e: unknown) => setError((e as Error).message))
        .finally(() => (retrying.current = false))
    } else if (a === 'compact-retry') {
      // 上下文超限：先把 /compact 排进队列，再发「继续」——它排在压缩后面，压缩完才轮到；压缩发不出去（引擎不支持、正忙）就不发了
      if (!live || live.running || retrying.current || !live.sessionId) return
      retrying.current = true
      setError(null)
      const id = live.sessionId
      const b = bridge
      void compactThenRetry(b ? () => b.compact(id) : undefined, () =>
        live.submit(tr('session.live.NoticeActions.retryMessage')),
      )
        .catch((e: unknown) => setError(translateMessage((e as Error).message)))
        .finally(() => (retrying.current = false))
    } else if (a === 'open-menu') setMenuOpen(true)
    else if (a === 'use-self') requestSource('self')
    else if (a === 'use-platform') requestSource('platform')
    else if (a === 'open-account') settings.openSettings('account')
    else if (a === 'sign-in') void account.login()
    else if (a === 'edit-provider') settings.openSettings('models')
  }
  useEffect(() => {
    if (!sessionId) return
    const on = (e: Event): void => {
      const d = (e as CustomEvent<{ sessionId?: string; action?: SourceAction }>).detail
      if (d?.sessionId !== sessionId || !d.action) return
      // 侧栏悬停卡同时记了一份「打开后再做」，这里接住了就不再重复执行
      takePendingSourceAction(sessionId)
      actionRef.current(d.action)
    }
    // 侧栏悬停卡里的「重试」「改线路」：先打开会话，输入框挂上后在这里执行
    const waiting = takePendingSourceAction(sessionId)
    if (waiting) actionRef.current(waiting)
    window.addEventListener(SOURCE_ACTION_EVENT, on)
    return () => window.removeEventListener(SOURCE_ACTION_EVENT, on)
  }, [sessionId])

  useLayoutEffect(() => {
    const card = cardRef.current
    const pane = card?.closest('main')
    if (!card || !pane) return
    const measure = (): void => {
      if (!card.clientWidth || !pane.clientHeight) return
      const overhead = card.offsetHeight - (ref.current?.dom?.offsetHeight ?? 56)
      setMaxHeight(
        Math.max(56, Math.floor(pane.clientHeight / 2) - overhead - (toolbarRef.current?.offsetHeight ?? 40)),
      )
    }
    measure()
    // 窗格过渡期间不量，结束后补一次（不然每帧重渲染输入框）
    const observer = settledResizeObserver(measure)
    observer.observe(card)
    observer.observe(pane)
    if (toolbarRef.current) observer.observe(toolbarRef.current)
    return () => observer.disconnect()
  }, [style])

  // 高度：没拖过时跟着内容长，最多 8 行（再不超过窗格一半）；拖过就用拖的高度
  const automaticMax = Math.min(LINE_HEIGHT * MAX_ROWS + paddingY, maxHeight)
  const textHeight = Math.max(
    56,
    composerHeight === null ? Math.min(contentHeight, automaticMax) : Math.min(composerHeight, maxHeight),
  )

  const remove = (id: string) => setItems(list => list.filter(a => a.id !== id))
  const files = items.filter(a => a.kind !== 'mode')
  const modes = items.filter(a => a.kind === 'mode')
  const hasText = text.trim().length > 0
  const running = !!live?.running
  const stopWithMain = useStopBackgroundAgents()
  const hasContent = hasText || images.length > 0 || textFiles.length > 0
  const canSend = hasContent && !busy && !reading && !imageDraft.loading && !fileDraft.loading

  /** 读附件排队进行，读的时候发送键不可用 */
  const read = (work: () => Promise<void>): void => {
    setReading(n => n + 1)
    pendingReads.current++
    adding.current = adding.current.then(async () => {
      try {
        await work()
        setError(null)
      } catch (error) {
        setError((error as Error).message)
      } finally {
        pendingReads.current--
        setReading(n => n - 1)
      }
    })
    void adding.current
  }

  /** 拖进来、粘贴、从「+」选的文件：可解析的文字照常附上，其余用目标机器可读的路径引用 */
  const addFiles = (files: FileList | File[]): void => {
    const list = [...files]
    const imageFiles = list.filter(isImageFile)
    const pathImages = imageFiles.filter(
      file => file.size > MAX_FILE_BYTES || (!needsConversion(file) && file.size > MAX_IMAGE_BYTES),
    )
    const pictures = imageFiles.filter(file => !pathImages.includes(file))
    const others = [...list.filter(file => !isImageFile(file)), ...pathImages]
    if (pictures.length) addImages(pictures)
    if (!others.length) return
    if (textFiles.length + others.length > MAX_FILE_COUNT) {
      setError(tr('composer.file.tooMany'))
      return
    }
    const workspace = composerWorkspace(live?.sessionId, status, draftKey)
    const local = machineOf(workspace?.sessionId ?? workspace?.projectId) === 'local'
    const reference = async (file: File, path: string): Promise<FileAttachment> => {
      const staged = !path
      const targetPath = path || (workspace ? await stageFile(file, workspace) : '')
      if (!targetPath) throw new Error(tr('composer.file.stageUnavailable'))
      return {
        id: crypto.randomUUID(),
        name: file.name || 'attachment',
        bytes: file.size,
        lines: 0,
        encoding: 'utf-8',
        text: '',
        path: targetPath,
        pathOnly: true,
        ...(staged ? { staged: true } : {}),
      }
    }
    const withPath = async (file: File): Promise<FileAttachment> => {
      const path = local ? (window.pixelsky?.pathForFile(file) ?? '') : ''
      if (file.size > MAX_FILE_BYTES) return reference(file, path)
      try {
        const read = await readTextFile(file)
        if (path) return { ...read, path }
        if (read.tail !== undefined || read.omitted !== undefined) return reference(file, '')
        return read
      } catch {
        return reference(file, path)
      }
    }
    read(async () => {
      // 远程文件分块上传需顺序发送；一个失败不耽误剩余文件。
      const loaded: FileAttachment[] = []
      let failed: unknown
      for (const file of others) {
        try {
          loaded.push(await withPath(file))
        } catch (error) {
          failed ??= error
        }
      }
      if (loaded.length) await updateFiles(key, current => [...current, ...loaded])
      if (failed) throw failed
    })
  }

  const addImages = (list: File[]): void => {
    if (list.length === 0) return
    if (live?.engine && live.engine.caps.imageInput !== true) {
      setError(tr('composer.attachment.unsupportedEngine'))
      return
    }
    if (images.length + list.length > MAX_IMAGE_COUNT) {
      setError(tr('composer.attachment.tooMany'))
      return
    }
    // 要转成 PNG 的（BMP 这类）原文件大小不算数，转完再算
    const already = images.reduce((sum, image) => sum + image.bytes, 0)
    if (already + list.reduce((sum, file) => sum + (needsConversion(file) ? 0 : file.size), 0) > MAX_IMAGE_TOTAL) {
      setError(tr('composer.attachment.totalTooLarge'))
      return
    }
    read(async () => {
      // 和文件一样：一张读不了（HEIC 这类）不耽误别的
      const results = await Promise.allSettled(list.map(readImage))
      const loaded = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
      if (already + loaded.reduce((sum, image) => sum + image.bytes, 0) > MAX_IMAGE_TOTAL)
        throw new Error(tr('composer.attachment.totalTooLarge'))
      if (loaded.length) await updateImages(key, current => [...current, ...loaded])
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) throw failed.reason
    })
  }

  /** 拖进来 / 粘贴的东西里分出文件夹（GitHub #15）：文件夹插成 @路径，其余照常当附件。要在事件里同步读 */
  const splitFolders = (transfer: DataTransfer): { folders: string[]; files: File[] } => {
    const folders: string[] = [],
      files: File[] = []
    const items = [...transfer.items].filter(item => item.kind === 'file')
    if (!items.length) return { folders, files: [...transfer.files] }
    for (const item of items) {
      const file = item.getAsFile()
      if (!file) continue
      if (item.webkitGetAsEntry()?.isDirectory) folders.push(window.pixelsky?.pathForFile(file) ?? '')
      else files.push(file)
    }
    return { folders, files }
  }

  /** 文件夹写成 @路径 插到光标处：工作目录里的用相对路径；远程机器上的会话看不到本机文件夹 */
  const addFolders = (paths: string[]): void => {
    if (!paths.length) return
    const workspace = composerWorkspace(live?.sessionId, status, draftKey)
    if (machineOf(workspace?.sessionId ?? workspace?.projectId) !== 'local') {
      setError(tr('composer.folder.remote'))
      return
    }
    if (paths.some(path => !path)) {
      setError(tr('composer.folder.noPath'))
      return
    }
    const insert = paths.map(path => folderMention(path, status?.project?.path)).join('')
    const sel = ref.current?.selection() ?? { from: text.length, to: text.length }
    const next = insertAt(text, sel.from, sel.to, insert)
    setText(next.text)
    setError(null)
    placeCaret(next.caret)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDraggingImages(false)
    const { folders, files } = splitFolders(event.dataTransfer)
    addFolders(folders)
    addFiles(files)
  }

  const submit = async (): Promise<void> => {
    const side = onSideQuestion ? /^\/btw\s+([\s\S]+)$/.exec(text.trim()) : null
    if (side) {
      onSideQuestion!(side[1].trim())
      setText('')
      return
    }
    // 手打 /resume [关键词 | 完整 id] 回车：打开选择框，不发给 Claude
    const resume = resumeCommand ? parseResumeCommand(text) : null
    if (resume) {
      openResume(resume)
      return
    }
    if (!live) {
      if (hasContent) comingSoon(translate('发送'))
      return
    }
    if (!canSend || submitting.current || pendingReads.current) return
    submitting.current = true
    const sent = text
    const imageSignature = [...images, ...textFiles].map(attachment => attachment.id).join(',')
    if (submission.current?.text !== sent || submission.current.images !== imageSignature)
      submission.current = { text: sent, images: imageSignature, id: crypto.randomUUID() }
    setBusy(true)
    setError(null)
    try {
      await live.submit(sent, submission.current.id, images, textFiles)
      setText(current => (current === sent ? '' : current))
      const sentIds = new Set([...images, ...textFiles].map(attachment => attachment.id))
      if (images.length) await updateImages(key, current => current.filter(image => !sentIds.has(image.id)))
      if (textFiles.length) await updateFiles(key, current => current.filter(file => !sentIds.has(file.id)))
      submission.current = null
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      submitting.current = false
      ref.current?.focus()
    }
  }

  const suggestion = live && !running && text === '' ? live.suggestion : null
  const stop = (): void => void live?.stop().catch((err: Error) => setError(err.message))

  // 输入框是 CodeMirror（composerInput/ComposerInput.tsx），这里拿到的是原生键盘事件，先于编辑器自己的按键处理
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return
    if (commandQuery !== undefined && !commandDismissed) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setCommandDismissed(true)
        return
      }
      if (commandMatches.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(e.key) && !e.shiftKey) {
        e.preventDefault()
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          setCommandIndex(
            index =>
              (Math.min(index, commandMatches.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + commandMatches.length) %
              commandMatches.length,
          )
        } else chooseCommand(activeCommandIndex)
        return
      }
    }
    if (mention) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setMentionDismissed(true)
        return
      }
      if (mentions.entries.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(e.key) && !e.shiftKey) {
        e.preventDefault()
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const n = mentions.entries.length
          setMentionIndex(index => (Math.min(index, n - 1) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
        } else chooseMention(activeMentionIndex)
        return
      }
    }
    // 回复进行中按 Esc 停止，和停止按钮一样（docs/ui/conversation-ux.md §2.5）
    const { isComposing, defaultPrevented } = e
    if (escapeStops({ key: e.key, isComposing, defaultPrevented }, running)) {
      e.preventDefault()
      stop()
      return
    }
    // 输入建议：输入框为空时按 Tab 填入（docs/engines.md §15.5）
    if (e.key === 'Tab' && !e.shiftKey && suggestion) {
      e.preventDefault()
      setText(suggestion)
      return
    }
    // 输入法正在选字时的回车不是发送
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    void submit()
  }

  // 停止 / 发送：Claude 风格在输入行右边；ChatGPT 风格放在整张卡片（composer-shell）的右下角，和工具行对齐，
  // 不能放进 composer-core（它也是 relative，按钮会落到输入区底边，比工具行高一截）。
  const sendControls = (
    <div
      className={cn(
        'composer-send-controls flex shrink-0 items-center gap-1',
        chatgpt ? 'absolute right-3 bottom-2.5' : 'pr-3 pb-3',
      )}
    >
      {/* 独立 key 保留停止与发送的点击目标语义。 */}
      {running && (
        <button
          key="stop"
          type="button"
          aria-label={translate('停止')}
          title={
            live?.backgroundAgents && stopWithMain
              ? tr('subagentStop.stopTooltip', { n: live.backgroundAgents })
              : translate('停止当前任务并暂停队列（Esc）')
          }
          onClick={stop}
          className="press no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg hover:opacity-90"
        >
          <Square size={12} strokeWidth={0} fill="currentColor" />
        </button>
      )}
      {(!running || hasContent) && (
        <button
          key="send"
          type="button"
          aria-label={running ? translate('加入队列') : translate('发送')}
          aria-disabled={!canSend}
          title={running ? translate('加入队列（Enter）') : translate('发送（Enter）')}
          onClick={() => void submit()}
          className={cn(
            'no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-full',
            canSend
              ? 'press bg-primary text-primary-fg hover:opacity-90'
              : 'bg-disabled text-disabled-fg transition-colors',
          )}
        >
          <ArrowUp size={17} strokeWidth={2} />
        </button>
      )}
    </div>
  )

  return (
    <>
      {(live ?? demoQueue) && (
        <QueuedMessages
          live={(live ?? demoQueue)!}
          sessionId={live?.sessionId ?? null}
          onPrepareRecall={async recalled => {
            if (!recalled.attachments?.length && !recalled.files?.length) return
            const restored = new Set<string>()
            if (recalled.attachments?.length)
              await updateImages(key, current => {
                const added = recalled.attachments!.filter(image => !current.some(existing => existing.id === image.id))
                added.forEach(image => restored.add(image.id))
                return [...current, ...added]
              })
            if (recalled.files?.length)
              await updateFiles(key, current => {
                const added = recalled.files!.filter(file => !current.some(existing => existing.id === file.id))
                added.forEach(file => restored.add(file.id))
                return [...current, ...added]
              })
            return async () => {
              await updateImages(key, current => current.filter(image => !restored.has(image.id)))
              await updateFiles(key, current => current.filter(file => !restored.has(file.id)))
            }
          }}
          onRecall={recalled => {
            setText(current => (current && recalled ? `${current}\n${recalled}` : current || recalled))
            ref.current?.focus()
          }}
        />
      )}
      <ComposerStatusBar
        live={status}
        extra={statusExtra}
        git={live ? composerWorkspace(live.sessionId, status, draftKey) : null}
      />
      <div data-composer-style={style} className={cn('composer-shell relative', chatgpt && CARD_STYLE)}>
        <div
          ref={cardRef}
          onDragEnter={e => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              setDraggingImages(true)
            }
          }}
          onDragOver={e => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
          onDragLeave={e => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDraggingImages(false)
          }}
          onDrop={onDrop}
          className={cn('composer-core relative', !chatgpt && CARD_STYLE, draggingImages && 'ring-2 ring-accent')}
        >
          {draggingImages && (
            <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent-line bg-accent-soft/80 text-ui font-medium text-accent-fg">
              {tr('composer.file.drop')}
            </div>
          )}
          {commandQuery !== undefined && !commandDismissed && (
            <CommandMenu
              id={listId}
              commands={commandMatches}
              selected={activeCommandIndex}
              onChoose={chooseCommand}
              onSettings={() => {
                setCommandDismissed(true)
                settings.openSettings('plugins')
              }}
            />
          )}
          {mention && (
            <MentionMenu
              id={mentionListId}
              entries={mentions.entries}
              loading={mentions.loading}
              selected={activeMentionIndex}
              onChoose={chooseMention}
            />
          )}
          <ResizeHandle
            label={translate('调整输入框高度')}
            axis="y"
            className="composer-resize-top"
            scale={-1}
            value={textHeight}
            min={56}
            max={maxHeight}
            onChange={v => setLayoutSize('composerHeight', v)}
            onCommit={v => setLayoutSize('composerHeight', v, true)}
            onCancel={() => setLayoutSize('composerHeight', composerHeight, true)}
            onReset={() => setLayoutSize('composerHeight', null, true)}
          />
          {live && live.permissionMode === 'full' && <FullAccessStrip live={live} />}
          {live && (
            <SourceHintBar
              live={live}
              confirm={confirmSource}
              onCancelConfirm={() => setConfirmSource(null)}
              onRequestSource={requestSource}
              onOpenMenu={() => setMenuOpen(true)}
            />
          )}
          {items.length > 0 && (
            <div className="flex flex-col gap-2 px-4 pt-3.5">
              {[files, modes]
                .filter(row => row.length > 0)
                .map((row, i) => (
                  <div key={i} className="flex flex-wrap gap-2">
                    {row.map(a => (
                      <AttachmentChip key={a.id} attachment={a} onRemove={() => remove(a.id)} />
                    ))}
                  </div>
                ))}
            </div>
          )}
          {images.length > 0 && (
            <div className="px-4 pt-3.5">
              <ImageAttachments
                images={images}
                onRemove={id => {
                  void imageDraft
                    .update(current => current.filter(image => image.id !== id))
                    .catch(error => setError((error as Error).message))
                }}
                onReplace={(id, next) => {
                  void imageDraft
                    .update(current => current.map(image => (image.id === id ? next : image)))
                    .catch(error => setError((error as Error).message))
                }}
              />
            </div>
          )}
          {textFiles.length > 0 && (
            <div className="px-4 pt-3.5">
              <FileAttachments
                files={textFiles}
                onRemove={id => {
                  void fileDraft
                    .update(current => current.filter(file => file.id !== id))
                    .catch(error => setError((error as Error).message))
                }}
              />
            </div>
          )}
          {!!reading && (
            <p role="status" className="px-4 pt-2 text-meta text-fg-muted">
              {tr('composer.attachment.loading')}
            </p>
          )}
          {(imageDraft.error || fileDraft.error) && (
            <p role="status" className="px-4 pt-2 text-meta text-danger">
              {translateMessage(imageDraft.error ?? fileDraft.error)}
            </p>
          )}

          <div className="composer-input-row flex min-w-0 items-end">
            {/* 粘贴的长文本在这里折成标签（docs/ui/composer-paste-fold.md） */}
            <ComposerInput
              ref={ref}
              composerKey={key}
              ariaControls={commandMatches.length ? listId : mention ? mentionListId : undefined}
              ariaActiveDescendant={
                commandMatches.length
                  ? `${listId}-${activeCommandIndex}`
                  : mention && mentions.entries.length
                    ? `${mentionListId}-${activeMentionIndex}`
                    : undefined
              }
              value={text}
              autoFocus={autoFocus}
              onChange={value => {
                setText(value)
                if (error) setError(null)
              }}
              onCaret={setCaret}
              onKeyDown={onKeyDown}
              onPasteFiles={data => {
                const { folders, files } = splitFolders(data)
                if (!files.length && !folders.length) return false
                addFolders(folders)
                addFiles(files)
                return true
              }}
              placeholder={
                live?.awaitingApproval
                  ? tr('approvals.composerHint')
                  : running
                    ? translate('继续补充要求，Enter 加入队列…')
                    : suggestion
                      ? `${suggestion}（${translate('按 Tab 填入')}）`
                      : translate(composer.placeholder)
              }
              height={textHeight}
              onContentHeight={setContentHeight}
              tight={chatgpt}
              className="text-prose text-fg"
            />
            {!chatgpt && sendControls}
          </div>

          {error && (
            <div className="px-4 pb-1.5 text-meta whitespace-pre-wrap text-danger">{translateMessage(error)}</div>
          )}
        </div>

        <div
          ref={toolbarRef}
          className={cn(
            'composer-toolbar flex flex-wrap items-center gap-1',
            chatgpt ? cn('pl-2.5 pb-2.5', running && hasContent ? 'pr-[84px]' : 'pr-[48px]') : 'px-1 pt-1.5',
          )}
        >
          <span className="relative">
            <IconButton
              icon={Plus}
              label={tr('composer.menu.add')}
              size={32}
              active={addMenu}
              onClick={() => setAddMenu(value => !value)}
            />
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={event => {
                if (event.currentTarget.files) addFiles(event.currentTarget.files)
                event.currentTarget.value = ''
                setAddMenu(false)
              }}
            />
            {/* 「+」菜单：图片或文件 / 引用文件（@）/ 命令（/），docs/ui/workbench-ux-3.md §2.6 */}
            <Popover open={addMenu} onClose={() => setAddMenu(false)} side="top" offset={8} className="w-52">
              <PopoverItem
                icon={<Paperclip size={15} strokeWidth={1.5} />}
                onClick={() => {
                  setAddMenu(false)
                  fileInput.current?.click()
                }}
              >
                {tr('composer.file.add')}
              </PopoverItem>
              {canMention && (
                <PopoverItem
                  icon={<AtSign size={15} strokeWidth={1.5} />}
                  hint="@"
                  onClick={() => {
                    setAddMenu(false)
                    const sel = ref.current?.selection() ?? { from: text.length, to: text.length }
                    const next = insertMention(text, sel.from, sel.to)
                    setText(next.text)
                    placeCaret(next.caret)
                  }}
                >
                  {tr('composer.menu.file')}
                </PopoverItem>
              )}
              {menuCommands.length > 0 && (
                <PopoverItem
                  icon={<SquareSlash size={15} strokeWidth={1.5} />}
                  hint="/"
                  disabled={!!text.trim()}
                  title={text.trim() ? tr('composer.menu.commandAtStart') : undefined}
                  onClick={() => {
                    setAddMenu(false)
                    setText('/')
                    placeCaret(1)
                  }}
                >
                  {tr('composer.menu.command')}
                </PopoverItem>
              )}
            </Popover>
          </span>
          {live ? (
            // 外包一层 contents：窄宽时 composerCompact.css 靠它把权限按钮收成只剩图标
            <span data-composer-permission className="contents">
              <PermissionMenu
                mode={live.permissionMode}
                modes={live.permissionModes}
                onSelect={live.setPermissionMode}
                engine={live.engine?.id}
                defaultMode={live.defaultPermissionMode}
                started={live.started}
              />
            </span>
          ) : (
            <button
              type="button"
              title={translate('权限模式')}
              aria-label={translate('权限模式')}
              onClick={() => comingSoon(translate('权限模式'))}
              className="press no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-md text-warn hover:bg-hover"
            >
              <ShieldOff size={16} strokeWidth={1.5} />
            </button>
          )}

          <div className="flex-1" />

          {live ? (
            <>
              <ModelSourceMenu
                live={live}
                newTask={newTask}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onRequestChoice={requestChoice}
              />
              <EffortMenu live={live} />
            </>
          ) : (
            <>
              <ModelSourceMenu
                live={demoSource}
                newTask={newTask}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                onRequestChoice={c => void demoSource.applyChoice(c)}
              />
              <button
                type="button"
                onClick={() => comingSoon(translate('推理强度'))}
                className="press no-drag inline-flex h-8 items-center gap-1 rounded-md px-2 text-list text-fg-secondary hover:bg-hover hover:text-fg"
              >
                <span>{composer.effort}</span>
                <ChevronDown size={14} strokeWidth={1.5} className="text-fg-muted" />
              </button>
            </>
          )}
          {/* 语音输入还没做：只在演示模式按参考图显示（docs/ui/conversation-ux.md §2.3） */}
          {!live && (
            <IconButton
              icon={Mic}
              label={translate('语音输入')}
              size={32}
              onClick={() => comingSoon(translate('语音输入'))}
            />
          )}
          {/* 窄宽时 composerCompact.css 靠 data-composer-quota 把额度按钮收成只剩图标 */}
          <span data-composer-quota className="contents">
            <QuotaButton
              controller={live ?? demoSource}
              sessionId={sessionId}
              onOpenChannels={() => setMenuOpen(true)}
            />
          </span>
          <ContextWindowButton sessionId={sessionId} engine={(live ?? demoSource).engine?.id ?? 'claude'} />
        </div>
        {chatgpt && sendControls}
      </div>
    </>
  )
}
