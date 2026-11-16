// 工具的入口（docs/mobile-app.md §8.4）：打开某个工具、抽屉里「工具」的选择面板、加项目。
// 手机上工具整页推进去；宽 ≥ 1280 时会话页给一个 ToolHost（common.dart），工具放在会话右边一栏，不盖住对话。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/tasks.dart';
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../new_session/new_session_screen.dart';
import '../session/session_screen.dart';
import 'artifacts_screen.dart';
import 'common.dart';
import 'files_screen.dart';
import 'git_screen.dart';
import 'tasks_screen.dart';

Widget toolPage(ToolContext tool, ToolId id) => switch (id) {
  ToolId.git => GitScreen(tool),
  ToolId.files => FilesScreen(tool),
  ToolId.artifacts => ArtifactsScreen(tool),
  ToolId.tasks => TasksScreen(tool),
};

IconData toolIcon(ToolId id) => switch (id) {
  ToolId.git => Icons.account_tree_outlined,
  ToolId.files => Icons.folder_outlined,
  ToolId.artifacts => Icons.inventory_2_outlined,
  ToolId.tasks => Icons.checklist,
};

/// 打开一个工具；记下这台电脑上次选的项目。宽屏会话页给了 showSide（或在 ToolHost 下面）时放进右边栏
void openTool(
  BuildContext context,
  String deviceId,
  Project project,
  ToolId id, {
  void Function(Widget page)? showSide,
}) {
  final services = AppScope.read(context);
  services.settings.setProjectFor(deviceId, project.id);
  // 打开会话、新建会话都在主导航里（右边栏、抽屉关掉后，这里的 context 可能已经没了）
  final nav = Navigator.of(context, rootNavigator: true);
  final tool = ToolContext(
    deviceId: deviceId,
    project: project,
    openSession: (sessionId) => openSession(nav.context, deviceId, sessionId),
    newSession: (projectId, draft) => openNewSession(
      nav.context,
      deviceId,
      projectId: projectId,
      draft: draft,
    ),
  );
  final side = showSide ?? ToolHost.maybeOf(context)?.show;
  if (side != null) {
    side(toolPage(tool, id));
  } else {
    nav.push(MaterialPageRoute<void>(builder: (_) => toolPage(tool, id)));
  }
}

/// 抽屉里「工具」：先看作用于哪个项目（能换），再选工具；底下「添加项目」
Future<void> showToolPicker(
  BuildContext context,
  String deviceId, {
  String? openSession,
}) {
  final nav = Navigator.of(context, rootNavigator: true);
  // 从常驻抽屉（宽屏会话页）打开时，工具放进右边栏
  final side = context.getInheritedWidgetOfExactType<ToolHost>()?.show;
  return showPanel<void>(
    context,
    (sheet) => _ToolPicker(
      deviceId: deviceId,
      openSession: openSession,
      onTool: (project, id) {
        Navigator.pop(sheet);
        openTool(nav.context, deviceId, project, id, showSide: side);
      },
      onAddProject: () {
        Navigator.pop(sheet);
        openAddProject(nav.context, deviceId);
      },
    ),
  );
}

class _ToolPicker extends StatefulWidget {
  const _ToolPicker({
    required this.deviceId,
    required this.openSession,
    required this.onTool,
    required this.onAddProject,
  });
  final String deviceId;
  final String? openSession;
  final void Function(Project project, ToolId id) onTool;
  final VoidCallback onAddProject;
  @override
  State<_ToolPicker> createState() => _ToolPickerState();
}

