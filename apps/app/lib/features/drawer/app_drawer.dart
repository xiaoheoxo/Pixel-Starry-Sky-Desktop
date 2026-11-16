// 抽屉（照网页版第四轮，docs/mobile-remote.md §26）：大标题、「项目 / 最近」、电脑卡（点开换电脑）、搜索、
// 按项目分组的会话；底部「工具与项目」和账号（名字 + 余额，点了去设置；电脑不给账号时只显示「设置」，A4）。标题右边「新对话」，长按会话行弹出会话菜单（置顶、重命名、归档，A2）。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../connection/desktop_link.dart';
import '../../data/tasks.dart';
import '../../data/tools.dart';
import '../../protocol/json.dart';
import '../../i18n/i18n.dart';
import '../../ui/layout.dart';
import '../../ui/session_row.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../pairing/add_computer_screen.dart';
import '../pairing/texts.dart';
import '../../data/actions.dart';
import '../new_session/new_session_screen.dart';
import '../session/session_menu.dart';
import '../settings/settings_screen.dart';
import '../tools/tools.dart';
import '../session/session_screen.dart';

enum DrawerTab { projects, recent }

/// 离开抽屉去别的页面前收起它（宽屏常驻在左边时不用收）
void closeDrawer(BuildContext context) {
  final scaffold = Scaffold.maybeOf(context);
  if (scaffold != null && scaffold.isDrawerOpen) scaffold.closeDrawer();
}

/// 抽屉的分页记在内存里（重开 App 回到「项目」）
DrawerTab _tab = DrawerTab.projects;

class AppDrawer extends StatefulWidget {
  const AppDrawer({super.key, this.currentSessionId});

  /// 正在看的会话（高亮）
  final String? currentSessionId;

  @override
  State<AppDrawer> createState() => _AppDrawerState();
}

class _AppDrawerState extends State<AppDrawer> {
  final _search = TextEditingController();
  final _collapsed = <String>{};

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _open(String deviceId, SessionSummary s) {
    closeDrawer(context);
    if (s.id == widget.currentSessionId) return;
    // 从一个会话切到另一个：换掉当前页，不一层层叠起来
    openSession(
      context,
      deviceId,
      s.id,
      replace: widget.currentSessionId != null,
    );
  }

