// 手机看频道（第三批 C5，docs/mobile-app.md §15.6）：频道列表 → 时间线（成员头像、任务卡状态、图片点开看），
// 任务卡里的会话点了跳到会话页。第四批（§16.2）：团队频道按团队分组、团队收件箱、同意 / 拒绝队友派的活；
// 还不能发消息。
import 'dart:convert';

import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/actions.dart';
import '../../data/channels.dart';
import '../../data/tasks.dart';
import '../../data/team_inbox.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/markdown.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../session/session_screen.dart';
import 'inbox_screen.dart';
import '../settings/log_screen.dart' show showErrorSnack;

/// inbox：直接打开团队收件箱（点了团队提醒，§16.2）
void openChannels(BuildContext context, String deviceId, {bool inbox = false}) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => ChannelsScreen(deviceId: deviceId, openInbox: inbox),
    ),
  );
}

/// 头像底色：成员自己设的，没有时按引擎（同电脑的引擎色）、再没有用灰
Color memberColor(AppColors c, ChannelMember? m) {
  final hex = m?.color;
  if (hex != null && RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(hex)) {
    return Color(int.parse('FF${hex.substring(1)}', radix: 16));
  }
  return switch (m?.engine) {
    'claude' => c.engineClaude,
    null => c.textSecondary,
    _ => c.accent,
  };
}

class MemberAvatar extends StatelessWidget {
  const MemberAvatar(this.member, {super.key, this.size = 32, this.fallback});
  final ChannelMember? member;
  final double size;