class _ToolPickerState extends State<_ToolPicker> {
  String? _chosen;
  bool _picking = false;

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final c = context.colors;
    final data = services.lists.get(widget.deviceId);
    final project = _chosen != null
        ? currentProject(data.projects, const [], null, _chosen)
        : currentProject(
            data.projects,
            data.sessions,
            widget.openSession,
            services.settings.projectFor(widget.deviceId),
          );
    final canAct = canActOn(services.connections, widget.deviceId);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.sizeOf(context).height * 0.8,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
              child: Text(
                L('工具与项目', 'Tools & projects'),
                style: TextStyle(
                  fontSize: Fs.section,
                  fontWeight: FontWeight.w600,
                  color: c.text,
                ),
              ),
            ),
            if (project == null)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(
                  L('电脑上还没有项目。', 'No projects on the computer yet.'),
                  style: TextStyle(fontSize: Fs.list, color: c.textMuted),
                ),
              )
            else ...[
              Section(
                children: [
                  ListRow(
                    title: project.name,
                    subtitle: project.path,
                    leading: Icon(Icons.folder_outlined, color: c.accentText),
                    trailing: Icon(
                      _picking ? Icons.expand_less : Icons.unfold_more,
                      color: c.textMuted,
                    ),
                    onTap: data.projects.length < 2
                        ? null
                        : () => setState(() => _picking = !_picking),
                  ),
                  if (_picking)
                    for (final p in data.projects)
                      if (p.id != project.id)
                        ListRow(
                          title: p.name,
                          subtitle: p.path,
                          leading: const SizedBox(width: 24),
                          onTap: () => setState(() {
                            _chosen = p.id;
                            _picking = false;
                          }),
                        ),
                ],
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  for (final id in ToolId.values) ...[
                    if (id != ToolId.git) const SizedBox(width: 8),
                    Expanded(
                      child: ToolTile(
                        id: id,
                        onTap: () => widget.onTool(project, id),
                      ),
                    ),
                  ],
                ],
              ),
            ],
            if (canAct) ...[
              const SizedBox(height: 16),
              Section(
                children: [
                  ListRow(
                    title: L('添加项目', 'Add project'),
                    leading: Icon(
                      Icons.create_new_folder_outlined,
                      color: c.textSecondary,
                    ),
                    onTap: widget.onAddProject,
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 四格里的一格：图标 + 工具名
class ToolTile extends StatelessWidget {
  const ToolTile({super.key, required this.id, required this.onTap});
  final ToolId id;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: c.bgSubtle,
      borderRadius: BorderRadius.circular(Radii.card),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Column(
            children: [
              Icon(toolIcon(id), size: 22, color: c.text),
              const SizedBox(height: 6),
              Text(
                toolName(id),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// 加项目（照网页版 features/projects/AddProject.tsx）
// ---------------------------------------------------------------------------

void openAddProject(BuildContext context, String deviceId) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => AddProjectScreen(deviceId: deviceId),
    ),
  );
}

/// 从最近那个项目的上一级开始翻电脑上的文件夹，也能直接输入路径；选一个加成项目（只在这台电脑上，要「可操作」）
class AddProjectScreen extends StatefulWidget {
  const AddProjectScreen({super.key, required this.deviceId});
  final String deviceId;
  @override
  State<AddProjectScreen> createState() => _AddProjectScreenState();
}

class _AddProjectScreenState extends State<AddProjectScreen> {
  String? _path;
  ToolData? _list;
  final _typed = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final data = AppScope.read(context).lists.get(widget.deviceId);
      final latest = currentProject(data.projects, data.sessions, null, null);
      _go(latest == null ? null : _parent(latest.path));
    });
  }

  @override
  void dispose() {
    _list?.dispose();
    _typed.dispose();
    super.dispose();
  }

  static String? _parent(String path) {
    final trimmed = path.replaceAll(RegExp(r'[\\/]+$'), '');
    final i = trimmed.lastIndexOf(RegExp(r'[\\/]'));
    return i <= 0 ? null : trimmed.substring(0, i);
  }

  void _go(String? path) {
    _list?.dispose();
    setState(() {
      _path = path;
      _list = ToolData(
        AppScope.read(context).connections,
        widget.deviceId,
        'directories',
        [?path],
      );
    });
  }

  static bool _same(String a, String b) =>
      a.replaceAll(RegExp(r'[\\/]+$'), '').toLowerCase() ==
      b.replaceAll(RegExp(r'[\\/]+$'), '').toLowerCase();

  Future<void> _add(String path) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await callTool(
        AppScope.read(context).connections,
        widget.deviceId,
        'addProject',
        [path],
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(L('已添加项目', 'Project added'))));
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = toolError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final list = _list;
    final services = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([?list, services.lists]),
      builder: (context, _) {
        final dir = objOrNull(list?.data);
        final dirPath = str(dir?['path']);
        final parent = str(dir?['parent']);
        Project? already;
        if (dirPath != null) {
          for (final p in services.lists.get(widget.deviceId).projects) {
            if (_same(p.path, dirPath)) already = p;
          }
        }
        final sep = (dirPath ?? '').contains(r'\') ? r'\' : '/';
        String child(String name) =>
            '${(dirPath ?? '').replaceAll(RegExp(r'[\\/]+$'), '')}$sep$name';
        return AppScreen(
          title: L('添加项目', 'Add project'),
          subtitle: L('选电脑上的一个文件夹', 'Choose a folder on your computer'),
          leading: RoundIconButton(
            icon: Icons.arrow_back,
            tooltip: L('返回', 'Back'),
            onPressed: () => Navigator.of(context).maybePop(),
          ),
          bottom: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
            child: PrimaryButton(
              icon: Icons.create_new_folder_outlined,
              busy: _busy,
              label: already != null
                  ? L(
                      '「${already.name}」已经是项目',
                      '“${already.name}” is already a project',
                    )
                  : dirPath != null
                  ? L(
                      '把「${baseName(dirPath)}」加为项目',
                      'Add “${baseName(dirPath)}” as a project',
                    )
                  : L('加为项目', 'Add as project'),
              onPressed: dirPath == null || already != null
                  ? null
                  : () => _add(dirPath),
            ),
          ),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            children: [
              if (dirPath != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
                  child: Text(
                    dirPath,
                    style: TextStyle(
                      fontSize: Fs.ui,
                      fontFamily: 'monospace',
                      color: c.text,
                    ),
                  ),
                ),
              TextField(
                controller: _typed,
                autocorrect: false,
                textInputAction: TextInputAction.go,
                onSubmitted: (v) {
                  if (v.trim().isEmpty) return;
                  _go(v.trim());
                  _typed.clear();
                },
                style: TextStyle(
                  fontSize: Fs.meta,
                  fontFamily: 'monospace',
                  color: c.text,
                ),
                decoration: InputDecoration(
                  isDense: true,
                  hintText: L('输入路径跳过去…', 'Go to a path…'),
                  hintStyle: TextStyle(color: c.textFaint),
                  filled: true,
                  fillColor: c.bgSubtle,
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(Radii.composer),
                    borderSide: BorderSide.none,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              if (_error != null) ToolBanner(_error!, tone: Tone.danger),
              if (dir == null)
                ToolLoading(error: list?.error)
              else
                Group(
                  children: [
                    if (parent != null)
                      _DirRow(
                        name: '..',
                        icon: Icons.arrow_upward,
                        onTap: () => _go(parent),
                      ),
                    for (final name in [
                      for (final d in (dir['directories'] as List?) ?? const [])
                        '$d',
                    ])
                      _DirRow(
                        name: name,
                        icon: Icons.folder_outlined,
                        onTap: () => _go(child(name)),
                      ),
                  ],
                ),
              if (_path == null && dir != null)
                ToolNote(
                  L(
                    '从电脑上的用户主目录开始。',
                    "Starting from the computer's home folder.",
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _DirRow extends StatelessWidget {
  const _DirRow({required this.name, required this.icon, required this.onTap});
  final String name;
  final IconData icon;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            Icon(icon, size: 20, color: c.accentText),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: Fs.ui, color: c.text),
              ),
            ),
            Icon(Icons.chevron_right, size: 18, color: c.textFaint),
          ],
        ),
      ),
    );
  }
}
