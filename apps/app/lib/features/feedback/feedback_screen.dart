// 反馈列表（docs/mobile-app.md §8.5，照电脑 设置 › 反馈）：我的反馈（类型、标题、状态、最后一句），未读加点，
// 「全部标为已读」；底部「新反馈」。经电脑网关转给电脑的反馈模块，电脑没登录、云端没开放、旧电脑各有说明。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/feedback.dart';
import '../../data/tasks.dart' show Tone, ago;
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../tools/common.dart';
import 'feedback_form.dart';
import 'feedback_thread.dart';

void openFeedback(BuildContext context, String deviceId) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => FeedbackScreen(deviceId: deviceId),
      ),
    );

class FeedbackScreen extends StatefulWidget {
  const FeedbackScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<FeedbackScreen> createState() => _FeedbackScreenState();
}

class _FeedbackScreenState extends State<FeedbackScreen> {
  late final _services = AppScope.read(context);
  late final ToolData _state = ToolData(
    _services.connections,
    widget.deviceId,
    'feedback:state',
    const [],
  );
  late final ToolData _list = ToolData(
    _services.connections,
    widget.deviceId,
    'feedback:list',
    const [null],
  );

  /// 「加载更早的」取回来的
  final _older = <FeedbackSummary>[];
  String? _next;
  bool _loadingMore = false;
  bool _marking = false;
  String? _error;
  int _version = 0;

  @override
  void initState() {
    super.initState();
    _services.feedback?.addListener(_onChanged);
    _list.addListener(_onList);
  }

  @override
  void dispose() {
    _services.feedback?.removeListener(_onChanged);
    _list.removeListener(_onList);
    _state.dispose();
    _list.dispose();
    super.dispose();
  }

  /// 电脑说反馈变了（新回复、已读）：重取第一页
  void _onChanged() {
    final v = _services.feedback?.version(widget.deviceId) ?? 0;
    if (v == _version) return;
    _version = v;
    _reload();
  }

  void _onList() {
    final data = objOrNull(_list.data);
    if (data == null) return;
    final n = data['unreadCount'];
    if (n is num) _services.feedback?.set(widget.deviceId, n.toInt());
  }

  void _reload() {
    _older.clear();
    _next = null;
    _state.reload();
    _list.reload();
  }