  void _menu(String deviceId, SessionSummary s) {
    final connections = AppScope.read(context).connections;
    showSessionMenu(
      context,
      record: s.record,
      actions: SessionActions(connections, deviceId, s.id),
      running: s.state == 'running' || s.state == 'starting',
      onNew: (projectId) {
        closeDrawer(context);
        openNewSession(context, deviceId, projectId: projectId);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final services = AppScope.of(context);
    final active = services.connections.active;
    final width = MediaQuery.sizeOf(context).width;
    return Drawer(
      width: drawerPinned(context)
          ? PaneWidth.drawer
          : width < 400
          ? width * 0.86
          : 340,
      backgroundColor: c.bgWorkbench,
      shape: const RoundedRectangleBorder(),
      child: SafeArea(
        child: ListenableBuilder(
          listenable: services.lists,
          builder: (context, _) {
            final data = active == null
                ? null
                : services.lists.get(active.deviceId);
            final sessions = data?.sessions ?? const <SessionSummary>[];
            final projects = data?.projects ?? const <Project>[];
            final query = _search.text;
            String nameOf(SessionSummary s) =>
                projectNameOf(projects, s.projectId);
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 8, 8),
                  child: Row(
                    children: [
                      Expanded(
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
                      if (active != null)
                        RoundIconButton(
                          icon: Icons.edit_square,
                          tooltip: L('新对话', 'New conversation'),
                          onPressed: () {
                            closeDrawer(context);
                            openNewSession(context, active.deviceId);
                          },
                        ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: SegmentedButton<DrawerTab>(
                    segments: [
                      ButtonSegment(
                        value: DrawerTab.projects,
                        label: Text(L('项目', 'Projects')),
                      ),
                      ButtonSegment(
                        value: DrawerTab.recent,
                        label: Text(L('最近', 'Recent')),
                      ),
                    ],
                    selected: {_tab},
                    showSelectedIcon: false,
                    style: SegmentedButton.styleFrom(
                      backgroundColor: Colors.transparent,
                      foregroundColor: c.textMuted,
                      selectedBackgroundColor: c.bgSelected,
                      selectedForegroundColor: c.text,
                      side: BorderSide(color: c.borderSubtle),
                      visualDensity: VisualDensity.compact,
                      textStyle: const TextStyle(
                        fontSize: Fs.ui,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    onSelectionChanged: (s) => setState(() => _tab = s.first),
                  ),
                ),
                if (active != null)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                    child: _ComputerCard(
                      deviceId: active.deviceId,
                      name: active.desktopName,
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: TextField(
                    controller: _search,
                    onChanged: (_) => setState(() {}),
                    style: TextStyle(fontSize: Fs.ui, color: c.text),
                    decoration: InputDecoration(
                      isDense: true,
                      contentPadding: const EdgeInsets.symmetric(vertical: 12),
                      hintStyle: TextStyle(fontSize: Fs.ui, color: c.textFaint),
                      prefixIcon: Icon(
                        Icons.search,
                        color: c.textMuted,
                        size: 20,
                      ),
                      hintText: L('搜索会话', 'Search sessions'),
                      filled: true,
                      fillColor: c.bgSubtle,
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(Radii.card),
                        borderSide: BorderSide.none,
                      ),
                    ),
                  ),
                ),
                Expanded(
                  child: active == null
                      ? const SizedBox()
                      : query.trim().isNotEmpty || _tab == DrawerTab.recent
                      ? _flat(
                          active.deviceId,
                          filterTasks(sessions, query, nameOf),
                          nameOf,
                        )
                      : _grouped(active.deviceId, sessions, projects),
                ),
                Divider(height: 1, color: c.borderSubtle),
                if (active != null)
                  ListRow(
                    title: L('工具与项目', 'Tools & projects'),
                    leading: Icon(
                      Icons.handyman_outlined,
                      color: c.textSecondary,
                    ),
                    onTap: () {
                      closeDrawer(context);
                      // 用抽屉自己的 context：宽屏常驻时在会话页的 ToolHost 下面，工具进右边栏
                      showToolPicker(
                        context,
                        active.deviceId,
                        openSession: widget.currentSessionId,
                      );
                    },
                  ),
                if (active == null)
                  ListRow(
                    title: L('设置', 'Settings'),
                    leading: Icon(
                      Icons.settings_outlined,
                      color: c.textSecondary,
                    ),
                    onTap: () {
                      closeDrawer(context);
                      openSettings(context);
                    },
                  )
                else
                  _AccountRow(
                    key: ValueKey(active.deviceId),
                    deviceId: active.deviceId,
                  ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _flat(
    String deviceId,
    List<SessionSummary> sessions,
    String Function(SessionSummary) nameOf,
  ) {
    final list = sessionList(sessions);
    final all = [...list.waiting, ...list.rest];
    if (all.isEmpty) {
      return EmptyState(
        icon: Icons.search_off,
        title: L('没有会话', 'No sessions'),
      );
    }
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      children: [
        for (final s in all)
          SessionRow(
            session: s,
            projectName: nameOf(s),
            selected: s.id == widget.currentSessionId,
            onTap: () => _open(deviceId, s),
            onLongPress: () => _menu(deviceId, s),
          ),
      ],
    );
  }

  Widget _grouped(
    String deviceId,
    List<SessionSummary> sessions,
    List<Project> projects,
  ) {
    final c = context.colors;
    final groups = projectGroups(sessions, projects, (_) => 8);
    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      children: [
        for (final g in groups) ...[
          InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () => setState(() {
              final key = g.project?.id ?? '';
              _collapsed.contains(key)
                  ? _collapsed.remove(key)
                  : _collapsed.add(key);
            }),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 12, 10, 6),
              child: Row(
                children: [
                  Icon(
                    _collapsed.contains(g.project?.id ?? '')
                        ? Icons.chevron_right
                        : Icons.expand_more,
                    size: 18,
                    color: c.textMuted,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      g.project?.name ?? L('其他', 'Other'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: Fs.meta,
                        fontWeight: FontWeight.w600,
                        color: c.textSecondary,
                      ),
                    ),
                  ),
                  if (g.archived.isNotEmpty)
                    Text(
                      L(
                        '已归档 ${g.archived.length}',
                        '${g.archived.length} archived',
                      ),
                      style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                    ),
                  if (g.project != null)
                    SizedBox.square(
                      dimension: 28,
                      child: IconButton(
                        padding: EdgeInsets.zero,
                        iconSize: 18,
                        tooltip: L(
                          '在「${g.project!.name}」里新建对话',
                          'New conversation in “${g.project!.name}”',
                        ),
                        onPressed: () {
                          closeDrawer(context);
                          openNewSession(
                            context,
                            deviceId,
                            projectId: g.project!.id,
                          );
                        },
                        icon: Icon(Icons.add, color: c.textMuted),
                      ),
                    ),
                ],
              ),
            ),
          ),
          if (!_collapsed.contains(g.project?.id ?? '')) ...[
            for (final s in g.sessions)
              SessionRow(
                session: s,
                selected: s.id == widget.currentSessionId,
                onTap: () => _open(deviceId, s),
                onLongPress: () => _menu(deviceId, s),
              ),
            if (g.sessions.isEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(36, 2, 10, 8),
                child: Text(
                  L('还没有会话', 'No sessions yet'),
                  style: TextStyle(fontSize: Fs.meta, color: c.textFaint),
                ),
              ),
            if (g.more > 0)
              Padding(
                padding: const EdgeInsets.fromLTRB(36, 2, 10, 8),
                child: Text(
                  L('还有 ${g.more} 个', '${g.more} more'),
                  style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                ),
              ),
          ],
        ],
      ],
    );
  }
}

/// 电脑卡：名字 + 连接状态；点开在几台电脑之间切换
class _ComputerCard extends StatelessWidget {
  const _ComputerCard({required this.deviceId, required this.name});
  final String deviceId;
  final String name;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final connections = AppScope.of(context).connections;
    final state = connections.state(deviceId);
    final ready = state == LinkState.ready;
    return Material(
      color: c.bgSubtle,
      borderRadius: BorderRadius.circular(Radii.card),
      child: InkWell(
        borderRadius: BorderRadius.circular(Radii.card),
        onTap: () => showPanel<void>(
          context,
          (_) => _ComputerPicker(
            onAdd: () {
              closeDrawer(context);
              Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const AddComputerScreen(canClose: true),
                ),
              );
            },
          ),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: [
              Icon(Icons.computer, size: 20, color: c.textSecondary),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: Fs.ui,
                        fontWeight: FontWeight.w600,
                        color: c.text,
                      ),
                    ),
                    Text(
                      linkStateText(state) ?? L('已连接', 'Connected'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: Fs.meta,
                        color: ready ? c.statusOnline : c.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              Icon(Icons.unfold_more, color: c.textMuted, size: 18),
            ],
          ),
        ),
      ),
    );
  }
}

class _ComputerPicker extends StatelessWidget {
  const _ComputerPicker({required this.onAdd});
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final connections = AppScope.of(context).connections;
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Section(
        title: L('电脑', 'Computers'),
        children: [
          for (final p in connections.pairings)
            ListRow(
              title: p.desktopName,
              subtitle:
                  linkStateText(connections.state(p.deviceId)) ??
                  L('已连接', 'Connected'),
              leading: Icon(Icons.computer, color: c.textSecondary),
              trailing: p.deviceId == connections.active?.deviceId
                  ? Icon(Icons.check, color: c.accent)
                  : const SizedBox(),
              onTap: () {
                connections.select(p.deviceId);
                Navigator.of(context).pop();
              },
            ),
          ListRow(
            title: L('添加电脑', 'Add computer'),
            leading: Icon(Icons.add_circle_outline, color: c.textSecondary),
            onTap: () {
              Navigator.of(context).pop();
              onAdd();
            },
          ),
        ],
      ),
    );
  }
}

