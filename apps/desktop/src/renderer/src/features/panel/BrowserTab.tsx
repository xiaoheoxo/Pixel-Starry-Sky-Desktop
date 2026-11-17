import { useEffect, useRef, useState } from 'react'
import { Clock, Globe } from 'lucide-react'
import { Button, cn, useToast } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { MAX_IMAGE_COUNT } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import {
  getAnnotationDraft,
  setAnnotationDraft,
  takeRemovedNotes,
  useRemovedAnnotations,
} from '@/features/session/attachments/annotationDraft'
import { OVERLAY_EVENT, collectOverlays, overlayHidesBrowser, pointShowsPlaceholder } from './browserOverlay'
import { placedDock, useDockPrefs, type AnnotationDock } from './annotationDock'
import { ElementNotes } from './ElementNotes'
import { shotImage } from './annotationText'
import { pickConfig } from './pickConfig'
import { PreviewViewport } from './PreviewViewport'
import { useProjectContext } from './projectContext'
import { NoProject, ToolError, useOperation } from './ToolsUi'
import {
  BROWSER_CAPTURE_MAX_HEIGHT,
  browserShortcut,
  type BrowserAnnotation,
  type BrowserIssueEntry,
  type BrowserPage,
  type BrowserShortcut,
  type BrowserState,
} from '../../../../shared/types/project-browser'
import type { WorkspaceRef } from '../../../../shared/types/workspace'
import { demo as demoData } from '@/data/demo'
import { isPortUrl, parsePort, portUrl, sameService } from '@/features/coding/bottom/portsModel'
import { usePortState } from '@/features/session/live/portTips'
import { isMac } from '@/features/layout/keybindings'
import { BrowserToolbar } from './BrowserToolbar'
import { BrowserPageTabs } from './BrowserPageTabs'
import { BrowserErrorPage } from './BrowserErrorPage'
import { plainAddress, showPageTabs } from './browserModel'
import { BrowserConsole } from './BrowserConsole'
import { BrowserFindBar, type FindRequest } from './BrowserFindBar'
import {
  attachmentProblem,
  captureAttachment,
  captureName,
  entriesQuote,
  issueCount,
  parseConsolePrefs,
  type ConsolePrefs,
} from './browserTools'
import { composerTarget } from '@/features/session/composerTarget'
import { updateImages } from '@/features/session/attachments/drafts'
import { sendTerminalQuote } from '@/features/terminal/AskAi'

/** 控制台抽屉的高度和「显示警告」存在这里（全局） */
const CONSOLE_PREFS_KEY = 'pixelsky.browser-console.v1'
const readConsolePrefs = (): ConsolePrefs => {
  try {
    return parseConsolePrefs(localStorage.getItem(CONSOLE_PREFS_KEY))
  } catch {
    return parseConsolePrefs(null)
  }
}

/** 网页和批注栏按批注栏的位置排（docs/ui/element-annotation.md §7） */
const DOCK_FLOW: Record<AnnotationDock, string> = {
  right: 'flex-row',
  left: 'flex-row-reverse',
  bottom: 'flex-col',
  top: 'flex-col-reverse',
}

