// 概览（首页）：抽屉 + 当前电脑的会话列表（等你处理在前）；没连上时顶上一条状态横幅
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../connection/desktop_link.dart';
import '../../data/tasks.dart';
import '../../i18n/i18n.dart';
import '../../ui/session_row.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../drawer/app_drawer.dart';
import '../pairing/texts.dart';
import '../new_session/new_session_screen.dart';
import '../session/session_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final services = AppScope.of(context);
    final active = services.connections.active;
    if (active == null) return const SizedBox();
    final state = services.connections.state(active.deviceId);
    return AppScreen(
      title: active.desktopName,
      subtitle: linkStateText(state) ?? L('已连接', 'Connected'),
      drawer: const AppDrawer(),
      leading: Builder(
        builder: (context) => RoundIconButton(
          icon: Icons.menu,
          tooltip: L('菜单', 'Menu'),
          onPressed: () => Scaffold.of(context).openDrawer(),
        ),
      ),
      trailing: [
        RoundIconButton(
          icon: Icons.edit_square,
          tooltip: L('新对话', 'New conversation'),
          onPressed: () => openNewSession(context, active.deviceId),
        ),
      ],
      body: ListenableBuilder(
        listenable: services.lists,
        builder: (context, _) {
          final data = services.lists.get(active.deviceId);
          final list = sessionList(data.sessions);
          String nameOf(SessionSummary s) =>
              projectNameOf(data.projects, s.projectId);
          return RefreshIndicator(
            onRefresh: () => services.lists.refresh(active.deviceId),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 32),
              children: [
                if (state != LinkState.ready)
                  StateBanner(deviceId: active.deviceId, state: state),
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
                  child: Text(
                    L('会话', 'Sessions'),
                    style: TextStyle(
                      fontSize: Fs.title,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.56,
                      color: c.text,
                    ),
                  ),
                ),
                if (!data.loaded && state == LinkState.ready)
                  const Padding(
                    padding: EdgeInsets.all(32),
                    child: Center(
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  )
                else if (data.loaded &&
                    list.waiting.isEmpty &&
                    list.rest.isEmpty)
                  EmptyState(
                    icon: Icons.forum_outlined,
                    title: L('还没有会话', 'No sessions yet'),
                    body: L(
                      '在电脑上开始一个会话，这里就能看到。',
                      'Start a session on your computer and it shows up here.',
                    ),
                  ),
                if (list.waiting.isNotEmpty) ...[
                  _GroupTitle(L('等你处理', 'Needs you')),
                  for (final s in list.waiting)
                    SessionRow(
                      session: s,
                      projectName: nameOf(s),
                      onTap: () => openSession(context, active.deviceId, s.id),
                    ),
                ],
                if (list.rest.isNotEmpty) ...[
                  if (list.waiting.isNotEmpty)
                    _GroupTitle(L('其他会话', 'Other sessions')),
                  for (final s in list.rest)
                    SessionRow(
                      session: s,
                      projectName: nameOf(s),
                      onTap: () => openSession(context, active.deviceId, s.id),
                    ),
                ],
              ],
            ),
          );
        },
      ),
    );
  }
}

class _GroupTitle extends StatelessWidget {
  const _GroupTitle(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(10, 12, 10, 4),
    child: Text(
      text,
      style: TextStyle(
        fontSize: Fs.meta,
        fontWeight: FontWeight.w600,
        color: context.colors.textMuted,
      ),
    ),
  );
}

/// 没连上时的状态横幅：断线时带「立即重试」，被顶掉时带「重新连接」（会话页也用）
class StateBanner extends StatelessWidget {
  const StateBanner({super.key, required this.deviceId, required this.state});
  final String deviceId;
  final LinkState? state;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final connections = AppScope.of(context).connections;
    final retries = connections.link(deviceId)?.retries ?? 0;
    final action = switch (state) {
      LinkState.offline => (
        L('立即重试', 'Retry now'),
        () => connections.retryNow(deviceId),
      ),
      LinkState.replaced => (
        L('重新连接', 'Reconnect'),
        () => connections.reconnect(deviceId),
      ),
      _ => null,
    };
    final attempt = state == LinkState.offline && retries > 1
        ? L('（第 $retries 次）', ' (attempt $retries)')
        : '';
    return Container(
      margin: const EdgeInsets.fromLTRB(4, 4, 4, 8),
      padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Row(
        children: [
          Icon(
            state == LinkState.removed || state == LinkState.incompatible
                ? Icons.error_outline
                : Icons.cloud_off,
            size: 18,
            color: c.textMuted,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '${linkStateText(state)}$attempt',
              style: TextStyle(fontSize: Fs.list, color: c.textSecondary),
            ),
          ),
          if (action != null)
            TextButton(onPressed: action.$2, child: Text(action.$1)),
        ],
      ),
    );
  }
}