/// 抽屉底部的账号：头像（名字第一个字）、名字、余额或套餐；点了去设置。
/// 电脑不认 account（旧版本）、没连上、还没取到时只显示「设置」
class _AccountRow extends StatefulWidget {
  const _AccountRow({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<_AccountRow> createState() => _AccountRowState();
}

class _AccountRowState extends State<_AccountRow> {
  late final ToolData _data = ToolData(
    AppScope.read(context).connections,
    widget.deviceId,
    'account',
    const [],
  );

  @override
  void dispose() {
    _data.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final connections = AppScope.of(context).connections;
    return ListenableBuilder(
      listenable: _data,
      builder: (context, _) {
        final raw = objOrNull(_data.data);
        final ready = connections.state(widget.deviceId) == LinkState.ready;
        final account = raw == null || !ready ? null : Account(raw);
        void open() {
          closeDrawer(context);
          openSettings(context);
        }

        if (account == null || account.name.isEmpty) {
          return ListRow(
            title: L('设置', 'Settings'),
            leading: Icon(Icons.settings_outlined, color: c.textSecondary),
            onTap: open,
          );
        }
        return InkWell(
          onTap: open,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 16,
                  backgroundColor: c.bgSelected,
                  child: Text(
                    accountInitial(account.name),
                    style: TextStyle(
                      fontSize: Fs.ui,
                      fontWeight: FontWeight.w600,
                      color: c.text,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        account.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: Fs.ui,
                          fontWeight: FontWeight.w500,
                          color: c.text,
                        ),
                      ),
                      Text(
                        accountLine(account),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                    ],
                  ),
                ),
                Icon(Icons.settings_outlined, color: c.textMuted, size: 20),
              ],
            ),
          ),
        );
      },
    );
  }
}
