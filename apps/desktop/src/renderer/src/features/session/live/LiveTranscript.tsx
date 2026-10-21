import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
// 真实会话的对话流：按「轮」排列条目，每轮的过程收成一行「执行」（docs/ui/conversation-concise.md），
// 里面连续的工具调用串成一组；每轮结束后显示改动文件卡片
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { TurnRail } from './TurnRail'
import { markTurnReviewed, useTurnReviewed } from '@/features/coding/review'
import { reuseTurns, turnsOf, type Turn } from './turnRailModel'
import { useTurnRailOn } from '@/features/settings/turnRail'
import { useTranscriptWindowSize } from '@/features/settings/longConversation'
import { useSubagentView } from '@/features/settings/subagentView'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import {
  hiddenCount,
  initialHidden,
  reclaimHidden,
  revealEarlier,
  revealFor,
  startIndex,
  turnStarts,
} from './transcriptWindow'
import {
  anchorOf,
  placeOf,
  registerTranscriptView,
  restoredHidden,
  savePlace,
  scrollToPlace,
  type TranscriptPlace,
} from './transcriptPlaces'
import { useLightweight } from '@/features/recovery/lightweight'
import { isSubagentCall, isSubagentWork, viaGateway, type Item, type SessionSnapshot } from '@pixelsky/protocol'
import { Spinner, cn } from '@/ui'
import type { ChangedFiles } from '@/data'
import { ChangedFilesCard } from '../ChangedFilesCard'
import { TurnStats } from '../TurnStats'
import { Markdown } from '@/ui/markdown/Markdown'
import { NoticeRow, ReasoningBlock, TodoCard, ToolItemRow, UserBubble } from './ItemRows'
import { CompactionRow } from './CompactionRow'
import { CompactionLiveContext, type CompactionLive } from './compactionLive'
import { isReconnecting, isStarting } from '../queueView'
import { reconnectView } from './reconnectView'
import { DismissedNote, ReconnectLine } from './ReconnectRows'
import { NoticeActions } from './NoticeActions'
import { AssistantMessageActions, UserMessageActions } from './MessageActions'
import { platformNoticeText } from './errorKind'
import { useItemLocation } from '@/features/search/useItemLocation'
import { ExpandScope } from '@/features/search/expand'
import { DETACH_EVENT, useItemNavigation } from '@/features/search/navigation'
import { JumpToLatest } from './JumpToLatest'
import {
  afterGlideCancel,
  afterResize,
  contentMark,
  innerCanScrollUp,
  nearBottom,
  scrollUpKey,
  scrolledUp,
  type ScrollPos,
} from './scrollFollow'
import { glideToEnd } from './glide'
import { motionEnabled } from '@/features/panes/motion'
import { changesHeight, errorNoticeHeight, itemHeight, processHeight, SUBAGENT_BOX, toolsHeight } from './blockHeight'
import { reviewTurn } from '@/features/panel/artifacts/focus'
import { turnReplies } from './turnFold'
import { innerBlocks, sameItems, toBlocks, type Block, type ChangesCache } from './changeBlocks'
import { TurnProcess } from './TurnProcess'
import { SubagentCompletionBox, SubagentDispatchBox } from './SubagentBox'
import { approvalWaiting } from './subagentBoxModel'
import { LiveStatusLine } from './LiveStatusLine'
import { LiveOwnerContext } from './liveOwner'
import { useNativeCheck } from '@/features/resume/useNativeCheck'
import { loadingImportedEngine } from '@/features/resume/model'
import { RESUME_ENGINE_NAMES } from '@/features/resume/store'

/** 块没渲染过时的占位高度（content-visibility，见 blockHeight.ts）；按条目对象缓存，流式输出时只重算在动的那一条 */
const heights = new WeakMap<Item, number>()
function estimate(item: Item): number {
  let height = heights.get(item)
  if (height === undefined) heights.set(item, (height = itemHeight(item)))
  return height
}
const placeholder = (px: number): CSSProperties => ({ containIntrinsicBlockSize: `auto ${px}px` })