  /// 没有成员时头像上的字（频道名的第一个字）
  final String? fallback;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final text = member?.initial ?? fallback ?? '?';
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: memberColor(c, member),
        borderRadius: BorderRadius.circular(size * 0.3),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: Colors.white,
          fontSize: size * 0.42,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class ChannelsScreen extends StatefulWidget {
  const ChannelsScreen({
    super.key,
    required this.deviceId,
    this.openInbox = false,
  });
  final String deviceId;
  final bool openInbox;

  @override
  State<ChannelsScreen> createState() => _ChannelsScreenState();
}

class _ChannelsScreenState extends State<ChannelsScreen> {
  ChannelList? _list;
  TeamInbox? _inbox;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final connections = AppScope.read(context).connections;
    _list ??= ChannelList(connections, widget.deviceId);
    if (_inbox == null) {
      _inbox = TeamInbox(connections, widget.deviceId);
      if (widget.openInbox) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _openInbox();
        });
      }
    }
  }

  @override
  void dispose() {
    _list?.dispose();
    _inbox?.dispose();
    super.dispose();
  }

  void _openInbox() => Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => InboxScreen(
        deviceId: widget.deviceId,
        inbox: _inbox!,
        channels: _list!,
      ),
    ),
  );

  Widget _row(ChannelSummary ch) {
    final list = _list!;
    return _ChannelRow(
      channel: ch,
      author: list.members[ch.lastAuthor],
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ChannelScreen(
            deviceId: widget.deviceId,
            channel: ch,
            members: list.members,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final list = _list!;
    final pairing = AppScope.of(context).connections.pairings
        .where((p) => p.deviceId == widget.deviceId);
    final inbox = _inbox!;
    return ListenableBuilder(
      listenable: Listenable.merge([list, inbox]),
      builder: (context, _) => AppScreen(
        title: L('频道', 'Channels'),
        subtitle: pairing.isEmpty ? null : pairing.first.desktopName,
        leading: RoundIconButton(
          icon: Icons.arrow_back,
          tooltip: L('返回', 'Back'),
          onPressed: () => Navigator.of(context).pop(),
        ),
        body: !list.loaded
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : list.error != null
            ? EmptyState(
                icon: Icons.forum_outlined,
                title: L('看不了频道', "Can't load channels"),
                body: actionError(list.error!),
              )
            : list.channels.isEmpty && !inbox.supported
            ? EmptyState(
                icon: Icons.forum_outlined,
                title: L('还没有频道', 'No channels yet'),
                body: L(
                  '在电脑上建一个频道，让几个 AI 一起干活，这里就能看到。',
                  'Create a channel on your computer and it shows up here.',
                ),
              )
            : RefreshIndicator(
                onRefresh: list.load,
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(8, 4, 8, 32),
                  children: [
                    // 团队收件箱（§16.2）：电脑登录了、云端开了团队才有
                    if (inbox.supported)
                      ListRow(
                        title: L('通知', 'Inbox'),
                        subtitle: L(
                          '@ 你、等你同意、你要的活',
                          'Mentions, approvals, your requests',
                        ),
                        leading: Icon(
                          Icons.inbox_outlined,
                          color: c.textSecondary,
                        ),
                        trailing: inbox.unread > 0
                            ? _Count(inbox.unread)
                            : null,
                        onTap: _openInbox,
                      ),
                    for (final g in channelGroups(
                      list.channels,
                      list.teams,
                    )) ...[
                      // 只有本机频道时不写组名（和以前一样）
                      if (list.teams.isNotEmpty || g.teamId != null)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 16, 12, 4),
                          child: Text(
                            g.title,
                            style: TextStyle(
                              fontSize: Fs.meta,
                              fontWeight: FontWeight.w600,
                              color: c.textMuted,
                            ),
                          ),
                        ),
                      for (final ch in g.channels) _row(ch),
                    ],
                    if (list.channels.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Text(
                          L(
                            '手机上能看、能同意队友派的活 · 发消息请在电脑上',
                            'View and approve teammates’ requests here — post on the computer',
                          ),
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: Fs.meta,
                            color: c.textMuted,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
      ),
    );
  }
}

class _ChannelRow extends StatelessWidget {
  const _ChannelRow({
    required this.channel,
    required this.author,
    required this.onTap,
  });
  final ChannelSummary channel;
  final ChannelMember? author;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final last = channel.lastText;
    final who = author == null
        ? ''
        : author!.you
        ? L('我：', 'Me: ')
        : '${author!.name}：';
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        child: Row(
          children: [
            Opacity(
              opacity: channel.archived ? 0.5 : 1,
              child: MemberAvatar(
                null,
                size: 40,
                fallback: channel.name.isEmpty
                    ? '#'
                    : String.fromCharCode(channel.name.runes.first),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    channel.archived
                        ? L(
                            '${channel.name}（已归档）',
                            '${channel.name} (archived)',
                          )
                        : channel.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: Fs.prose,
                      fontWeight: FontWeight.w600,
                      color: c.text,
                    ),
                  ),
                  if (last != null)
                    Text(
                      '$who$last',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(
                  ago(channel.lastAt),
                  style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                ),
                if (channel.unread > 0)
                  Container(
                    margin: const EdgeInsets.only(top: 4),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 6,
                      vertical: 1,
                    ),
                    decoration: BoxDecoration(
                      color: channel.mentioned ? c.danger : c.accent,
                      borderRadius: BorderRadius.circular(99),
                    ),
                    child: Text(
                      channel.unread > 99 ? '99+' : '${channel.unread}',
                      style: TextStyle(fontSize: Fs.meta, color: c.accentOn),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class ChannelScreen extends StatefulWidget {
  const ChannelScreen({
    super.key,
    required this.deviceId,
    required this.channel,
    required this.members,
  });
  final String deviceId;
  final ChannelSummary channel;
  final Map<String, ChannelMember> members;

  @override
  State<ChannelScreen> createState() => _ChannelScreenState();
}

class _ChannelScreenState extends State<ChannelScreen> {
  ChannelTimeline? _timeline;
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    // 倒着排：滑到「最后」是最早的，到了取更早的
    _scroll.addListener(() {
      final p = _scroll.position;
      if (p.pixels > p.maxScrollExtent - 400) _timeline?.loadOlder();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _timeline ??= ChannelTimeline(
      AppScope.read(context).connections,
      widget.deviceId,
      widget.channel.id,
    );
  }

  @override
  void dispose() {
    _timeline?.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = _timeline!;
    return ListenableBuilder(
      listenable: t,
      builder: (context, _) => AppScreen(
        title: widget.channel.name,
        subtitle: L(
          '${widget.channel.memberIds.length} 个成员',
          '${widget.channel.memberIds.length} members',
        ),
        leading: RoundIconButton(
          icon: Icons.arrow_back,
          tooltip: L('返回', 'Back'),
          onPressed: () => Navigator.of(context).pop(),
        ),
        body: !t.loaded
            ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
            : t.error != null
            ? EmptyState(
                icon: Icons.forum_outlined,
                title: L('看不了这个频道', "Can't load this channel"),
                body: actionError(t.error!),
              )
            : ListView(
                controller: _scroll,
                reverse: true,
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
                children: [
                  for (final e in t.entries.reversed)
                    _Entry(
                      entry: e,
                      members: widget.members,
                      onImage: (i) => _openImage(t, e, i),
                      onSession: (id) =>
                          openSession(context, widget.deviceId, id),
                      onApprove: (yes) => _approve(t, e, yes),
                    ),
                  if (t.loadingOlder)
                    const Padding(
                      padding: EdgeInsets.all(16),
                      child: Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                ],
              ),
        bottom: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 16),
          color: c.bgSubtle,
          child: Text(
            L(
              '手机上还不能发消息 · 请在电脑上',
              "You can't post from the phone yet — use the computer",
            ),
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
          ),
        ),
      ),
    );
  }

  Future<void> _approve(ChannelTimeline t, ChannelEntry e, bool yes) async {
    try {
      await t.approve(e.id, yes);
    } catch (err) {
      if (mounted) {
        showErrorSnack(context, actionError(err));
      }
    }
  }

  void _openImage(ChannelTimeline t, ChannelEntry e, int index) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => _ImagePage(load: () => t.image(e.id, index)),
      ),
    );
  }
}

/// 任务卡的状态：字和颜色
({String text, Color color}) taskStatus(AppColors c, String status) =>
    switch (status) {
      'done' => (text: L('完成', 'Done'), color: c.success),
      'failed' => (text: L('失败', 'Failed'), color: c.danger),
      'running' => (text: L('进行中', 'Running'), color: c.accent),
      'waiting' => (text: L('等你确认', 'Needs you'), color: c.warn),
      'approval' => (text: L('等主人同意', 'Awaiting owner'), color: c.warn),
      'stopped' => (text: L('已停止', 'Stopped'), color: c.textMuted),
      _ => (text: L('排队中', 'Queued'), color: c.textMuted),
    };

/// 事件那一行的字
String eventText(ChannelEntry e, Map<String, ChannelMember> members) {
  String name(String? id) => members[id]?.name ?? L('有人', 'Someone');
  final actor = name(e.actorId), target = name(e.targetId);
  return switch (e.event) {
    'joined' => L('$actor 加入了频道', '$actor joined'),
    'left' => L('$actor 离开了频道', '$actor left'),
    'added' || 'agentAdded' => L('$actor 添加了 $target', '$actor added $target'),
    'removed' ||
    'agentRemoved' => L('$actor 移除了 $target', '$actor removed $target'),
    'renamed' => L(
      '$actor 把频道改名为「${e.value ?? ''}」',
      '$actor renamed the channel to “${e.value ?? ''}”',
    ),
    'topic' => L('$actor 改了频道主题', '$actor changed the topic'),
    'archived' => L('$actor 归档了频道', '$actor archived the channel'),
    'restored' => L('$actor 恢复了频道', '$actor restored the channel'),
    _ => '',
  };
}

class _Entry extends StatelessWidget {
  const _Entry({
    required this.entry,
    required this.members,
    required this.onImage,
    required this.onSession,
    required this.onApprove,
  });
  final ChannelEntry entry;
  final Map<String, ChannelMember> members;
  final void Function(int index) onImage;
  final void Function(String sessionId) onSession;
  final Future<void> Function(bool yes) onApprove;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final e = entry;
    if (e.kind == 'event') {
      final text = eventText(e, members);
      if (text.isEmpty) return const SizedBox.shrink();
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
        ),
      );
    }
    final author = members[e.kind == 'task' ? e.assigneeId : e.authorId];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          MemberAvatar(author),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: author == null
                            ? L('成员', 'Member')
                            : author.you
                            ? L('我', 'Me')
                            : author.name,
                        style: TextStyle(
                          fontWeight: FontWeight.w600,
                          color: c.text,
                        ),
                      ),
                      TextSpan(
                        text: '  ${ago(e.at)}',
                        style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                      ),
                    ],
                  ),
                  style: const TextStyle(fontSize: Fs.ui),
                ),
                const SizedBox(height: 2),
                if (e.kind == 'task')
                  _TaskCard(e, onSession: onSession, onApprove: onApprove)
                else ...[
                  if (e.text.isNotEmpty)
                    e.markdown
                        ? ReplyMarkdown(e.text)
                        : Text(
                            e.text,
                            style: TextStyle(
                              fontSize: Fs.prose,
                              color: c.textBody,
                            ),
                          ),
                  if (e.images > 0)
                    Wrap(
                      spacing: 6,
                      children: [
                        for (var i = 0; i < e.images; i++)
                          ActionChip(
                            avatar: const Icon(Icons.image_outlined, size: 16),
                            label: Text(L('图 ${i + 1}', 'Image ${i + 1}')),
                            onPressed: () => onImage(i),
                          ),
                      ],
                    ),
                  for (final f in e.files)
                    Row(
                      children: [
                        Icon(Icons.attach_file, size: 14, color: c.textMuted),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            f,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: Fs.meta,
                              color: c.textMuted,
                            ),
                          ),
                        ),
                      ],
                    ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _TaskCard extends StatelessWidget {
  const _TaskCard(
    this.task, {
    required this.onSession,
    required this.onApprove,
  });
  final ChannelEntry task;
  final void Function(String sessionId) onSession;
  final Future<void> Function(bool yes) onApprove;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = taskStatus(c, task.status);
    final diff = task.diff;
    final reason = reasonText(task.reason);
    final error = task.error;
    final note =
        // 失败：先写原因（团队卡，§16.2），认不出的留错误原文
        (reason != null && error != null ? '$reason · $error' : reason) ??
        error ??
        task.summary ??
        (diff == null
            ? null
            : L(
                '改了代码 +${diff.added} −${diff.removed}',
                'Changed code +${diff.added} −${diff.removed}',
              ));
    final session = task.sessionId;
    return Container(
      margin: const EdgeInsets.only(top: 4),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: c.bgSurface,
        border: Border.all(color: c.borderCard),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  L('任务 · ${task.title}', 'Task · ${task.title}'),
                  style: TextStyle(
                    fontSize: Fs.ui,
                    fontWeight: FontWeight.w600,
                    color: c.text,
                  ),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: s.color.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(99),
                ),
                child: Text(
                  s.text,
                  style: TextStyle(fontSize: Fs.meta, color: s.color),
                ),
              ),
            ],
          ),
          if (note != null) ...[
            const SizedBox(height: 4),
            Text(
              note,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
          ],
          if (task.runs > 1)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                L('跑过 ${task.runs} 次', 'Ran ${task.runs} times'),
                style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
              ),
            ),
          // 队友派来、等我同意的（§16.2）：直接点；别的「等确认」还在电脑上处理
          if (task.canApprove)
            ApproveButtons(onAnswer: onApprove)
          else if (task.status == 'waiting' || task.status == 'approval')
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                task.status == 'approval'
                    ? L('等 AI 成员的主人同意', "Waiting for the AI member's owner")
                    : L('在电脑上处理', 'Handle it on the computer'),
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
            ),
          if (session != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                style: TextButton.styleFrom(
                  padding: EdgeInsets.zero,
                  minimumSize: const Size(0, 32),
                ),
                onPressed: () => onSession(session),
                child: Text(L('打开会话 ›', 'Open conversation ›')),
              ),
            ),
        ],
      ),
    );
  }
}

