// 会话页（布局参考 DSH Go，docs/mobile-app.md §8.1；规则照网页版 SessionScreen.tsx）：
// 顶栏 ☰ ·「标题 · 状态」胶囊（点开会话菜单）·「模型 · 强度」胶囊（点开改模式）· ✎ 新建对话；
// 对话按 foldTurns 折好的条目显示，倒着排（新的在底部、自动贴底），滑到顶加载更早的，不在底部时右下角「回到最新」；
// 排队的消息在对话末尾；底部是运行小条 + 输入框，有待审批 / 提问时输入框换成审批卡。
import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../connection/desktop_link.dart';
import '../../data/actions.dart';
import '../../data/images.dart';
import '../../data/mode.dart';
import '../../data/notify.dart';
import '../../data/queue.dart';
import '../../data/session_controller.dart';
import '../../data/tasks.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../protocol/turn_fold.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/layout.dart';
import '../../ui/widgets.dart';
import '../drawer/app_drawer.dart';
import '../home/home_screen.dart';
import '../new_session/new_session_screen.dart';
import 'approval_card.dart';
import 'composer.dart';
import 'items.dart';
import 'mode_sheet.dart';
import 'queue_view.dart';
import 'session_menu.dart';
import '../tools/common.dart';
import '../tools/tools.dart';

/// 打开会话页；replace 为 true 时换掉当前页（抽屉里从一个会话切到另一个）
void openSession(
  BuildContext context,
  String deviceId,
  String sessionId, {
  bool replace = false,
  Triage? triage,
  bool notified = false,
}) {
  final route = MaterialPageRoute<void>(
    builder: (_) => SessionScreen(
      deviceId: deviceId,
      sessionId: sessionId,
      triage: triage,
      notified: notified,
    ),
  );
  final nav = Navigator.of(context);
  replace ? nav.pushReplacement(route) : nav.push(route);
}

class SessionScreen extends StatefulWidget {
  const SessionScreen({
    super.key,
    required this.deviceId,
    required this.sessionId,
    this.triage,
    this.notified = false,
  });
  final String deviceId;
  final String sessionId;

  /// 逐个处理等你的会话（点「有 N 个任务等你处理」的通知进来的）
  final Triage? triage;

  /// 点「等你处理」的通知进来的：审批已经在电脑上处理掉时说一声
  final bool notified;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  SessionController? _session;
  late SessionActions _actions;
  late DesktopActions _desktop;
  final _scroll = ScrollController();
  final _draft = TextEditingController();
  final _images = PendingImages();
  bool _atBottom = true;
  bool _retrying = false;
  String? _retryError;

  /// 宽屏时右边栏里开着的工具（栏里有自己的导航，换一个工具就换一个导航）
  Widget? _tool;
  GlobalKey<NavigatorState>? _toolNav;

  void _showTool(Widget page) {
    if (!mounted) return;
    setState(() {
      _tool = page;
      _toolNav = GlobalKey<NavigatorState>();
    });
  }

  void _closeTool() {
    if (mounted) setState(() => _tool = null);
  }