// 下面几个显示组件都 memo：条目对象没变（protocol 的 reduce 只替换变了的那一条）就不重新渲染，
// 流式输出时只有最后一条在动（docs/ui/conversation-ux.md §2.7）
const ItemView = memo(function ItemView({
  item,
  reply,
  sessionId,
  reconnectFailed,
}: {
  item: Item
  reply?: string
  sessionId?: string | null
  /** 断线自动重连的小字：重连后这一轮还是出错了（reconnectView.ts） */
  reconnectFailed?: boolean
}) {
  useI18n()
  switch (item.kind) {
    case 'user':
      if (item.reconnect) return <ReconnectLine attempt={item.reconnect} failed={!!reconnectFailed} />
      if (item.dismissed)
        return (
          <>
            <div className="opacity-55">
              <UserBubble item={item} actions={<UserMessageActions item={item} />} />
            </div>
            <DismissedNote item={item} sessionId={sessionId} />
          </>
        )
      return <UserBubble item={item} actions={<UserMessageActions item={item} />} />
    case 'assistant':
      if (!item.text) return null
      return (
        <>
          <Markdown text={item.text} streaming={item.status === 'running'} />
          {item.status === 'interrupted' && (
            <div className="mt-1.5 text-meta text-fg-faint">{tr('session.live.ItemRows.interrupted')}</div>
          )}
        </>
      )
    case 'reasoning':
      return <ReasoningBlock item={item} />
    case 'todo':
      return <TodoCard item={item} />
    case 'notice':
      return <NoticeRow item={item} sessionId={sessionId} />
    case 'compaction':
      return <CompactionRow item={item} />
    case 'turn_stats':
      // 这一轮回复的「复制」放在统计行最前面，不额外占一行
      return (
        <TurnStats
          usage={item.usage}
          className="conversation-message -mt-1 px-0.5"
          leading={reply ? <AssistantMessageActions text={reply} /> : undefined}
        />
      )
    default:
      return null
  }
})

const TurnChanges = memo(function TurnChanges({
  data,
  sessionId,
  turnKey,
}: {
  data: ChangedFiles
  sessionId: string | null
  turnKey: string
}) {
  const target = useMemo(() => (sessionId ? { sessionId } : undefined), [sessionId])
  // 分组时每组多一行小标题
  const style = useMemo(
    () =>
      placeholder(
        changesHeight(data.groups ? data.groups.reduce((n, g) => n + g.files.length + 1, 0) : data.files.length),
      ),
    [data],
  )
  // 「审查」：在右侧「产物」里打开这一轮的改动（docs/ui/conversation-ux.md §2.1）
  const review = useMemo(
    () => (sessionId ? () => reviewTurn(sessionId, turnKey === 'start' ? null : turnKey) : undefined),
    [sessionId, turnKey],
  )
  const keepAll = useMemo(
    () => (sessionId ? () => markTurnReviewed(sessionId, turnKey) : undefined),
    [sessionId, turnKey],
  )
  // 点过「全部保留」后按钮收起
  const kept = useTurnReviewed(sessionId, turnKey)
  return (
    <ChangedFilesCard
      className="conversation-message"
      data={data}
      target={target}
      style={style}
      onReview={review}
      onKeepAll={kept ? undefined : keepAll}
    />
  )
})

/**
 * 执行块：里面的条目对象都没变（流式输出时只有最后一轮在变）就不重新渲染。
 * render 每次都是新函数，不比较；里面的显示只依赖条目和搜索高亮
 */
const ProcessBlock = memo(
  function ProcessBlock({
    foldKey,
    items,
    running,
    durationMs,
    toggled,
    onToggle,
    render,
  }: {
    foldKey: string
    items: Item[]
    running: boolean
    durationMs: number | null
    /** 「执行」展开状态（null：没点过）；放在外面是因为运行中底部的状态行也能展开它 */
    toggled: boolean | null
    onToggle: (key: string, open: boolean) => void
    highlight: string | null
    render: (items: Item[]) => ReactNode
  }) {
    const toggle = useCallback((open: boolean) => onToggle(foldKey, open), [onToggle, foldKey])
    // 没画过时的占位高度要按展开 / 收起算：极简模式默认展开，按收起的一行估会让滚动时总高度不停变、滑块乱跳
    const minimal = useMinimal()
    const open = toggled ?? minimal
    const style = useMemo(() => placeholder(processHeight(items, open, running)), [items, open, running])
    return (
      <div className="conversation-message" style={style}>
        <TurnProcess
          items={items}
          running={running}
          durationMs={durationMs}
          toggled={toggled}
          onToggle={toggle}
          render={render}
        />
      </div>
    )
  },
  (a, b) =>
    a.running === b.running &&
    a.toggled === b.toggled &&
    a.onToggle === b.onToggle &&
    a.durationMs === b.durationMs &&
    a.highlight === b.highlight &&
    sameItems(a.items, b.items),
)

const NO_ITEMS: readonly Item[] = []

