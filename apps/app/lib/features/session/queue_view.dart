// 排队的消息（布局参考 DSH Go，docs/mobile-app.md §8.1）：放在对话末尾，淡色气泡 + 下面一行状态和常用操作
// （立即发送 / 重试、插话、撤回）；长按气泡弹出全部操作（再加上移、下移、关掉）。规则照网页版 QueuePanel.tsx。
// 断线自动重连中、额度用完在等的那条：立即重连 / 现在试一次、停止。
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../data/queue.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import 'items.dart';

class _Action {
  const _Action(
    this.label,
    this.run, {
    this.hint,
    this.danger = false,
    this.enabled = true,
  });
  final String label;
  final String? hint;
  final bool danger;
  final bool enabled;
  final Future<void> Function() run;
}

class QueuedMessages extends StatefulWidget {
  const QueuedMessages({
    super.key,
    required this.snapshot,
    required this.actions,
    required this.canAct,
    required this.onRecall,
  });
  final Json snapshot;
  final SessionActions actions;
  final bool canAct;

  /// 撤回的文字放回输入框
  final ValueChanged<String> onRecall;

  @override
  State<QueuedMessages> createState() => _QueuedMessagesState();
}

class _QueuedMessagesState extends State<QueuedMessages> {
  String? _busy;
  String? _error;