  /// 这次打开后见过待审批；见过之后又没了 = 答完了（逐个处理时去下一个）
  bool _seenPending = false;
  Timer? _next;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_session == null) {
      final connections = AppScope.read(context).connections;
      _session = SessionController(
        connections,
        widget.deviceId,
        widget.sessionId,
      );
      _actions = SessionActions(connections, widget.deviceId, widget.sessionId);
      _desktop = DesktopActions(connections, widget.deviceId);
    }
  }

  @override
  void initState() {
    super.initState();
    // 倒着排的列表：滑到「最后」就是最早的条目，到了就加载更早的
    _scroll.addListener(() {
      final p = _scroll.position;
      if (p.pixels > p.maxScrollExtent - 400) _session?.loadOlder();
      final bottom = p.pixels < 80;
      if (bottom != _atBottom) setState(() => _atBottom = bottom);
    });
  }

  /// 逐个处理：去下一个还在等你的；都过完了回概览
  void _goNext() {
    final triage = widget.triage;
    if (triage == null || !mounted) return;
    final lists = AppScope.read(context).lists.get(widget.deviceId);
    final next = triage.next(widget.sessionId, lists.sessions);
    if (next != null) {
      openSession(
        context,
        widget.deviceId,
        next,
        replace: true,
        triage: triage,
      );
    } else {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(L('都处理完了', 'All caught up'))));
      Navigator.of(context).maybePop();
    }
  }

  @override
  void dispose() {
    _next?.cancel();
    _session?.dispose();
    _scroll.dispose();
    _draft.dispose();
    _images.dispose();
    super.dispose();
  }

  void _toBottom() => _scroll.animateTo(
    0,
    duration: const Duration(milliseconds: 250),
    curve: Curves.easeOut,
  );

  Future<void> _retry(String noticeId) async {
    if (_retrying) return;
    setState(() {
      _retrying = true;
      _retryError = null;
    });
    try {
      await _actions.retry(noticeId);
    } catch (e) {
      if (mounted) setState(() => _retryError = actionError(e));
    } finally {
      if (mounted) setState(() => _retrying = false);
    }
  }

  /// 撤回的文字放回输入框：输入框里已经有字就接在后面
  void _recall(String text) {
    final now = _draft.text;
    _draft.text = now.trim().isEmpty ? text : '$now\n$text';
    _draft.selection = TextSelection.collapsed(offset: _draft.text.length);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final services = AppScope.of(context);
    final state = services.connections.state(widget.deviceId);
    final session = _session!;
    // 宽 ≥ 1280：工具放右边栏（窄下来时不显示，再打开的工具整页推进去）
    final wide = sidePanelFits(context);
    final tool = wide ? _tool : null;
    final screen = ListenableBuilder(
      listenable: Listenable.merge([session, services.lists]),
      builder: (context, _) {
        final snapshot = session.view.snapshot;
        final record = obj(snapshot?['record']);
        final lists = services.lists.get(widget.deviceId);
        // 这个会话的项目（工具作用于它；对话类会话不是项目，没有工具）
        Project? toolProject;
        for (final p in lists.projects) {
          if (p.id == str(record['projectId'])) toolProject = p;
        }
        final project = toolProject;
        SessionSummary? summary;
        for (final s in lists.sessions) {
          if (s.id == widget.sessionId) summary = s;
        }
        // 有快照看有没有在跑的一轮；没快照时认列表里的 running / starting
        final running = snapshot != null
            ? truthy(snapshot['turnId'])
            : summary?.state == 'running' || summary?.state == 'starting';
        final pendingList = objList(snapshot?['pending']);
        final pending = pendingList.isEmpty
            ? null
            : Approval(pendingList.first);
        final canAct = state == LinkState.ready && _actions.canAct;
        if (pending != null && !_seenPending) _seenPending = true;
        // 逐个处理：这个会话等你的都答完了，停一下让人看到卡片收起，再去下一个
        if (widget.triage != null && _seenPending && pending == null) {
          _next ??= Timer(const Duration(milliseconds: 700), _goNext);
        }
        final position = widget.triage?.position(widget.sessionId);
        // 点通知进来，但快照到了也没见过待审批：已经在电脑上处理了
        final handledElsewhere =
            (widget.notified || widget.triage != null) &&
            snapshot != null &&
            pending == null &&
            !_seenPending;
        final items = session.view.items;
        final entries = foldTurns(items, running);
        final queued = snapshot == null ? 0 : queueOf(snapshot).length;
        final retryId = canAct && snapshot != null
            ? retryNoticeId(items, running, queued)
            : null;
        final turn = TurnContext.of(items)
            .withRetry(retryId, _retrying, () => _retry(retryId!));
        final engine = str(record['engine']) ?? summary?.engine ?? 'claude';
        final title = jsTrim(str(record['title']) ?? '').isEmpty
            ? L('未命名会话', 'Untitled conversation')
            : jsTrim(str(record['title'])!);
        final status = pending != null
            ? (L('等你处理', 'Needs you'), c.notify)
            : running
            ? (L('正在回复', 'Replying'), c.statusOnline)
            : record['lastOutcome'] == 'failed'
            ? (L('出错了', 'Error'), c.warn)
            : null;
        final projectName = projectNameOf(
          lists.projects,
          str(record['projectId']),
        );
        final subtitle = [
          ?status?.$1,
          engineName(engine),
          if (projectName.isNotEmpty) projectName,
        ].join(' · ');

        return AppScreen(
          drawer: AppDrawer(currentSessionId: widget.sessionId),
          side: tool == null
              ? null
              : Navigator(
                  key: _toolNav,
                  onGenerateInitialRoutes: (_, _) => [
                    MaterialPageRoute<void>(builder: (_) => tool),
                  ],
                ),
          leading: Builder(
            builder: (context) => RoundIconButton(
              icon: Icons.menu,
              tooltip: L('会话列表', 'Sessions'),
              onPressed: () => Scaffold.of(context).openDrawer(),
            ),
          ),
          center: snapshot == null
              ? const SizedBox()
              : Row(
                  children: [
                    const SizedBox(width: 4),
                    Expanded(
                      child: _Capsule(
                        onTap: () => showSessionMenu(
                          context,
                          record: record,
                          actions: _actions,
                          running: running,
                          onNew: (projectId) => openNewSession(
                            context,
                            widget.deviceId,
                            projectId: projectId,
                          ),
                          onArchived: () => Navigator.of(context).maybePop(),
                          onTool: project == null
                              ? null
                              : (id) => openTool(
                                  context,
                                  widget.deviceId,
                                  project,
                                  id,
                                  showSide: wide ? _showTool : null,
                                ),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: Fs.ui,
                                height: 1.25,
                                fontWeight: FontWeight.w600,
                                color: c.text,
                              ),
                            ),
                            Row(
                              children: [
                                if (status != null) ...[
                                  Container(
                                    width: 6,
                                    height: 6,
                                    decoration: BoxDecoration(
                                      color: status.$2,
                                      shape: BoxShape.circle,
                                    ),
                                  ),
                                  const SizedBox(width: 4),
                                ],
                                Flexible(
                                  child: Text(
                                    subtitle,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: Fs.label,
                                      height: 1.2,
                                      color: c.textMuted,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 150),
                      child: _Capsule(
                        fill: false,
                        onTap: () => showPanel<void>(
                          context,
                          (_) => SessionModeSheet(
                            session: session,
                            actions: _actions,
                            desktop: _desktop,
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.auto_awesome,
                              size: 14,
                              color: c.accentText,
                            ),
                            const SizedBox(width: 4),
                            // 放不下时先截模型名，强度始终露出
                            ..._modelChip(record, c),
                            if (record['fast'] == true)
                              Icon(Icons.bolt, size: 15, color: c.warn),
                            Icon(
                              Icons.expand_more,
                              size: 16,
                              color: c.textFaint,
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                  ],
                ),
          trailing: [
            RoundIconButton(
              icon: Icons.edit_square,
              tooltip: L('新对话', 'New conversation'),
              onPressed: () => openNewSession(
                context,
                widget.deviceId,
                projectId: str(record['projectId']),
              ),
            ),
          ],
          body: Stack(
            children: [
              Positioned.fill(
                child: SelectionArea(
                  child: CustomScrollView(
                    controller: _scroll,
                    reverse: true,
                    slivers: [
                      SliverPadding(
                        padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                        sliver: SliverList.list(
                          children: [
                            if (snapshot != null)
                              QueuedMessages(
                                snapshot: snapshot,
                                actions: _actions,
                                canAct: canAct,
                                onRecall: _recall,
                              ),
                            if (running &&
                                pending == null &&
                                items.isNotEmpty &&
                                items.last.kind == 'user')
                              const _Thinking(),
                            for (final e in entries.reversed)
                              EntryView(e, context: turn),
                            if (session.loadingOlder)
                              const Padding(
                                padding: EdgeInsets.all(16),
                                child: Center(
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                              ),
                            if (snapshot == null &&
                                session.error == null &&
                                state == LinkState.ready)
                              const Padding(
                                padding: EdgeInsets.all(48),
                                child: Center(
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                ),
                              ),
                            if (session.error != null) _Banner(session.error!),
                            if (_retryError != null) _Banner(_retryError!),
                            if (state != LinkState.ready)
                              StateBanner(
                                deviceId: widget.deviceId,
                                state: state,
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              Positioned(
                right: 16,
                bottom: 12,
                child: AnimatedOpacity(
                  opacity: _atBottom ? 0 : 1,
                  duration: const Duration(milliseconds: 150),
                  child: IgnorePointer(
                    ignoring: _atBottom,
                    child: RoundIconButton(
                      icon: Icons.arrow_downward,
                      tooltip: L('回到最新', 'Jump to latest'),
                      onPressed: _toBottom,
                    ),
                  ),
                ),
              ),
            ],
          ),
          bottom: snapshot == null
              ? null
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (handledElsewhere)
                      _Note(
                        L(
                          '这个请求已经在电脑上处理了',
                          'This request was already handled on the computer',
                        ),
                      ),
                    if (position != null)
                      _TriageBar(
                        index: position.index,
                        total: position.total,
                        onNext: _goNext,
                      ),
                    if (pending != null)
                      ApprovalCard(
                        key: ValueKey(pending.requestId),
                        request: pending,
                        canAct: canAct,
                        more: pendingList.length - 1,
                        onAnswer: (d) => _actions.answer(pending.requestId, d),
                        onStop: running ? () => _actions.interrupt() : null,
                      )
                    else
                      Composer(
                        top: running ? RunningStrip(items: items) : null,
                        draft: _draft,
                        canAct: canAct,
                        running: running,
                        engineName: engineName(engine),
                        images: _images,
                        onSend: (text, images) async {
                          await _actions.send(text, images);
                          if (mounted) _toBottom();
                        },
                        onStop: _actions.interrupt,
                      ),
                  ],
                ),
        );
      },
    );
    // 右边栏开着时，返回先在栏里退一页，退到头关掉栏（窄屏也套着，转屏时页面不重建）
    return ToolHost(
      show: wide ? _showTool : null,
      close: _closeTool,
      child: PopScope(
        canPop: tool == null,
        onPopInvokedWithResult: (didPop, _) {
          if (didPop) return;
          final nav = _toolNav?.currentState;
          if (nav != null && nav.canPop()) {
            nav.pop();
          } else {
            _closeTool();
          }
        },
        child: screen,
      ),
    );
  }
}

/// 模型胶囊里的字：「模型 · 强度」，窄时模型名截断
List<Widget> _modelChip(Json record, AppColors c) {
  final chip = modeChip(record);
  final style = TextStyle(
    fontSize: Fs.meta,
    fontWeight: FontWeight.w500,
    color: c.text,
  );
  if (chip.model == null && chip.effort == null) {
    return [Text(modelChipText(record), style: style)];
  }
  return [
    if (chip.model != null)
      Flexible(
        child: Text(
          chip.model!,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: style,
        ),
      ),
    if (chip.effort != null)
      Text(
        chip.model == null ? chip.effort! : ' · ${chip.effort}',
        maxLines: 1,
        style: style,
      ),
  ];
}

/// 顶栏的胶囊：白底细边圆角，点开面板
class _Capsule extends StatelessWidget {
  const _Capsule({required this.child, required this.onTap, this.fill = true});
  final Widget child;
  final VoidCallback onTap;

  /// 撑满给的宽度（标题胶囊）；false 时跟着内容宽（模型胶囊）
  final bool fill;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: c.bgSurface,
      shape: StadiumBorder(side: BorderSide(color: c.borderCard)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: fill ? Alignment.centerLeft : null,
          child: child,
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.danger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: Fs.list, color: c.danger),
      ),
    );
  }
}

/// 逐个处理的进度：小圆点 +「等你处理 2 / 3」+ 下一个
class _TriageBar extends StatelessWidget {
  const _TriageBar({
    required this.index,
    required this.total,
    required this.onNext,
  });
  final int index;
  final int total;
  final VoidCallback onNext;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 0),
      padding: const EdgeInsets.only(left: 14, right: 4),
      decoration: BoxDecoration(
        color: c.notify.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        children: [
          Text(
            L('等你处理', 'Needs you'),
            style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
          ),
          const SizedBox(width: 10),
          if (total <= 10)
            for (var i = 0; i < total; i++)
              Container(
                width: 6,
                height: 6,
                margin: const EdgeInsets.only(right: 4),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: i < index - 1
                      ? c.statusOnline
                      : i == index - 1
                      ? c.notify
                      : c.borderCard,
                ),
              ),
          const SizedBox(width: 4),
          Text(
            '$index / $total',
            style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
          ),
          const Spacer(),
          TextButton(
            onPressed: onNext,
            child: Text(index < total ? L('下一个', 'Next') : L('完成', 'Done')),
          ),
        ],
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(16, 4, 16, 0),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
      ),
    );
  }
}

/// 刚发出、还没有任何输出时的一行「正在思考」
class _Thinking extends StatelessWidget {
  const _Thinking();
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          SizedBox.square(
            dimension: 14,
            child: CircularProgressIndicator(strokeWidth: 1.5, color: c.accent),
          ),
          const SizedBox(width: 10),
          Text(
            L('正在思考…', 'Thinking…'),
            style: TextStyle(fontSize: Fs.list, color: c.textMuted),
          ),
        ],
      ),
    );
  }
}

/// 输入框上方的运行小条：正在跑的那一步（命令、工具、改文件）和计时；没在跑步骤时写「正在思考」「正在请求模型」。
/// 计时从这一步出现在手机上时开始数（不用电脑的时间，避免两边时钟差）
class RunningStrip extends StatefulWidget {
  const RunningStrip({super.key, required this.items});
  final List<Item> items;
  @override
  State<RunningStrip> createState() => _RunningStripState();
}

class _RunningStripState extends State<RunningStrip> {
  String? _key;
  DateTime _since = DateTime.now();
  late final Timer _timer = Timer.periodic(
    const Duration(seconds: 1),
    (_) => setState(() {}),
  );

  @override
  void initState() {
    super.initState();
    _timer;
  }

  @override
  void dispose() {
    _timer.cancel();
    super.dispose();
  }

  ({String key, String text, IconData icon, bool mono}) _current() {
    for (final i in widget.items.reversed) {
      if (i.isToolLike && i.status == 'running') {
        final mono =
            i.kind == 'command' && (str(i['description']) ?? '').isEmpty;
        return (
          key: i.id,
          text: '${stepVerb(i)} · ${stepTitle(i)}',
          icon: stepIcon(i),
          mono: mono,
        );
      }
      if (i.kind == 'user') break;
    }
    final last = widget.items.isEmpty ? null : widget.items.last;
    if (last != null && last.kind == 'reasoning' && last.status == 'running') {
      return (
        key: last.id,
        text: L('正在思考', 'Thinking'),
        icon: Icons.psychology_outlined,
        mono: false,
      );
    }
    if (last != null && last.kind == 'assistant' && last.status == 'running') {
      return (
        key: last.id,
        text: L('正在回复', 'Writing'),
        icon: Icons.edit_outlined,
        mono: false,
      );
    }
    return (
      key: 'wait:${last?.id}',
      text: L('正在请求模型', 'Waiting for the model'),
      icon: Icons.hourglass_empty,
      mono: false,
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final now = _current();
    if (now.key != _key) {
      _key = now.key;
      _since = DateTime.now();
    }
    final s = DateTime.now().difference(_since).inSeconds;
    final time = '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
    // 放在输入框卡片的第一行（Composer.top），下面一条细线隔开
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 4, 10, 8),
      margin: const EdgeInsets.only(bottom: 2),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: c.borderSubtle)),
      ),
      child: Row(
        children: [
          SizedBox.square(
            dimension: 12,
            child: CircularProgressIndicator(strokeWidth: 1.5, color: c.accent),
          ),
          const SizedBox(width: 8),
          Icon(now.icon, size: 15, color: c.textMuted),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              now.text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: Fs.meta,
                color: c.textSecondary,
                fontFamily: now.mono ? 'monospace' : null,
              ),
            ),
          ),
          Text(
            time,
            style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
          ),
        ],
      ),
    );
  }
}