  Future<void> _more(String before) async {
    setState(() => _loadingMore = true);
    try {
      final r = obj(
        await callTool(
          _services.connections,
          widget.deviceId,
          'feedback:list',
          [before],
        ),
      );
      if (!mounted) return;
      setState(() {
        _older.addAll([
          for (final t in objList(r['threads'])) FeedbackSummary(t),
        ]);
        _next = str(r['nextBefore']);
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = feedbackError(e));
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _markAllRead() async {
    setState(() {
      _marking = true;
      _error = null;
    });
    try {
      await callTool(
        _services.connections,
        widget.deviceId,
        'feedback:markAllRead',
      );
      _services.feedback?.set(widget.deviceId, 0);
      _reload();
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = L('没标上，稍后再试', "Couldn't mark them. Try again later."),
        );
      }
    } finally {
      if (mounted) setState(() => _marking = false);
    }
  }

  Future<void> _open(Widget page) async {
    await Navigator.of(context)
        .push(MaterialPageRoute<void>(builder: (_) => page));
    // 回来时重取：看过的不再算未读，新提交的出现在最上面
    if (mounted) _reload();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListenableBuilder(
      listenable: Listenable.merge([_state, _list, _services.connections]),
      builder: (context, _) {
        final state = objOrNull(_state.data);
        final status = str(state?['status']);
        final data = objOrNull(_list.data);
        final first = [
          for (final t in objList(data?['threads'])) FeedbackSummary(t),
        ];
        final threads = [...first, ..._older];
        final next = _older.isEmpty ? str(data?['nextBefore']) : _next;
        final unread = (data?['unreadCount'] as num?)?.toInt() ?? 0;
        final canAct = canActOn(_services.connections, widget.deviceId);
        final ready = status == 'ready' || status == 'error';
        return ToolFrame(
          title: L('反馈', 'Feedback'),
          heading: L('问题与建议', 'Problems & suggestions'),
          crumb: Text(
            L(
              '直接发给像素星空团队，回复会出现在这里。',
              'Goes straight to the PixelSky team. Replies show up here.',
            ),
          ),
          loading: _state.loading || _list.loading,
          onRefresh: _reload,
          footer: ready && canAct
              ? Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                  child: PrimaryButton(
                    icon: Icons.edit_outlined,
                    label: L('新反馈', 'New feedback'),
                    onPressed: () =>
                        _open(FeedbackFormScreen(deviceId: widget.deviceId)),
                  ),
                )
              : null,
          children: [
            if (state == null)
              ToolLoading(
                error: _state.error == null
                    ? null
                    : feedbackError(_state.error!),
              )
            else if (status == 'signed-out')
              EmptyState(
                icon: Icons.person_outline,
                title: L('电脑上还没登录', 'Not signed in on the computer'),
                body: L(
                  '在电脑上登录像素星空账号后，就能在这里提交反馈、收到团队的回复。',
                  'Sign in to PixelSky on your computer to send feedback and get replies here.',
                ),
              )
            else if (status == 'not-deployed')
              EmptyState(
                icon: Icons.cloud_off_outlined,
                title: L('反馈服务暂未开放', 'Feedback is not available yet'),
                body: L(
                  '可以先在 GitHub 提交 issue。',
                  'You can open an issue on GitHub for now.',
                ),
              )
            else ...[
              if (!canAct)
                ToolBanner(
                  L(
                    '这部手机是「只看」：能看反馈和回复；提交、补充要在电脑 设置 › 手机 里改成「可操作」。',
                    'This phone is “View only”: you can read feedback and replies. To send, change it to “Can act” in Settings › Phone on your computer.',
                  ),
                ),
              if (_error != null) ToolBanner(_error!, tone: Tone.danger),
              if (_list.error != null)
                ToolBanner(feedbackError(_list.error!), tone: Tone.danger),
              if (unread > 0)
                Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.fromLTRB(14, 4, 4, 4),
                  decoration: BoxDecoration(
                    color: c.notify.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(Radii.card),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          L('$unread 条反馈有新回复', '$unread with new replies'),
                          style: TextStyle(fontSize: Fs.list, color: c.notify),
                        ),
                      ),
                      TextButton(
                        onPressed: _marking ? null : _markAllRead,
                        child: Text(
                          unread == 1
                              ? L('标为已读', 'Mark as read')
                              : L('全部标为已读', 'Mark all as read'),
                          style: const TextStyle(fontSize: Fs.meta),
                        ),
                      ),
                    ],
                  ),
                ),
              if (data == null && _list.error == null)
                const ToolLoading()
              else if (data != null && threads.isEmpty)
                EmptyState(
                  icon: Icons.chat_bubble_outline,
                  title: L('还没有提交过反馈', 'No feedback yet'),
                  body: L(
                    '遇到问题、有想要的功能，都可以告诉我们。',
                    'Tell us about problems or features you want.',
                  ),
                )
              else if (threads.isNotEmpty) ...[
                GroupTitle(L('我的反馈', 'My feedback')),
                Group(
                  children: [
                    for (final t in threads)
                      FeedbackRow(
                        thread: t,
                        onTap: () => _open(
                          FeedbackThreadScreen(
                            deviceId: widget.deviceId,
                            threadId: t.id,
                            title: t.title,
                          ),
                        ),
                      ),
                  ],
                ),
                if (next != null)
                  TextButton(
                    onPressed: _loadingMore ? null : () => _more(next),
                    child: Text(
                      _loadingMore
                          ? L('正在加载…', 'Loading…')
                          : L('加载更早的', 'Load earlier'),
                      style: const TextStyle(fontSize: Fs.meta),
                    ),
                  ),
              ],
            ],
          ],
        );
      },
    );
  }
}

/// 一条反馈：未读点、类型、标题、状态，第二行最后一句（团队的带「团队：」）和时间
class FeedbackRow extends StatelessWidget {
  const FeedbackRow({super.key, required this.thread, required this.onTap});
  final FeedbackSummary thread;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = thread;
    final preview = t.preview.replaceAll(RegExp(r'\s+'), ' ').trim();
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 11, 16, 11),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 14,
              child: t.unread
                  ? Padding(
                      padding: const EdgeInsets.only(top: 7),
                      child: Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: c.notify,
                          shape: BoxShape.circle,
                        ),
                      ),
                    )
                  : null,
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      _TypeChip(t.type),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          t.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: Fs.ui,
                            fontWeight: t.unread
                                ? FontWeight.w600
                                : FontWeight.w500,
                            color: c.text,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      FeedbackStatusChip(feedbackStatusKind(t)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          [
                            if (preview.isNotEmpty)
                              t.previewAuthor == 'team'
                                  ? '${L('团队：', 'Team: ')}$preview'
                                  : preview,
                          ].join(),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: Fs.meta,
                            color: c.textMuted,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        ago(t.updatedAt),
                        style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _TypeChip extends StatelessWidget {
  const _TypeChip(this.type);
  final String type;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        border: Border.all(color: c.borderCard),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        feedbackTypeText(type),
        style: TextStyle(fontSize: Fs.label, color: c.textSecondary),
      ),
    );
  }
}

/// 状态小胶囊：已关闭灰 / 已回复绿 / 处理中、已看到强调色 / 等待回复暖色
class FeedbackStatusChip extends StatelessWidget {
  const FeedbackStatusChip(this.kind, {super.key});
  final FeedbackStatusKind kind;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = switch (kind) {
      FeedbackStatusKind.closed => c.textFaint,
      FeedbackStatusKind.replied => c.success,
      FeedbackStatusKind.working || FeedbackStatusKind.seen => c.accentText,
      FeedbackStatusKind.waiting => c.warn,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(Radii.pill),
      ),
      child: Text(
        feedbackStatusText(kind),
        style: TextStyle(
          fontSize: Fs.label,
          fontWeight: FontWeight.w500,
          color: color,
        ),
      ),
    );
  }
}