export function LiveTranscript({
  snapshot,
  header,
  footer,
}: {
  snapshot: SessionSnapshot | null
  header?: ReactNode
  /** 对话末尾（最后一轮后面）：极简模式下运行中的计划（InlinePlan） */
  footer?: ReactNode
}) {
  useI18n()
  const scroller = useRef<HTMLDivElement>(null)
  const stream = useRef<HTMLDivElement>(null)
  // stick：新内容到达时滚到底；detached：搜索跳转后暂时不按位置重新判断 stick，直到用户自己滚动或操作
  const stick = useRef(true)
  const detached = useRef(false)
  // 回到最新（docs/ui/conversation-ux.md §2.4）：away 离开了底部，unseen 离开后又来了新内容
  const [away, setAway] = useState(false)
  const [unseen, setUnseen] = useState(false)
  // 最近一次在对话里点或按键的时间：之后很短时间内对话流变高（例如展开工具输出）不跟到底
  const lastInteract = useRef(0)
  // 点「回到最新」后的平滑滚动期间，不按中途位置改 stick
  const jumping = useRef(false)
  // 正在进行的「回到最新」滑动的取消函数（glide.ts）；结束、被打断、切换会话、卸载时清掉
  const glide = useRef<(() => void) | null>(null)
  // released：用户自己往上滚了（滚轮、触控板、按键、拖滚动条）。一往上就不再跟到底，哪怕还在离底部 80px 以内——
  // 否则 AI 输出时每一格滚轮还没滚出 80px 就被新内容拽回底部，表现成「滑不上去」。
  // 用户往下滚回底部附近、点「回到最新」、切换会话时才恢复
  const released = useRef(false)
  const lastPos = useRef<ScrollPos | null>(null)
  const release = (): void => {
    released.current = true
    stick.current = false
  }
  // 元素外发起的滚动（搜索跳转、显示更早、轮次条拖动 / 点击 / 跳转）：先打断「回到最新」的滑动，
  // 不然它会继续往底部推、最后还强行写到底。先于下面改 stick，打断回调里的重算才不会盖掉它
  const cancelGlide = useCallback(() => glide.current?.(), [])
  const detachForSearch = useCallback(() => {
    cancelGlide()
    stick.current = false
    detached.current = true
  }, [cancelGlide])
  const highlight = useItemLocation(snapshot?.record.id ?? null, scroller, !!snapshot, detachForSearch)
  const running = !!snapshot && snapshot.state !== 'idle'
  const items = snapshot?.items ?? []
  // 轮次跳转条（docs/ui/turn-rail.md）
  const showTurns = useTurnRailOn()
  const sessionId = snapshot?.record.id ?? null
  // 导入的终端会话（原地接着的）：打开 / 窗口回到前台时查终端里有没有又聊了新的
  // 只在执行者还是导入的那个引擎、还在接着导入的会话（或复制出来还没启动）时写「正在加载 X 会话」，引擎名取正在启动的执行者
  const importedEngine = loadingImportedEngine(snapshot?.record)
  useNativeCheck(sessionId, !!snapshot?.record.imported && !snapshot.record.imported.forked)

  // 长对话只显示最近几轮（docs/ui/turn-rail.md §9）：win.hidden 是从头隐藏了几轮。
  // 打开这个会话时按设置算一次，之后变少（点「显示更早的」、跳转到隐藏的内容）；新的轮次往后加不会把已显示的藏回去，
  // 只有新一轮开始、用户停在底部时才收回（见下面 reclaimHidden 的 effect，A7）
  const windowSize = useTranscriptWindowSize()
  const [win, setWin] = useState<{ sessionId: string | null; hidden: number } | null>(null)
  const starts = useMemo(() => turnStarts(snapshot?.items ?? []), [snapshot?.items])
  // 标签卸载过再挂载：沿用卸载前显示的轮数（transcriptPlaces.ts）；轻量模式下最多只显示设置的轮数
  const capped = useLightweight()
  const saved = placeOf(sessionId)
  const wanted =
    snapshot && snapshot.items.length > 0
      ? restoredHidden(
          saved?.hidden ?? null,
          initialHidden(starts.length, windowSize),
          windowSize,
          capped,
          saved?.atBottom ?? false,
        )
      : 0
  const opened = !!win && win.sessionId === sessionId
  if (snapshot && snapshot.items.length > 0 && !opened) setWin({ sessionId, hidden: wanted })
  const hidden = opened && windowSize !== null ? win.hidden : opened ? 0 : wanted
  const hiddenTurns = hiddenCount(starts.length, hidden)
  // 卸载前的位置：不能卸载时再读 DOM（标签已经隐藏），所以滚动停下后记锚点，卸载时只写最后记下的
  const placeRef = useRef<
    { sessionId: string | null; hidden: number; atBottom: boolean } & Pick<TranscriptPlace, 'anchor' | 'scrollTop'>
  >({
    sessionId: null,
    hidden: 0,
    atBottom: true,
    anchor: null,
    scrollTop: 0,
  })
  const shownTurns = useRef(0)
  shownTurns.current = Math.max(0, starts.length - hiddenTurns)
  // 内容还没到（快照在拉）时 hidden 只是占位的 0：沿用已保存的位置，等内容到了再更新，免得此时切走把它覆盖掉
  if (placeRef.current.sessionId !== sessionId)
    placeRef.current = {
      atBottom: true,
      anchor: null,
      scrollTop: 0,
      ...saved,
      hidden: saved?.hidden ?? hidden,
      sessionId,
    }
  if (opened) placeRef.current.hidden = hidden
  const placeTimer = useRef<number>(0)
  const firstShown = startIndex(starts, hidden)
  const shownItems = useMemo(
    () => (firstShown > 0 && snapshot ? snapshot.items.slice(firstShown) : (snapshot?.items ?? [])),
    [snapshot, firstShown],
  )
  // 轮次只取决于用户消息，流式输出时每个快照都重新算一份；(id, n, preview) 没变就沿用上一份的引用，
  // TurnRail 里依赖 turns 的 effect 才不会每帧重跑（A6）
  const lastTurns = useRef<Turn[]>([])
  const turns = useMemo(() => {
    const list = turnsOf(shownItems)
    return (lastTurns.current = reuseTurns(
      lastTurns.current,
      hiddenTurns > 0 ? list.map(t => ({ ...t, n: t.n + hiddenTurns })) : list,
    ))
  }, [shownItems, hiddenTurns])
  // 子智能体显示成小框，还是展开在执行里（docs/ui/subagent-box.md）
  const subagents = useSubagentView()
  const minimal = useMinimal()
  const changesCache = useRef<{ sessionId: string | null; map: ChangesCache }>({ sessionId: null, map: new Map() })
  // 断线自动重连：自动发的「继续」显示成一行小字，接着重连了的那几次断线报错不显示
  const pendingReconnect = !!snapshot?.queue.some(isReconnecting)
  const reconnects = useMemo(() => reconnectView(shownItems, pendingReconnect), [shownItems, pendingReconnect])
  const blocks = useMemo(() => {
    if (changesCache.current.sessionId !== sessionId) changesCache.current = { sessionId, map: new Map() }
    return toBlocks(reconnects.items, running, changesCache.current.map, { subagents })
  }, [reconnects, running, sessionId, subagents])
  // 每轮统计行对应的回复：和显示在外面的「最后的回复」是同一段（中间穿插工具调用的过渡话不算）
  const replies = useMemo(() => turnReplies(reconnects.items, { subagents }), [reconnects, subagents])
  // 子智能体要批准时，它的小框写「等你批准」
  const pending = snapshot?.pending
  const approving = useMemo(
    () => (subagents === 'box' && pending?.length ? approvalWaiting(shownItems, pending) : null),
    [subagents, shownItems, pending],
  )

  // 小框模式下子智能体自己的工具调用不显示，判断「最后一条」和底部状态行写什么时都要跳过
  const shownAll = snapshot?.items ?? NO_ITEMS
  const visible = useMemo(
    () => (subagents === 'box' ? shownAll.filter(it => !isSubagentWork(it)) : shownAll),
    [shownAll, subagents],
  )
  const last = visible[visible.length - 1]
  // 正在压缩时压缩条自己带计时，不再叠一行状态
  const compacting = last?.kind === 'compaction' && last.status === 'running'
  // 进行中的压缩那一行要的会话状态（网关进度、重试等待、中断这一轮）；条目列表是 memo 的，经 context 传过去
  const compactionRecord = snapshot?.record
  const compactionExecution = snapshot?.execution
  const compactionTurn = snapshot?.turnId ?? null
  const compactionProgress = snapshot?.compaction ?? null
  const compactionRetry = snapshot?.retry ?? null
  const compactionLive = useMemo<CompactionLive | null>(() => {
    if (!compactionRecord) return null
    const source = compactionExecution ?? compactionRecord
    return {
      sessionId: compactionRecord.id,
      turnId: compactionTurn,
      progress: compactionProgress,
      retry: compactionRetry,
      gateway: (compactionExecution?.engine ?? compactionRecord.engine) === 'claude' && viaGateway(source),
    }
  }, [compactionRecord, compactionExecution, compactionTurn, compactionProgress, compactionRetry])
  // 运行中底部一直有一行状态（转圈 + 在做什么 + 本轮用时 + ›）；等你批准 / 回答时（state 为 waiting）不显示，
  // 免得一边写「正在……」一边在等你，批准卡片自己就是提示。
  // 状态行显示时它独占「在动」：上面还在跑的行（工具、思考、子智能体小框）不再脉冲 / 闪光 / 自己计时（liveOwner.ts）
  const showLive = snapshot?.state === 'running' && !compacting
  // 「执行」块的展开状态：状态行末尾的 › 展开的就是最后一个还在运行的执行块
  const [folds, setFolds] = useState<Record<string, boolean>>({})
  const setFold = useCallback(
    (key: string, open: boolean) => setFolds(prev => (prev[key] === open ? prev : { ...prev, [key]: open })),
    [],
  )
  const liveProcess = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === 'process' && b.running) return b.key
    }
    return null
  }, [blocks])
  const liveOpen = liveProcess !== null && (folds[liveProcess] ?? minimal)
  const liveFold = liveProcess !== null ? { open: liveOpen, toggle: () => setFold(liveProcess, !liveOpen) } : null
  // 空闲时直接发送的消息在引擎启动期间先显示在对话里（不是排队），开始执行后由正式的用户消息替换
  const starting = snapshot ? snapshot.queue.filter(q => isStarting(q, snapshot.queuePaused)) : []

  // 最近一轮（最后一条用户消息之后）的最后一条错误：给一键按钮（docs/ui/source-switch.md §3.5）
  let actionNoticeId: string | null = null
  let turnStart: number | null = null
  if (!running) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === 'user') break
      if (it.kind === 'notice' && it.level === 'error') {
        actionNoticeId = it.id
        break
      }
    }
    // 「查看日志」从这一轮的用户消息时间筛起（docs/ui/logging.md §3.2）
    if (actionNoticeId)
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]
        if (it.kind === 'user' && it.mode !== 'guidance') {
          turnStart = it.createdAt
          break
        }
      }
  }

  useLayoutEffect(() => {
    const el = scroller.current
    // 「回到最新」滑动期间不在这里直接贴到底：那会把滑动变成一步到位，glide 还会把它当外部写入；让 glide 每帧追
    if (el && stick.current && !jumping.current) el.scrollTop = el.scrollHeight
  }, [blocks, showLive, starting.length])

  // 显示更早的一批：补出来的内容在上面，屏幕上正在看的位置不动。
  // 记下补之前最上面那条可见条目的位置，补完在布局阶段把滚动位置加上它挪动的距离（不依赖浏览器自己的滚动锚定）
  const keepPlace = useRef<{ el: HTMLElement; top: number } | null>(null)
  const showEarlier = (step: number | null): void => {
    const el = scroller.current
    if (!el || hidden <= 0) return
    const next = revealEarlier(hidden, step)
    if (next === hidden) return
    const box = el.getBoundingClientRect()
    for (const row of el.querySelectorAll<HTMLElement>('[data-search-item]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom > box.top + 1) {
        keepPlace.current = { el: row, top: rect.top - box.top }
        break
      }
    }
    // 先不贴底：补出来的内容会让对话流变高，不能被当成新内容又拽回底部
    detachForSearch()
    setWin({ sessionId, hidden: next })
  }
  useLayoutEffect(() => {
    const place = keepPlace.current
    const el = scroller.current
    if (!place || !el) return
    keepPlace.current = null
    if (place.el.isConnected)
      el.scrollTop += place.el.getBoundingClientRect().top - el.getBoundingClientRect().top - place.top
  }, [firstShown])

  // 要跳到的条目在隐藏的部分（全局搜索、从别处打开对话并定位）：先展开到它所在那一轮，再由 useItemLocation 找它
  const navigation = useItemNavigation()
  useLayoutEffect(() => {
    if (!navigation || navigation.sessionId !== sessionId || !snapshot || hidden <= 0) return
    const next = revealFor(snapshot.items, starts, hidden, navigation.itemId)
    if (next === hidden) return
    detachForSearch()
    setWin({ sessionId, hidden: next })
  }, [navigation, sessionId, snapshot, starts, hidden, detachForSearch])

  // 对话内搜索等程序滚动之前会先发 DETACH_EVENT：和搜索跳转一样暂时不贴底
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    el.addEventListener(DETACH_EVENT, detachForSearch)
    return () => el.removeEventListener(DETACH_EVENT, detachForSearch)
  }, [detachForSearch])

  // 切换会话时回到底部
  useLayoutEffect(() => {
    // 先打断旧会话的滑动（它的回调会按位置重算 stick），再置位
    glide.current?.()
    stick.current = true
    released.current = false
    lastPos.current = null
    detached.current = false
    jumping.current = false
    setAway(false)
    setUnseen(false)
  }, [snapshot?.record.id])

  // 标签卸载后重新挂载：第一次拿到这个会话的内容时，不在底部的回到卸载前的位置（在底部的照旧贴底）。
  // 要排在上面「贴底」和「切换会话」两个 effect 后面；正在有搜索跳转时让跳转优先
  const restoredFor = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!opened || !sessionId || restoredFor.current === sessionId) return
    restoredFor.current = sessionId
    const place = placeOf(sessionId),
      el = scroller.current
    if (!place || place.atBottom || !el || navigation?.sessionId === sessionId) return
    scrollToPlace(el, place)
    stick.current = false
    released.current = true
    setAway(true)
  }, [opened, sessionId, navigation])

  // 新一轮开始、用户停在底部时把窗口收回（A7，D121）：点过「显示全部 / 显示更早的」、搜索跳转展开过的部分不会一直挂在 DOM 上。
  // 只在轮数增加的那一次判断，不用计时器：用户往上翻（released）、搜索跳转 / 回到最新的滑动中、对话内搜索开着时绝不收回，
  // 错过了就等下一轮。收回的是上面很远处的内容，用户在底部，位置不受影响（对话流变矮不算往上滚，见 scrolledUp）
  const startsSeen = useRef<{ sessionId: string | null; count: number }>({ sessionId: null, count: 0 })
  useLayoutEffect(() => {
    const seen = startsSeen.current
    startsSeen.current = { sessionId, count: starts.length }
    if (!opened || seen.sessionId !== sessionId || starts.length <= seen.count) return
    if (!stick.current || released.current || detached.current || jumping.current || navigation) return
    if (scroller.current?.closest('.conversation-view')?.querySelector('[data-conversation-find]')) return
    const next = reclaimHidden(starts.length, hidden, windowSize)
    if (next === null) return
    placeRef.current.hidden = next
    setWin({ sessionId, hidden: next })
  }, [starts.length, opened, sessionId, hidden, windowSize, navigation])

  // 卸载时把最后记下的位置写进去；挂着期间登记给内存遥测
  useEffect(() => {
    const unregister = registerTranscriptView(() => shownTurns.current)
    return () => {
      unregister()
      glide.current?.()
      window.clearTimeout(placeTimer.current)
      const last = placeRef.current
      if (last.sessionId) savePlace(last.sessionId, last)
    }
  }, [])

  // 离开底部期间条目增加或最后一条变长：「回到最新」变成「新内容」
  const mark = contentMark(items)
  const seenMark = useRef(mark)
  useEffect(() => {
    if (seenMark.current === mark) return
    seenMark.current = mark
    if (!stick.current) setUnseen(true)
  }, [mark])

  // 对话流高度变了（公式加载完、图片解码、输入框变高）：贴底时跟到底。
  // 用户刚点过或按过键（多半是展开了什么）就不跟，按实际位置重新判断，之后的新内容也不会把展开的内容顶上去
  useEffect(() => {
    const el = scroller.current,
      content = stream.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (jumping.current) return
      const next = afterResize(
        el,
        stick.current,
        detached.current || released.current,
        lastInteract.current,
        performance.now(),
      )
      if (next.follow) {
        el.scrollTop = el.scrollHeight
        return
      }
      stick.current = next.stick
      setAway(next.away)
      if (!next.away) setUnseen(false)
    })
    observer.observe(content)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const jumpToLatest = (): void => {
    const el = scroller.current
    if (!el) return
    // 上一次滑动还没结束就先打断（它的结束回调会清 jumping、按位置重算 stick，所以要在置位之前）
    glide.current?.()
    stick.current = true
    released.current = false
    detached.current = false
    setUnseen(false)
    jumping.current = true
    // 滑动交给 glide.ts：每帧按当前高度重算终点，离得远先跳到离底 1.5 屏处再缓动；动画关了直接到底。
    // jumping 在它的结束 / 打断回调里清掉（不等 scrollend，那个事件可能永远不来），glide 自带超时保险
    const cancel = glideToEnd(el, {
      motion: motionEnabled(),
      onEnd: reason => {
        glide.current = null
        jumping.current = false
        // 被打断：位置交给用户，按实际位置重算贴底和按钮（不然预先置的 stick 会让下一段流式内容又拽回底部）
        if (reason !== 'done') {
          const next = afterGlideCancel(el, stick.current, detached.current, released.current)
          stick.current = next.stick
          setAway(next.away)
          if (!next.away) setUnseen(false)
          return
        }
        // 滑动期间又来了内容：补到真正的底部
        if (stick.current) el.scrollTop = el.scrollHeight
        const near = nearBottom(el)
        setAway(!near)
        if (near) setUnseen(false)
      },
    })
    // 动画关了时 onEnd 在 glideToEnd 里已同步调用过（jumping 已清），没有可取消的滑动
    glide.current = jumping.current ? cancel : null
  }

  // 用户自己滚动或操作：结束搜索跳转后的暂停和「回到最新」的平滑滚动
  const resume = (): void => {
    detached.current = false
    jumping.current = false
  }

  // 一个显示块；nested：在执行块里面（外面已经有左边线，工具组不再画）
  const renderBlock = (b: Block, i: number, nested = false): ReactNode => {
    if (b.type === 'process')
      return (
        <ProcessBlock
          key={b.key}
          foldKey={b.key}
          items={b.items}
          running={b.running}
          durationMs={b.durationMs}
          toggled={folds[b.key] ?? null}
          onToggle={setFold}
          highlight={highlight}
          render={list => innerBlocks(list).map((inner, j) => renderBlock(inner, j, true))}
        />
      )

    if (b.type === 'tools') {
      return (
        <div
          key={b.key}
          className={cn('conversation-message flex flex-col', !nested && 'border-l border-line pl-1.5')}
          style={placeholder(toolsHeight(b.items.length))}
        >
          {b.items.map(it => (
            <div key={it.id} data-search-item={it.id} className={highlight === it.id ? 'search-hit' : undefined}>
              <ToolItemRow item={it} />
            </div>
          ))}
        </div>
      )
    }
    if (b.type === 'changes') return <TurnChanges key={b.key} data={b.data} sessionId={sessionId} turnKey={b.turnKey} />
    // 统计关闭时 TurnStats 不产生 DOM，避免外层空块在 flex 列表里留下间距。
    if (b.item.kind === 'turn_stats') return <ItemView key={b.item.id} item={b.item} reply={replies.get(b.item.id)} />
    const isUser = b.item.kind === 'user' && !b.item.reconnect
    const item = b.item
    if (item.kind === 'notice' && item.level === 'error' && snapshot) {
      const text = platformNoticeText(snapshot.record, item.text)
      return (
        <div
          key={item.id}
          data-search-item={item.id}
          style={placeholder(errorNoticeHeight(item.id === actionNoticeId))}
          className={['conversation-message', highlight === item.id ? 'search-hit' : ''].join(' ')}
        >
          <NoticeRow item={text === item.text ? item : { ...item, text }} />
          {item.id === actionNoticeId && (
            <NoticeActions
              record={snapshot.record}
              text={item.text}
              error={item.error}
              turnStart={turnStart}
              retry={snapshot.queue.length === 0}
              compact={!!snapshot.flags.compactAvailable}
            />
          )}
        </div>
      )
    }
    // 小框（docs/ui/subagent-box.md）：派发子智能体的调用、后台子智能体完成的提示
    const boxed =
      subagents === 'box' && (item.kind === 'tool' ? isSubagentCall(item) : item.kind === 'notice' && !!item.task)
    if (boxed)
      return (
        <div
          key={item.id}
          data-search-item={item.id}
          style={placeholder(SUBAGENT_BOX)}
          className={['conversation-message', highlight === item.id ? 'search-hit' : ''].join(' ')}
        >
          {item.kind === 'tool' && (
            <SubagentDispatchBox item={item} runs={snapshot?.runs} approval={!!approving?.has(item.id)} />
          )}
          {item.kind === 'notice' && item.task && <SubagentCompletionBox task={item.task} runs={snapshot?.runs} />}
        </div>
      )
    return (
      <div
        key={item.id}
        data-search-item={item.id}
        style={placeholder(estimate(item))}
        className={[
          'group/message',
          isUser ? 'conversation-user-row' : 'conversation-message',
          isUser && i > 0 ? 'mt-4' : '',
          highlight === item.id ? 'search-hit' : '',
        ].join(' ')}
      >
        <ItemView item={item} sessionId={sessionId} reconnectFailed={reconnects.failed.has(item.id)} />
      </div>
    )
  }

  return (
    <ExpandScope.Provider value={snapshot?.record.id ?? null}>
      <CompactionLiveContext.Provider value={compactionLive}>
        <LiveOwnerContext.Provider value={showLive}>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={scroller}
              onScroll={e => {
                const el = e.currentTarget
                const pos = { top: el.scrollTop, height: el.scrollHeight }
                const up = scrolledUp(lastPos.current, pos)
                lastPos.current = pos
                if (jumping.current) return
                const near = nearBottom(el)
                // 往上滚了就松开；往下滚回底部附近（或内容变短、底部自己靠过来）才重新贴底
                if (up) released.current = true
                else if (near) released.current = false
                if (!detached.current) stick.current = near && !released.current
                setAway(!near)
                if (near) setUnseen(false)
                // 滚动停下 200 毫秒后记一次位置（标签已经隐藏就不记，那时量出来的不准）
                window.clearTimeout(placeTimer.current)
                placeTimer.current = window.setTimeout(() => {
                  if (el.closest('[aria-hidden="true"]')) return
                  placeRef.current.atBottom = nearBottom(el)
                  placeRef.current.anchor = anchorOf(el)
                  placeRef.current.scrollTop = el.scrollTop
                }, 200)
              }}
              onWheel={e => {
                resume()
                // 往上滚的第一下就松开，不等滚动事件：平滑滚动的前几帧只挪几像素，等它的话新内容已经把位置拽回去了
                const el = e.currentTarget
                if (e.deltaY < 0 && el.scrollTop > 0 && !innerCanScrollUp(e.target as Element, el)) release()
              }}
              onTouchMove={resume}
              onPointerDown={() => {
                resume()
                lastInteract.current = performance.now()
              }}
              onKeyDown={e => {
                resume()
                lastInteract.current = performance.now()
                const target = e.target as HTMLElement
                if (scrollUpKey(e) && !target.closest('input, textarea, select, [contenteditable="true"]')) release()
              }}
              data-search-session={snapshot?.record.id}
              data-custom-scrollbar
              className="conversation-scroller selectable min-h-0 flex-1 overflow-y-auto bg-app"
            >
              <div
                ref={stream}
                data-conversation-stream
                className="conversation-inset conversation-reading flex flex-col gap-3 pt-5 pb-6"
              >
                {!snapshot && (
                  <div className="conversation-message flex items-center gap-2 py-8 text-list text-fg-muted">
                    <Spinner size={14} />
                    {tr('session.live.LiveTranscript.openingConversation')}{' '}
                  </div>
                )}
                {header}
                {hiddenTurns > 0 && (
                  <div
                    data-transcript-hidden
                    data-hidden-turns={hiddenTurns}
                    className="conversation-message flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-subtle px-3 py-2 text-meta text-fg-muted"
                  >
                    <span className="tabular-nums">{tr('longConversation.hidden', { n: hiddenTurns })}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      {windowSize !== null && (
                        <button
                          type="button"
                          data-transcript-show-earlier
                          onClick={() => showEarlier(windowSize)}
                          className="press rounded-md px-2 py-1 text-fg-secondary outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
                        >
                          {tr('longConversation.showEarlier', { n: Math.min(windowSize, hiddenTurns) })}
                        </button>
                      )}
                      <button
                        type="button"
                        data-transcript-show-all
                        onClick={() => showEarlier(null)}
                        className="press rounded-md px-2 py-1 text-fg-secondary outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {tr('longConversation.showAll')}
                      </button>
                    </span>
                  </div>
                )}
                {blocks.map((b, i) => renderBlock(b, i))}
                {footer}
                {starting.map(q => (
                  <div key={q.id} data-starting-message={q.id} className="flex flex-col gap-3">
                    <div className={cn('conversation-user-row', blocks.length > 0 && 'mt-4')}>
                      <UserBubble
                        item={{
                          kind: 'user',
                          id: q.id,
                          text: q.text,
                          attachments: q.attachments,
                          files: q.files,
                          createdAt: q.createdAt,
                        }}
                      />
                    </div>
                    <div className="conversation-message flex h-[30px] items-center gap-2 px-2 text-list text-fg-muted">
                      <Spinner size={13} />
                      {/* 导入的终端会话：引擎要先解析整份记录，大的要几秒 */}
                      {importedEngine
                        ? tr('resume.starting', { engine: RESUME_ENGINE_NAMES[importedEngine] })
                        : tr('session.queue.starting')}
                    </div>
                  </div>
                ))}
                {showLive && <LiveStatusLine items={visible} turnId={snapshot?.turnId ?? null} fold={liveFold} />}
              </div>
            </div>
            {away && snapshot && <JumpToLatest unseen={unseen} onClick={jumpToLatest} />}
            {/* 滚动条和轮次刻度合成一条（docs/ui/turn-rail.md §8）；设置里关掉轮次时只剩滚动条 */}
            {snapshot && (
              <TurnRail
                turns={turns}
                scroller={scroller}
                showTurns={showTurns}
                onBeforeJump={detachForSearch}
                onGrab={cancelGlide}
                hiddenTurns={hiddenTurns}
                onShowEarlier={windowSize !== null ? () => showEarlier(windowSize) : undefined}
              />
            )}
          </div>
        </LiveOwnerContext.Provider>
      </CompactionLiveContext.Provider>
    </ExpandScope.Provider>
  )
}
