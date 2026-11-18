// 团队收件箱（docs/mobile-app.md §16.2）：一件事一行；左滑归档，长按标已读 / 延后 / 取消订阅，
// 「等你同意」那行直接同意 / 拒绝；点一行打开那个频道。要「可以操作」的手机才改得了（电脑会拦）。
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../data/channels.dart';
import '../../data/tasks.dart';
import '../../data/team_inbox.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import 'channels_screen.dart';

class InboxScreen extends StatelessWidget {
  const InboxScreen({
    super.key,
    required this.deviceId,
    required this.inbox,
    required this.channels,
  });
  final String deviceId;
  final TeamInbox inbox;
  final ChannelList channels;

  void _toast(BuildContext context, String text) =>
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(text)));

  Future<void> _run(BuildContext context, Future<void> Function() f) async {
    try {
      await f();
    } catch (e) {
      if (context.mounted) _toast(context, actionError(e));
    }
  }

  void _open(BuildContext context, InboxItem item) {
    if (!item.read) {
      inbox.patch(item, {'read': true}).catchError((Object _) {});
    }
    final ch = channels.channels.where((c) => c.id == item.channelId);
    if (ch.isEmpty) {
      _toast(context, L('这个频道看不到了', 'This channel is no longer available'));
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ChannelScreen(
          deviceId: deviceId,
          channel: ch.first,
          members: channels.members,
        ),
      ),
    );
  }

  Future<void> _menu(BuildContext context, InboxItem item) async {
    final now = DateTime.now();
    Json? snooze(String choice) => {
      'snoozeUntil': snoozeAt(choice, now).millisecondsSinceEpoch,
    };
    final patch = await showPanel<Json>(
      context,
      (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListRow(
              title: item.read
                  ? L('标为未读', 'Mark unread')
                  : L('标为已读', 'Mark read'),
              leading: const Icon(Icons.mark_email_read_outlined),
              onTap: () => Navigator.of(context).pop({'read': !item.read}),
            ),
            ListRow(
              title: L('延后 1 小时', 'Snooze 1 hour'),
              leading: const Icon(Icons.snooze_outlined),
              onTap: () => Navigator.of(context).pop(snooze('hour')),
            ),
            ListRow(
              title: L('延后到明天', 'Snooze until tomorrow'),
              leading: const Icon(Icons.wb_sunny_outlined),
              onTap: () => Navigator.of(context).pop(snooze('tomorrow')),
            ),
            ListRow(
              title: L('延后到下周', 'Snooze until next week'),
              leading: const Icon(Icons.date_range_outlined),
              onTap: () => Navigator.of(context).pop(snooze('week')),
            ),
            ListRow(
              title: item.muted
                  ? L('重新订阅这件事', 'Resubscribe')
                  : L('取消订阅这件事', 'Unsubscribe'),
              leading: const Icon(Icons.notifications_off_outlined),
              onTap: () => Navigator.of(context).pop({'muted': !item.muted}),
            ),
            ListRow(
              title: L('归档', 'Archive'),
              leading: const Icon(Icons.archive_outlined),
              onTap: () => Navigator.of(context).pop({'archived': true}),
            ),
          ],
        ),
      ),
    );
    if (patch != null && context.mounted) {
      await _run(context, () => inbox.patch(item, patch));
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([inbox, channels]),
      builder: (context, _) {
        final items = visibleInbox(
          inbox.items,
          DateTime.now().millisecondsSinceEpoch,
        );
        return AppScreen(
          title: L('通知', 'Inbox'),
          subtitle: inbox.unread > 0
              ? L('${inbox.unread} 条未读', '${inbox.unread} unread')
              : null,
          leading: RoundIconButton(
            icon: Icons.arrow_back,
            tooltip: L('返回', 'Back'),
            onPressed: () => Navigator.of(context).pop(),
          ),
          body: items.isEmpty
              ? EmptyState(
                  icon: Icons.inbox_outlined,
                  title: L('没有新通知', 'Nothing new'),
                  body: L(
                    '有人 @ 你、派活给你的 AI、等你同意时，会出现在这里。',
                    'Mentions, work for your AI and requests for your OK show up here.',
                  ),
                )
              : RefreshIndicator(
                  onRefresh: inbox.load,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(8, 4, 8, 32),
                    children: [
                      for (final item in items)
                        Dismissible(
                          key: ValueKey('${item.teamId}/${item.key}'),
                          direction: DismissDirection.endToStart,
                          background: const _ArchiveBackground(),
                          confirmDismiss: (_) async {
                            try {
                              await inbox.patch(item, {'archived': true});
                              return true;
                            } catch (e) {
                              if (context.mounted) {
                                _toast(context, actionError(e));
                              }
                              return false;
                            }
                          },
                          child: InboxRow(
                            item: item,
                            actor: channels.members[item.actor]?.name,
                            team: channels.teams[item.teamId],
                            onTap: () => _open(context, item),
                            onLongPress: () => _menu(context, item),
                            answered:
                                inbox.answered['${item.teamId}/${item.key}'],
                            onAnswer:
                                item.kind == 'approval' &&
                                    !inbox.answered.containsKey(
                                      '${item.teamId}/${item.key}',
                                    )
                                ? (yes) => _run(
                                    context,
                                    () => inbox.approve(item, yes),
                                  )
                                : null,
                          ),
                        ),
                    ],
                  ),
                ),
        );
      },
    );
  }
}