/// 点开看一张图：电脑上取（放不进一帧时电脑缩小了），能双指放大
class _ImagePage extends StatefulWidget {
  const _ImagePage({required this.load});
  final Future<Json> Function() load;

  @override
  State<_ImagePage> createState() => _ImagePageState();
}

class _ImagePageState extends State<_ImagePage> {
  late final Future<Json> _image = widget.load();

  @override
  Widget build(BuildContext context) {
    return AppScreen(
      title: L('图片', 'Image'),
      leading: RoundIconButton(
        icon: Icons.arrow_back,
        tooltip: L('返回', 'Back'),
        onPressed: () => Navigator.of(context).pop(),
      ),
      body: FutureBuilder<Json>(
        future: _image,
        builder: (context, snap) {
          if (snap.hasError) {
            return EmptyState(
              icon: Icons.broken_image_outlined,
              title: L('打不开这张图', "Can't open this image"),
              body: actionError(snap.error!),
            );
          }
          final data = str(snap.data?['dataBase64']);
          if (data == null) {
            return const Center(
              child: CircularProgressIndicator(strokeWidth: 2),
            );
          }
          return InteractiveViewer(
            child: Center(
              child: Image.memory(
                base64Decode(data),
                errorBuilder: (_, _, _) => EmptyState(
                  icon: Icons.broken_image_outlined,
                  title: L('打不开这张图', "Can't open this image"),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// 未读数的小圆标
class _Count extends StatelessWidget {
  const _Count(this.n);
  final int n;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      decoration: BoxDecoration(
        color: c.accent,
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        n > 99 ? '99+' : '$n',
        style: TextStyle(fontSize: Fs.meta, color: c.accentOn),
      ),
    );
  }
}

/// 「拒绝 / 同意」两个按钮：点了以后转圈，答完（或出错）恢复；电脑和云端再核对一次还在不在等
class ApproveButtons extends StatefulWidget {
  const ApproveButtons({super.key, required this.onAnswer});
  final Future<void> Function(bool yes) onAnswer;
  @override
  State<ApproveButtons> createState() => _ApproveButtonsState();
}

class _ApproveButtonsState extends State<ApproveButtons> {
  bool? _busy;

  Future<void> _answer(bool yes) async {
    setState(() => _busy = yes);
    try {
      await widget.onAnswer(yes);
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    Widget label(bool yes, String text) => _busy == yes
        ? const SizedBox.square(
            dimension: 14,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          )
        : Text(text);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        children: [
          OutlinedButton(
            onPressed: _busy == null ? () => _answer(false) : null,
            child: label(false, L('拒绝', 'Decline')),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: _busy == null ? () => _answer(true) : null,
            child: label(true, L('同意', 'Approve')),
          ),
        ],
      ),
    );
  }
}