  Future<void> _run(String id, Future<void> Function() job) async {
    if (_busy != null) return;
    setState(() {
      _busy = id;
      _error = null;
    });
    try {
      await job();
    } catch (e) {
      if (mounted) setState(() => _error = actionError(e));
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  Future<void> _withdraw(Queued q) async {
    final text = await widget.actions.cancelQueued(q.id);
    if (text != null && text.isNotEmpty) widget.onRecall(text);
  }

  List<_Action> _actionsFor(Queued q, List<Queued> items, {bool all = false}) {
    final a = widget.actions;
    final snap = widget.snapshot;
    final paused = snap['queuePaused'] == true;
    if (isLimitWait(q)) {
      return [
        _Action(
          L('现在试一次', 'Try now'),
          () => a.runQueuedNow(q.id),
          hint: L('不等额度恢复，现在就试；还是被限流的话算一次', 'Try now instead of waiting'),
          enabled: q.status != 'dispatching',
        ),
        _Action(L('停止', 'Stop'), a.interrupt, danger: true),
      ];
    }
    if (isReconnecting(q)) {
      return [
        _Action(
          paused
              ? L('继续重连', 'Resume reconnecting')
              : L('立即重连', 'Reconnect now'),
          () => a.runQueuedNow(q.id),
          enabled: q.status != 'dispatching',
        ),
        _Action(L('停止', 'Stop'), a.interrupt, danger: true),
      ];
    }
    final before = a.link?.hello?.queueMoveBefore == true;
    final queue = queueOf(snap);
    final up = queueMoveArg(queue, items, q.id, -1, before);
    final down = queueMoveArg(queue, items, q.id, 1, before);
    return [
      if (!isPending(q))
        q.error != null
            ? _Action(
                L('重试', 'Retry'),
                () => a.runQueuedNow(q.id),
                hint: q.status == 'uncertain'
                    ? L(
                        '核对过再重新执行，可能重复上次已经做过的操作',
                        'Running it again may repeat what was already done',
                      )
                    : null,
              )
            : _Action(
                L('立即发送', 'Send now'),
                () => a.runQueuedNow(q.id),
                hint: L(
                  '停下当前这一轮，先发这条',
                  'Stop the current turn and send this first',
                ),
              ),
      if (canSteer(q, snap))
        _Action(
          L('插话', 'Steer'),
          () => a.steerQueued(q.id, snap['turnId'] as String),
          hint: L(
            '不停下，作为补充说明交给正在做的这一轮',
            'Add this to the current turn without stopping it',
          ),
        ),
      if (all && q.status == 'queued') ...[
        _Action(
          L('上移', 'Move up'),
          () => a.moveQueued(q.id, up),
          enabled: !identical(up, noMove),
        ),
        _Action(
          L('下移', 'Move down'),
          () => a.moveQueued(q.id, down),
          enabled: !identical(down, noMove),
        ),
      ],
      if (!isPending(q))
        _Action(
          L('撤回', 'Withdraw'),
          () => _withdraw(q),
          hint: all
              ? L(
                  '文字放回输入框（图片不会放回）',
                  "The text goes back to the input box (images don't)",
                )
              : null,
          danger: true,
        ),
      if (all && canDismiss(q))
        _Action(
          L('关掉', 'Dismiss'),
          () => a.dismissQueued(q.id),
          hint: L(
            '不重发也不撤回：消息留在对话里标「未送达」',
            'The message stays marked “Not delivered”',
          ),
        ),
    ];
  }

  void _menu(Queued q, List<Queued> items) {
    final list = _actionsFor(q, items, all: true);
    showPanel<void>(
      context,
      (context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
                child: Text(
                  q.text.isEmpty ? L('这条消息', 'This message') : q.text,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: Fs.ui,
                    color: context.colors.textMuted,
                  ),
                ),
              ),
              Section(
                children: [
                  for (final x in list)
                    ListRow(
                      title: x.label,
                      subtitle: x.hint,
                      danger: x.danger,
                      trailing: const SizedBox(),
                      onTap: x.enabled
                          ? () {
                              Navigator.pop(context);
                              _run(q.id, x.run);
                            }
                          : null,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final snap = widget.snapshot;
    final paused = snap['queuePaused'] == true;
    final items = queueItems(snap);
    // 空闲时直接发送、正在启动的：也放在末尾，写「正在启动」，没有操作
    final starting = [
      for (final q in queueOf(snap))
        if (isStarting(q, paused)) q,
    ];
    if (items.isEmpty && starting.isEmpty) return const SizedBox.shrink();
    final pausedAll = paused || items.any((q) => q.held);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final q in starting) ...[
          UserBubble(text: q.text, images: q.attachments, faded: true),
          _StatusLine(text: L('正在启动', 'Starting'), busy: true),
        ],
        if (pausedAll && items.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(
              children: [
                Icon(Icons.pause_circle_outline, size: 16, color: c.textMuted),
                const SizedBox(width: 6),
                Text(
                  '${queueTitle(items, paused)} · ${items.length}',
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
                const Spacer(),
                TextButton(
                  onPressed: !widget.canAct || _busy != null
                      ? null
                      : () => _run('resume', widget.actions.resumeQueue),
                  child: Text(L('继续队列', 'Resume queue')),
                ),
              ],
            ),
          ),
        for (final q in items) ...[
          GestureDetector(
            onLongPress: widget.canAct ? () => _menu(q, items) : null,
            child: UserBubble(text: q.text, images: q.attachments, faded: true),
          ),
          _StatusLine(
            text: [
              queueLabel(q, paused),
              if (q.status == 'queued' &&
                  !q.held &&
                  !isReconnecting(q) &&
                  !paused)
                L('本轮结束后发送', 'Sends after this turn'),
            ].join(' · '),
            warn: q.error != null || isSendFailure(q),
            busy: isPending(q) || _busy == q.id,
            detail: q.error != null
                ? '${q.error!.split('\n').first}${q.reconnected > 0 ? L(' · 已自动重连 ${q.reconnected} 次', ' · auto-reconnected ${q.reconnected}×') : ''}'
                : isReconnecting(q)
                ? (isLimitWait(q)
                      ? limitNote(q, paused)
                      : (str(q.reconnect!['reason']) ??
                            L('连接中断', 'Connection lost')))
                : null,
            actions: widget.canAct
                ? [
                    for (final x in _actionsFor(q, items))
                      if (x.enabled)
                        (
                          label: x.label,
                          danger: x.danger,
                          onTap: () => _run(q.id, x.run),
                        ),
                  ]
                : const [],
            onMore: widget.canAct ? () => _menu(q, items) : null,
          ),
        ],
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              _error!,
              textAlign: TextAlign.right,
              style: TextStyle(fontSize: Fs.meta, color: c.danger),
            ),
          ),
      ],
    );
  }
}

/// 排队气泡下面一行：右对齐的「◷ 排队中 · 本轮结束后发送  立即发送  插话  撤回  ⋯」
class _StatusLine extends StatelessWidget {
  const _StatusLine({
    required this.text,
    this.warn = false,
    this.busy = false,
    this.detail,
    this.actions = const [],
    this.onMore,
  });
  final String text;
  final bool warn;
  final bool busy;
  final String? detail;
  final List<({String label, bool danger, VoidCallback onTap})> actions;
  final VoidCallback? onMore;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Wrap(
            alignment: WrapAlignment.end,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 2,
            children: [
              if (busy)
                SizedBox.square(
                  dimension: 11,
                  child: CircularProgressIndicator(
                    strokeWidth: 1.5,
                    color: c.textFaint,
                  ),
                )
              else
                Icon(
                  warn ? Icons.error_outline : Icons.schedule,
                  size: 13,
                  color: warn ? c.warn : c.textFaint,
                ),
              const SizedBox(width: 2),
              Text(
                text,
                style: TextStyle(
                  fontSize: Fs.meta,
                  color: warn ? c.warn : c.textMuted,
                ),
              ),
              for (final a in actions)
                TextButton(
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    minimumSize: const Size(0, 32),
                    foregroundColor: a.danger ? c.textMuted : c.accentText,
                    textStyle: const TextStyle(
                      fontSize: Fs.meta,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  onPressed: a.onTap,
                  child: Text(a.label),
                ),
              if (onMore != null)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  iconSize: 18,
                  color: c.textMuted,
                  tooltip: L('更多', 'More'),
                  onPressed: onMore,
                  icon: const Icon(Icons.more_horiz),
                ),
            ],
          ),
          if (detail != null && detail!.isNotEmpty)
            Text(
              detail!,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.right,
              style: TextStyle(
                fontSize: Fs.meta,
                color: warn ? c.warn : c.textFaint,
              ),
            ),
        ],
      ),
    );
  }
}