export function BrowserTab({
  requested,
  onHandled,
}: {
  requested?: { ref: WorkspaceRef; url: string; seq: number } | null
  /** 请求已经交给浏览器：外面把它清掉。切对话时 BrowserBody 会按对话重建，不清的话切回来会再打开一次 */
  onHandled?: (seq: number) => void
}) {
  const ctx = useProjectContext()
  return ctx.ref ? (
    <BrowserBody
      key={ctx.key + ':' + JSON.stringify(ctx.ref)}
      target={ctx.ref}
      demo={ctx.demo}
      requested={requested}
      onHandled={onHandled}
    />
  ) : (
    <NoProject />
  )
}
function BrowserBody({
  target,
  demo,
  requested,
  onHandled,
}: {
  target: WorkspaceRef
  demo: boolean
  requested?: { ref: WorkspaceRef; url: string; seq: number } | null
  onHandled?: (seq: number) => void
}) {
  useI18n()
  const [state, setState] = useState<BrowserState | null>(
    demo ? structuredClone(demoData().projectTools.browser) : null,
  )
  const [note, setNote] = useState('')
  /** 刚放进输入框、已从列表移除的批注：提示几秒，可以放回列表（也从输入框的批注卡里拿掉） */
  const [sent, setSent] = useState<{ pageId: string; notes: BrowserAnnotation[] } | null>(null)
  /** 面板够宽时批注汇总放右侧（docs/ui/element-annotation.md §2），窄时是底部可折叠的样式 */
  const [wide, setWide] = useState(false)
  const dockPrefs = useDockPrefs()
  const placed = placedDock(dockPrefs.dock, wide)
  const root = useRef<HTMLDivElement>(null)
  /** 被弹出层挡住、视图藏起来时铺在占位框里的截图（定格画面）；没有时 null */
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null),
    scope = useRef(''),
    requestedSeq = useRef(0)
  const { busy, error, setError, run } = useOperation()
  const page = state?.pages.find(p => p.id === state.activeId)
  /** 整页打不开 / 崩溃：网页区域换成错误页，原生视图藏起来（docs/ui/browser-v2.md §3.1） */
  const failed = page?.failed !== undefined
  const addressRef = useRef<HTMLInputElement>(null)
  const pages = state?.pages ?? []
  const canAddPage = pages.length < 12
  const [port, setPort] = useState('')
  const found = usePortState(target.sessionId).found
  const toast = useToast()
  // ---- 第二批（docs/ui/browser-v2.md §3.2）：控制台抽屉、查找条、清网站数据 ----
  const [consolePrefs, setConsolePrefsState] = useState(readConsolePrefs)
  const setConsolePrefs = (patch: Partial<ConsolePrefs>, save = true) =>
    setConsolePrefsState(prior => {
      const next = { ...prior, ...patch }
      if (save)
        try {
          localStorage.setItem(CONSOLE_PREFS_KEY, JSON.stringify(next))
        } catch {
          // 存不下只影响下次打开
        }
      return next
    })
  const [consoleOpen, setConsoleOpen] = useState(false)
  /** 抽屉里的明细（打开时才取）；null：还没取到 */
  const [entries, setEntries] = useState<BrowserIssueEntry[] | null>(null)
  const [find, setFind] = useState<{ seq: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  const openUrl = (url: string) =>
    run(async () => {
      const same = isPortUrl(url) ? state?.pages.find(p => sameService(p.url, url)) : undefined
      const browser = window.pixelsky!.projectBrowser
      setState(await (same ? browser.select(target, same.id) : browser.navigate(target, null, url)))
    })
  const openPort = (n: number | null) => {
    if (n) void openUrl(portUrl(n)).then(ok => ok && setPort(''))
  }
  useEffect(() => {
    if (demo) return
    let gone = false
    void window
      .pixelsky!.projectBrowser.state(target)
      .then(next => {
        if (!gone) {
          scope.current = next.scope
          setState(next)
        }
      })
      .catch(e => {
        if (!gone) setError(e.message)
      })
    const off = window.pixelsky!.projectBrowser.onChange(next => {
      if (!gone && next.scope === scope.current) setState(next)
    })
    return () => {
      gone = true
      off()
      void window.pixelsky?.projectBrowser.viewport(target, null).catch(() => {})
    }
  }, [])
  // 输入框里点 X 移除批注卡：同样给 6 秒放回
  const hasRemoved = useRemovedAnnotations(target.sessionId)
  useEffect(() => {
    const notes = hasRemoved && target.sessionId ? takeRemovedNotes(target.sessionId) : null
    if (notes && page) setSent({ pageId: page.id, notes })
  }, [hasRemoved, page?.id])
  useEffect(() => {
    if (!sent) return
    const timer = window.setTimeout(() => setSent(null), 6000)
    return () => window.clearTimeout(timer)
  }, [sent])
  useEffect(() => {
    if (
      !requested ||
      requestedSeq.current === requested.seq ||
      !state ||
      demo ||
      JSON.stringify(requested.ref) !== JSON.stringify(target)
    )
      return
    requestedSeq.current = requested.seq
    onHandled?.(requested.seq)
    void openUrl(requested.url)
  }, [requested, state?.scope])
  useEffect(() => {
    if (demo || !page) return
    // 网页视图是盖在窗口上的原生视图，要跟着占位框的位置走。原来每一帧都量一次：窗口因此按屏幕刷新率一直重绘
    // （docs/ui/performance.md）。现在只在可能挪动的时候量：占位框或窗口大小变了、弹窗开关、拖动和过渡动画期间
    // 逐帧跟一小段；另外每半秒兜底量一次（不请求重绘）
    let frame = 0,
      until = 0,
      prior = '',
      stopped = false
    // 弹出层自己变高 / 变宽（展开明细）要重新判断：对当前存在的弹出层挂 ResizeObserver，弹出层没了就摘掉
    const watched = new Set<Element>()
    const overlayResize = new ResizeObserver(() => follow())
    const watchOverlays = (now: Element[]) => {
      for (const el of watched)
        if (!now.includes(el)) {
          overlayResize.unobserve(el)
          watched.delete(el)
        }
      for (const el of now)
        if (!watched.has(el)) {
          watched.add(el)
          overlayResize.observe(el)
        }
    }
    const sync = () => {
      if (stopped) return
      const element = viewport.current,
        r = element?.getBoundingClientRect()
      // 只有模态对话框、设置对话框，或和占位框重叠的弹出层 / 菜单才藏；不挡到网页的不藏
      const overlays = collectOverlays()
      watchOverlays(overlays.map(o => o.element))
      const covered =
        !!r &&
        overlayHidesBrowser(
          r,
          overlays.map(o => o.candidate),
        )
      const placeable =
        !!r &&
        r.width > 40 &&
        r.height > 40 &&
        !document.hidden &&
        r.right <= innerWidth + 1 &&
        r.bottom <= innerHeight + 1
      const visible =
        !failed &&
        placeable &&
        !covered &&
        !!element &&
        pointShowsPlaceholder(element, r.x + r.width / 2, r.y + r.height / 2)
      const rect = visible && r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
      // 只是被挡住（认得出的弹出层，或中心点被别的元素盖着）：藏之前截一张图顶替（定格画面），挡的东西没了再放回真网页
      const freeze = !rect && placeable && !failed
      const hash = JSON.stringify(rect) + ':' + freeze + ':' + page.id
      if (hash === prior) return
      prior = hash
      const fail = (e: Error) => {
        if (!stopped) setError(e.message)
      }
      if (freeze) {
        void window
          .pixelsky!.projectBrowser.viewport(target, null, { freeze: true })
          .then(result => {
            if (!stopped && prior === hash) setSnapshot(result?.snapshot ?? null)
          })
          .catch(fail)
        return
      }
      void window
        .pixelsky!.projectBrowser.viewport(target, rect)
        .then(() => {
          // 真网页放回去之后再撤掉截图，中间不闪
          if (rect) requestAnimationFrame(() => !stopped && prior === hash && setSnapshot(null))
        })
        .catch(fail)
      if (!rect) setSnapshot(null)
    }
    const loop = () => {
      sync()
      frame = !stopped && performance.now() < until ? requestAnimationFrame(loop) : 0
    }
    /** 接下来 ms 毫秒里每帧跟一次（0：下一帧量一次） */
    const follow = (ms = 0) => {
      until = Math.max(until, performance.now() + ms)
      if (!frame) frame = requestAnimationFrame(loop)
    }
    const once = () => follow()
    const transition = () => follow(700)
    const pointer = (e: PointerEvent) => {
      if (e.buttons) follow(150)
    }
    const resize = new ResizeObserver(once)
    if (viewport.current) resize.observe(viewport.current)
    resize.observe(document.body)
    // 菜单、对话框都挂在 body 下面
    const portals = new MutationObserver(once)
    portals.observe(document.body, { childList: true })
    const events: [EventTarget, string, EventListener][] = [
      [window, 'resize', once],
      [document, 'visibilitychange', once],
      [document, 'pointerdown', once],
      [document, 'pointerup', once],
      [document, 'pointermove', pointer as EventListener],
      [document, 'keydown', once],
      [document, 'scroll', once],
      [document, 'transitionrun', transition],
      [document, 'transitionend', once],
      [document, 'animationstart', transition],
      [document, 'animationend', once],
      // 弹出层开关（Popover、Toast、窗口布局……，browserOverlay.ts 的 notifyOverlayChange）：下一帧就量，不等兜底轮询
      [window, OVERLAY_EVENT, once],
    ]
    for (const [t, name, fn] of events) t.addEventListener(name, fn, { capture: true, passive: true })
    const fallback = window.setInterval(sync, 500)
    // 弹出层存在期间（下拉滚动、弹窗只挪位置不变大小，ResizeObserver 看不到）每 150ms 兜底量一次，没有弹出层时不量
    const popoverFallback = window.setInterval(() => {
      if (watched.size) sync()
    }, 150)
    sync()
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      window.clearInterval(fallback)
      window.clearInterval(popoverFallback)
      overlayResize.disconnect()
      resize.disconnect()
      portals.disconnect()
      for (const [t, name, fn] of events) t.removeEventListener(name, fn, { capture: true })
      setSnapshot(null)
      void window.pixelsky?.projectBrowser.viewport(target, null).catch(() => {})
    }
  }, [page?.id, demo, failed])
  const navigate = (url: string) =>
    run(async () => {
      if (demo) return
      setState(await window.pixelsky!.projectBrowser.navigate(target, page?.id ?? null, url))
    })
  const action = (kind: 'back' | 'forward' | 'reload' | 'hardReload' | 'stop' | 'close', id = page?.id) =>
    run(async () => {
      if (!id) return
      if (demo) {
        if (kind === 'close') setState(s => (s ? { ...s, pages: s.pages.filter(p => p.id !== id), activeId: null } : s))
        return
      }
      setState(await window.pixelsky!.projectBrowser.action(target, id, kind))
    })
  const select = (id: string | null) =>
    run(async () => {
      if (demo) setState(s => (s ? { ...s, activeId: id } : s))
      else setState(await window.pixelsky!.projectBrowser.select(target, id))
    })
  const annotate = () =>
    run(async () => {
      if (!page || !note.trim()) return
      if (demo)
        setState(s =>
          s
            ? {
                ...s,
                pages: s.pages.map(p =>
                  p.id === page.id
                    ? {
                        ...p,
                        annotations: [...p.annotations, { id: crypto.randomUUID(), url: p.url, text: note.trim() }],
                      }
                    : p,
                ),
              }
            : s,
        )
      else setState(await window.pixelsky!.projectBrowser.annotate(target, page.id, note))
      setNote('')
    })
  const patchPage = (id: string, change: (p: BrowserPage) => BrowserPage) =>
    setState(s => (s ? { ...s, pages: s.pages.map(p => (p.id === id ? change(p) : p)) } : s))
  const togglePick = () =>
    run(async () => {
      if (!page) return
      const on = !page.picking
      if (demo) patchPage(page.id, p => ({ ...p, picking: on }))
      else setState(await window.pixelsky!.projectBrowser.pick(target, page.id, on, pickConfig()))
    })
  const removeNote = (id: string) =>
    run(async () => {
      if (!page) return
      if (demo) patchPage(page.id, p => ({ ...p, annotations: p.annotations.filter(n => n.id !== id) }))
      else setState(await window.pixelsky!.projectBrowser.removeAnnotation(target, page.id, id))
    })
  const clearNotes = () =>
    run(async () => {
      if (!page) return
      if (demo) patchPage(page.id, p => ({ ...p, annotations: [] }))
      else
        for (const a of page.annotations)
          setState(await window.pixelsky!.projectBrowser.removeAnnotation(target, page.id, a.id))
    })
  /** 「发给会话」：批注从列表移到输入框的批注卡（截图按图片附件），不弹确认框；发送时才合进消息（composeWithAnnotations） */
  const sendToSession = () =>
    run(async () => {
      const sessionId = target.sessionId
      if (!page || !sessionId) return
      const notes = page.annotations,
        prior = getAnnotationDraft(sessionId)
      setAnnotationDraft(sessionId, {
        url: prior?.url ?? notes[0]?.url ?? page.url,
        notes: [...(prior?.notes ?? []), ...notes],
        shots: [...(prior?.shots ?? []), ...notes.flatMap((a, i) => shotImage(a, i + 1) ?? [])].slice(
          0,
          MAX_IMAGE_COUNT,
        ),
      })
      for (const a of notes) setState(await window.pixelsky!.projectBrowser.removeAnnotation(target, page.id, a.id))
      setSent({ pageId: page.id, notes })
    })
  const restoreNotes = () =>
    run(async () => {
      if (!page || !sent) return
      const notes = sent.notes,
        sessionId = target.sessionId,
        draft = sessionId ? getAnnotationDraft(sessionId) : null
      setSent(null)
      if (sessionId && draft) {
        const ids = new Set(notes.map(n => n.id)),
          left = draft.notes.filter(n => !ids.has(n.id))
        setAnnotationDraft(
          sessionId,
          left.length ? { ...draft, notes: left, shots: draft.shots.filter(s => !ids.has(s.id)) } : null,
        )
      }
      for (const a of notes) setState(await window.pixelsky!.projectBrowser.annotate(target, page.id, a.text, a))
    })
  /** 新页面：没有当前页时显示空状态，焦点放进地址栏 */
  const newPage = () => {
    if (!canAddPage) return
    void select(null).then(() => requestAnimationFrame(() => addressRef.current?.focus()))
  }
  const closeOthers = (id: string) =>
    run(async () => {
      if (demo) return setState(s => (s ? { ...s, pages: s.pages.filter(p => p.id === id), activeId: id } : s))
      for (const p of pages)
        if (p.id !== id) setState(await window.pixelsky!.projectBrowser.action(target, p.id, 'close'))
    })
  const duplicate = (p: BrowserPage) =>
    run(async () => {
      if (demo) return
      setState(await window.pixelsky!.projectBrowser.navigate(target, null, p.remoteUrl ?? p.url))
    })
  const openExternal = () =>
    void run(async () => {
      // 远端工作区用本机转发的地址：系统浏览器在这台电脑上
      if (page && !demo) await window.pixelsky!.projectTools.openExternal(page.url)
    })
  // ---- 第二批（docs/ui/browser-v2.md §3.2）----
  const issueKey = page?.issues ? `${page.issues.errors}:${page.issues.requests}:${page.issues.warnings ?? 0}` : ''
  // 抽屉开着时取明细：换页、计数变了（来了新的、清空了）都重新取
  useEffect(() => {
    if (!consoleOpen || !page) return setEntries(null)
    if (demo) return setEntries(page.issues ? demoData().projectTools.browserIssues : [])
    let gone = false
    void window
      .pixelsky!.projectBrowser.issues(target, page.id)
      .then(list => !gone && setEntries(list))
      .catch(() => !gone && setEntries([]))
    return () => {
      gone = true
    }
  }, [consoleOpen, page?.id, issueKey])
  // 换了页面：查找条关掉，上一页的高亮也清掉（不然切回去还是黄的）
  const findOpen = useRef(false)
  findOpen.current = !!find
  useEffect(() => {
    const id = page?.id
    return () => {
      if (!findOpen.current) return
      setFind(null)
      if (id && !demo) void window.pixelsky!.projectBrowser.stopFind(target, id).catch(() => {})
    }
  }, [page?.id])
  /** 控制台的几条放进输入框（不发送），和运行胶囊的「发给 AI」一样（代码模式切到对话、光标跟过去） */
  const quoteIssues = (list: BrowserIssueEntry[]) => {
    if (!page || !list.length) return
    const problem = sendTerminalQuote(entriesQuote(page.remoteUrl ?? page.url, list), tr('terminal.ask.fixPrompt'))
    toast(problem ?? tr('projectTools.consoleQuoted'))
  }
  const clearIssues = () =>
    run(async () => {
      if (!page) return
      if (demo) patchPage(page.id, p => ({ ...p, issues: undefined }))
      else setState(await window.pixelsky!.projectBrowser.clearIssues(target, page.id))
      setEntries([])
    })
  const openFind = () => {
    if (!page || failed) return false
    setFind(f => ({ seq: (f?.seq ?? 0) + 1 }))
    return true
  }
  const closeFind = () => {
    setFind(null)
    if (page && !demo) void window.pixelsky!.projectBrowser.stopFind(target, page.id).catch(() => {})
  }
  const findInPage: FindRequest = (text, opts) => {
    if (!page) return Promise.resolve(null)
    if (demo) return Promise.resolve(text ? { active: 1, total: 3 } : null)
    return window.pixelsky!.projectBrowser.find(target, page.id, text, opts).catch(() => null)
  }
  const zoom = (move: 'in' | 'out' | 'reset') =>
    run(async () => {
      if (!page) return
      if (demo) {
        const steps = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 2],
          now = page.zoom ?? 1,
          next =
            move === 'reset'
              ? 1
              : move === 'in'
                ? (steps.find(z => z > now + 0.001) ?? now)
                : ([...steps].reverse().find(z => z < now - 0.001) ?? now)
        return patchPage(page.id, p => ({ ...p, zoom: next === 1 ? undefined : next }))
      }
      setState(await window.pixelsky!.projectBrowser.zoom(target, page.id, move))
    })
  const devtools = () =>
    run(async () => {
      if (page && !demo) await window.pixelsky!.projectBrowser.devtools(target, page.id)
    })
  /** 截图放进输入框当图片附件（docs/ui/browser-v2.md §3.2），提示里可以撤销 */
  const capture = (full: boolean, fromMenu: boolean) =>
    run(async () => {
      if (!page || demo || failed) return
      const t = composerTarget()
      if (!t) throw new Error(tr('editor.quote.noSession'))
      // 菜单盖着网页时网页视图是藏起来的：等菜单关掉、网页放回去再截
      if (fromMenu) await new Promise(r => setTimeout(r, 250))
      const shot = await window.pixelsky!.projectBrowser.capture(target, page.id, full)
      const image = captureAttachment(shot, captureName(page.remoteUrl ?? page.url, Date.now()), crypto.randomUUID())
      let problem: ReturnType<typeof attachmentProblem> = null
      await updateImages(t.key, current => {
        problem = attachmentProblem(current, image)
        return problem ? current : [...current, image]
      })
      if (problem) throw new Error(tr(problem))
      toast(
        shot.truncated
          ? tr('projectTools.captureTruncated', { max: BROWSER_CAPTURE_MAX_HEIGHT })
          : tr('projectTools.captureAdded'),
        {
          action: {
            label: tr('projectTools.undo'),
            run: () => void updateImages(t.key, list => list.filter(i => i.id !== image.id)).catch(() => {}),
          },
        },
      )
    })
  const clearSiteData = () =>
    run(async () => {
      if (!page || demo) return
      const host = plainAddress(page.remoteUrl ?? page.url).split('/')[0]
      setState(await window.pixelsky!.projectBrowser.clearSiteData(target, page.id))
      setClearing(false)
      toast(tr('projectTools.siteDataCleared', { host }))
    })
  /** 浏览器快捷键（docs/ui/browser-v2.md §3.1、§3.2）；返回是否处理了 */
  const shortcut = (key: BrowserShortcut): boolean => {
    if (key === 'address') {
      addressRef.current?.focus()
      addressRef.current?.select()
    } else if (key === 'newPage') newPage()
    else if (!page) return false
    else if (key === 'closePage') void action('close')
    else if (key === 'find') return openFind()
    else if (key === 'zoomIn' || key === 'zoomOut' || key === 'zoomReset')
      void zoom(key === 'zoomIn' ? 'in' : key === 'zoomOut' ? 'out' : 'reset')
    else if (key === 'devtools') {
      if (demo) return false
      void devtools()
    } else void action(key)
    return true
  }
  const shortcutRef = useRef(shortcut)
  shortcutRef.current = shortcut
  // 网页有焦点时主进程截下来转过来的
  useEffect(() => {
    if (demo) return
    return window.pixelsky?.projectBrowser.onKey(e => {
      if (e.scope === scope.current) shortcutRef.current(e.shortcut)
    })
  }, [demo])
  useEffect(() => {
    const el = root.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 560))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Esc 退出选取（网页拿到焦点时由网页里的脚本处理）
  useEffect(() => {
    if (!page?.picking) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) void togglePick()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page?.picking, page?.id])
  // 编号标记、小框的颜色跟着当前主题：打开有批注的页面时把配色再交给主进程
  useEffect(() => {
    if (demo || !page || !(page.picking || page.annotations.some(a => a.selector))) return
    void window
      .pixelsky!.projectBrowser.pick(target, page.id, !!page.picking, pickConfig())
      .then(setState)
      .catch(() => {})
  }, [page?.id])
  return (
    <div
      ref={root}
      data-tools-browser
      className="flex min-h-0 flex-1 flex-col gap-2 p-3"
      onKeyDown={e => {
        if (e.defaultPrevented || e.nativeEvent.isComposing) return
        const key = browserShortcut(
          { key: e.key, code: e.code, mod: isMac ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey },
          isMac,
        )
        // 处理了就不再往外传：Ctrl+W 关的是网页，不是右栏的浏览器标签
        if (key && (e.repeat || shortcut(key))) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {showPageTabs(pages, state?.activeId ?? null) && (
        <BrowserPageTabs
          pages={pages}
          activeId={state?.activeId ?? null}
          busy={busy}
          canAddPage={canAddPage}
          onSelect={id => void select(id)}
          onClose={id => void action('close', id)}
          onNewPage={newPage}
          onReload={id => void action('reload', id)}
          onDuplicate={p => void duplicate(p)}
          onCloseOthers={id => void closeOthers(id)}
        />
      )}
      <BrowserToolbar
        page={page}
        wide={wide}
        tabs={showPageTabs(pages, state?.activeId ?? null)}
        canAddPage={canAddPage}
        busy={busy}
        demo={demo}
        ports={found}
        recent={state?.recent ?? []}
        titles={new Map(pages.map(p => [p.remoteUrl ?? p.url, p.title]))}
        addressRef={addressRef}
        onNavigate={url => void navigate(url)}
        onAction={kind => void action(kind)}
        onTogglePick={() => void togglePick()}
        onNewPage={newPage}
        onOpenExternal={openExternal}
        issueCount={issueCount(page, consolePrefs.warnings)}
        consoleOpen={consoleOpen}
        onToggleConsole={() => setConsoleOpen(o => !o)}
        onCapture={(full, fromMenu) => void capture(full, fromMenu)}
        onFind={openFind}
        onZoom={move => void zoom(move)}
        onDevtools={() => void devtools()}
        onClearSiteData={() => {
          // 确认框里只显示这次清除的错误
          setError('')
          setClearing(true)
        }}
      />
      {find && page && <BrowserFindBar focusSeq={find.seq} onFind={findInPage} onClose={closeFind} />}
      {/* 整页打不开时原因在错误页里，这里只放操作出错和批注上限之类 */}
      <ToolError error={error || (failed ? '' : page?.error) || ''} />
      <div className={cn('flex min-h-0 flex-1 gap-2', DOCK_FLOW[placed])}>
        {/* min-h-0：控制台抽屉拖得很高、窗口又矮时，这一列能缩，抽屉按剩下的高度封顶（不把批注栏挤出去） */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <div
            ref={viewport}
            data-browser-viewport
            className="relative flex min-h-24 flex-1 flex-col overflow-hidden rounded-lg border border-line-card bg-surface"
          >
            {snapshot && (
              <img
                src={snapshot}
                alt=""
                aria-hidden
                data-browser-snapshot
                draggable={false}
                className="pointer-events-none absolute inset-0 z-[1] size-full select-none"
              />
            )}
            {page && failed ? (
              <BrowserErrorPage
                page={page}
                ports={found}
                busy={busy}
                demo={demo}
                onRetry={() => void action('reload')}
                onOpenExternal={openExternal}
                onOpenPort={n => void navigate(portUrl(n))}
              />
            ) : demo && page ? (
              <PreviewViewport />
            ) : (
              <div className="pointer-events-none flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-meta text-fg-muted">
                <Globe size={24} />
                <p>
                  {page
                    ? tr(page.loading ? 'projectTools.loading' : 'projectTools.browserTitle')
                    : tr('projectTools.browserEmpty')}
                </p>
                {!page && <p>{tr('projectTools.browserEmptyHint')}</p>}
                {!page && !demo && (
                  <div data-port-entry className="pointer-events-auto mt-2 flex w-full max-w-72 flex-col gap-2">
                    <p>{tr('portTip.manualHint')}</p>
                    <form
                      className="flex gap-1"
                      onSubmit={e => {
                        e.preventDefault()
                        openPort(parsePort(port))
                      }}
                    >
                      <label className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-line bg-surface px-2.5 font-mono text-list focus-within:border-accent">
                        <span className="text-fg-faint">localhost:</span>
                        <input
                          inputMode="numeric"
                          value={port}
                          onChange={e => setPort(e.target.value)}
                          placeholder={tr('portTip.portPlaceholder')}
                          aria-label={tr('portTip.portPlaceholder')}
                          title={tr('portTip.portInvalid')}
                          className="min-w-0 flex-1 bg-transparent text-fg outline-none"
                        />
                      </label>
                      <Button type="submit" disabled={busy || parsePort(port) === null}>
                        {tr('projectTools.go')}
                      </Button>
                    </form>
                    {found.length > 0 && (
                      <div className="text-left text-fg-faint">
                        {tr('portTip.found')}
                        <div className="mt-1 flex flex-wrap gap-1">
                          {found.map(f => (
                            <button
                              key={f.port}
                              type="button"
                              disabled={busy}
                              onClick={() => openPort(f.port)}
                              className="rounded-sm bg-subtle px-1.5 font-mono text-fg-secondary hover:bg-hover"
                            >
                              :{f.port}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {(state?.recent?.length ?? 0) > 0 && (
                      <div data-browser-recent className="text-left text-fg-faint">
                        {tr('projectTools.recentPages')}
                        <div className="mt-1 flex flex-col">
                          {state!.recent!.slice(0, 5).map(url => (
                            <button
                              key={url}
                              type="button"
                              disabled={busy}
                              title={url}
                              onClick={() => void openUrl(url)}
                              className="flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-fg-secondary hover:bg-hover"
                            >
                              <Clock size={12} className="shrink-0 text-fg-faint" />
                              <span className="truncate font-mono">{plainAddress(url)}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {consoleOpen && page && (
            <BrowserConsole
              entries={entries}
              prefs={consolePrefs}
              busy={busy}
              onPrefs={setConsolePrefs}
              onClose={() => setConsoleOpen(false)}
              onClear={() => void clearIssues()}
              onQuote={quoteIssues}
            />
          )}
        </div>
        {page && (
          <ElementNotes
            page={page}
            dock={placed}
            fallback={placed !== dockPrefs.dock}
            busy={busy}
            canSend={!!target.sessionId && !demo}
            note={note}
            sent={sent}
            onNote={setNote}
            onAnnotate={() => void annotate()}
            onRemove={id => void removeNote(id)}
            onClear={() => void clearNotes()}
            onSend={() => void sendToSession()}
            onRestore={() => void restoreNotes()}
          />
        )}
      </div>
      {clearing && page && (
        <ConfirmDialog
          title={tr('projectTools.clearSiteTitle', { host: plainAddress(page.remoteUrl ?? page.url).split('/')[0] })}
          description={tr('projectTools.clearSiteBody')}
          confirmLabel={tr('projectTools.clearSiteConfirm')}
          cancelLabel={tr('projectTools.cancel')}
          busy={busy}
          error={error}
          danger
          onConfirm={() => void clearSiteData()}
          onCancel={() => setClearing(false)}
        />
      )}
    </div>
  )
}