class _ArchiveBackground extends StatelessWidget {
  const _ArchiveBackground();
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      alignment: Alignment.centerRight,
      padding: const EdgeInsets.only(right: 20),
      color: c.bgSubtle,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.archive_outlined, color: c.textSecondary),
          const SizedBox(width: 6),
          Text(L('归档', 'Archive'), style: TextStyle(color: c.textSecondary)),
        ],
      ),
    );
  }
}

/// 收件箱一行：未读圆点、类型标签、谁、哪个团队、几条、时间；「等你同意」带两个按钮
class InboxRow extends StatelessWidget {
  const InboxRow({
    super.key,
    required this.item,
    required this.onTap,
    required this.onLongPress,
    this.actor,
    this.team,
    this.answered,
    this.onAnswer,
  });
  final InboxItem item;
  final String? actor;
  final String? team;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  final Future<void> Function(bool yes)? onAnswer;

  /// 手机上答过了：true 同意、false 拒绝
  final bool? answered;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final kind = item.kind;
    final color = switch (kind) {
      'approval' || 'review' => c.warn,
      'failed' || 'rejected' => c.danger,
      'done' => c.success,
      _ => c.accent,
    };
    final meta = [
      ?actor,
      ?team,
      if (item.count > 1) L('${item.count} 条', '${item.count} updates'),
      ago(item.at),
    ].join(' · ');
    return InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      borderRadius: BorderRadius.circular(Radii.card),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 6, right: 10),
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: item.read ? Colors.transparent : c.accent,
                  shape: BoxShape.circle,
                ),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 1,
                        ),
                        decoration: BoxDecoration(
                          color: color.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(99),
                        ),
                        child: Text(
                          inboxKindText(kind),
                          style: TextStyle(fontSize: Fs.meta, color: color),
                        ),
                      ),
                      if (item.muted) ...[
                        const SizedBox(width: 6),
                        Icon(
                          Icons.notifications_off_outlined,
                          size: 14,
                          color: c.textFaint,
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    item.text,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: Fs.ui,
                      color: c.text,
                      fontWeight: item.read ? FontWeight.w400 : FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    meta,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                  ),
                  if (onAnswer != null)
                    ApproveButtons(onAnswer: onAnswer!)
                  else if (answered != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        answered! ? L('已同意', 'Approved') : L('已拒绝', 'Declined'),
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
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
