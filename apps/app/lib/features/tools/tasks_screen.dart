// 任务（docs/mobile-app.md §8.4，照网页版 features/tools/TodoScreen.tsx，同电脑的任务面板）：这个项目的待办（我的）和 AI 的计划。
// 按状态分组；每行左边的状态圈点一下完成 / 重新打开，点正文出菜单（开始做、完成 / 重新打开、交给 AI）；底部加待办。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/tasks.dart' show Tone;
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../session/items.dart' show TodoCard;
import 'common.dart';

/// 已完成先列几条
const _doneStep = 10;

class TasksScreen extends StatefulWidget {
  const TasksScreen(this.tool, {super.key});
  final ToolContext tool;
  @override
  State<TasksScreen> createState() => _TasksScreenState();
}

class _TasksScreenState extends State<TasksScreen> {
  late final ToolData _state = ToolData(
    AppScope.read(context).connections,
    widget.tool.deviceId,
    'projectTools:tasks',
    [widget.tool.project.id],
    watch: true,
  );
  final _title = TextEditingController();
  bool _busy = false;
  String? _error;
  int _doneLimit = _doneStep;

  @override
  void dispose() {
    _state.dispose();
    _title.dispose();
    super.dispose();
  }

  Future<bool> _write(String method, List<Object?> args) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await callTool(
        AppScope.read(context).connections,
        widget.tool.deviceId,
        method,
        args,
      );
      _state.reload();
      return true;
    } catch (e) {
      _error = toolError(e);
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _add() async {
    final text = _title.text.trim();
    if (text.isEmpty) return;
    final ok = await _write('projectTools:createTask', [
      widget.tool.project.id,
      {'title': text},
    ]);
    if (ok) _title.clear();
  }

  void _setStatus(ManualTask t, String status) =>
      _write('projectTools:updateTask', [
        t.id,
        {'status': status},
      ]);

  void _menu(ManualTask t) {
    final done = t.status == 'completed';
    showPanel<void>(
      context,
      (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 12),
                child: Text(
                  t.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: Fs.section,
                    fontWeight: FontWeight.w600,
                    color: sheet.colors.text,
                  ),
                ),
              ),
              Section(
                children: [
                  if (t.status != 'in_progress' && !done)
                    ListRow(
                      title: L('开始做', 'Start'),
                      leading: const Icon(Icons.play_circle_outline),
                      onTap: () {
                        Navigator.pop(sheet);
                        _setStatus(t, 'in_progress');
                      },
                    ),
                  ListRow(
                    title: done
                        ? L('重新打开', 'Reopen')
                        : L('标记完成', 'Mark as done'),
                    leading: Icon(
                      done ? Icons.undo : Icons.check_circle_outline,
                    ),
                    onTap: () {
                      Navigator.pop(sheet);
                      _setStatus(t, done ? 'pending' : 'completed');
                    },
                  ),
                  ListRow(
                    title: L('交给 AI', 'Hand to AI'),
                    subtitle: L(
                      '在这个项目里新建会话，任务内容先放进输入框',
                      'Start a new conversation in this project with the task in the input box',
                    ),
                    leading: const Icon(Icons.auto_awesome_outlined),
                    onTap: () {
                      Navigator.pop(sheet);
                      if (t.status == 'pending') _setStatus(t, 'in_progress');
                      widget.tool.newSession(
                        widget.tool.project.id,
                        taskPrompt(t),
                      );
                    },
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
    final services = AppScope.of(context);
    final c = context.colors;
    return ListenableBuilder(
      listenable: Listenable.merge([_state, services.connections]),
      builder: (context, _) {
        final data = objOrNull(_state.data);
        final tasks = [for (final t in objList(data?['tasks'])) ManualTask(t)];
        final plans = objList(data?['plans']);
        final canAct = canActOn(services.connections, widget.tool.deviceId);
        final error = _error ?? _state.error;
        return ToolFrame(
          title: L('任务', 'Tasks'),
          heading: widget.tool.project.name,
          loading: _state.loading,
          onRefresh: _state.reload,
          footer: canAct
              ? Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          controller: _title,
                          maxLength: 200,
                          textInputAction: TextInputAction.done,
                          onSubmitted: (_) => _add(),
                          onChanged: (_) => setState(() {}),
                          style: TextStyle(fontSize: Fs.prose, color: c.text),
                          decoration: InputDecoration(
                            counterText: '',
                            isDense: true,
                            hintText: L('添加待办…', 'Add a to-do…'),
                            hintStyle: TextStyle(color: c.textFaint),
                            filled: true,
                            fillColor: c.bgSurface,
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 16,
                              vertical: 12,
                            ),
                            enabledBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(
                                Radii.composer,
                              ),
                              borderSide: BorderSide(color: c.borderComposer),
                            ),
                            focusedBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(
                                Radii.composer,
                              ),
                              borderSide: BorderSide(color: c.borderCard),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IconButton.filled(
                        tooltip: L('添加', 'Add'),
                        style: IconButton.styleFrom(
                          backgroundColor: c.btnPrimaryBg,
                          foregroundColor: c.btnPrimaryText,
                          disabledBackgroundColor: c.bgSubtle,
                        ),
                        onPressed: _busy || _title.text.trim().isEmpty
                            ? null
                            : _add,
                        icon: const Icon(Icons.add),
                      ),
                    ],
                  ),
                )
              : null,
          children: [
            if (data == null)
              ToolLoading(error: _state.error)
            else ...[
              if (error != null) ToolBanner(error, tone: Tone.danger),
              if (tasks.isEmpty && plans.isEmpty)
                EmptyState(
                  icon: Icons.checklist,
                  title: L('还没有任务', 'No tasks yet'),
                  body: L(
                    '在下面添加一条待办，或者让 AI 做个计划。',
                    'Add a to-do below, or ask AI to make a plan.',
                  ),
                ),
              for (final g in taskGroups(tasks)) ...[
                GroupTitle(g.title, count: g.tasks.length),
                Group(
                  children: [
                    for (final t
                        in g.status == 'completed'
                            ? g.tasks.take(_doneLimit)
                            : g.tasks)
                      _TaskRow(
                        task: t,
                        canAct: canAct && !_busy,
                        onToggle: () => _setStatus(
                          t,
                          t.status == 'completed' ? 'pending' : 'completed',
                        ),
                        onMenu: () => _menu(t),
                      ),
                    if (g.status == 'completed' && g.tasks.length > _doneLimit)
                      TextButton(
                        onPressed: () =>
                            setState(() => _doneLimit += _doneStep),
                        child: Text(
                          L(
                            '显示更多（还有 ${g.tasks.length - _doneLimit} 条）',
                            'Show more (${g.tasks.length - _doneLimit} left)',
                          ),
                          style: const TextStyle(fontSize: Fs.meta),
                        ),
                      ),
                  ],
                ),
              ],
              for (final p in plans) ...[
                GroupTitle(
                  '${L('AI 计划', 'AI plan')} · ${(str(p['title']) ?? '').isEmpty ? L('未命名会话', 'Untitled conversation') : str(p['title'])}',
                ),
                InkWell(
                  borderRadius: BorderRadius.circular(Radii.card),
                  onTap: () =>
                      widget.tool.openSession(str(p['sessionId']) ?? ''),
                  child: TodoCard(Item(obj(p['item']))),
                ),
                const SizedBox(height: 12),
              ],
            ],
          ],
        );
      },
    );
  }
}

class _TaskRow extends StatelessWidget {
  const _TaskRow({
    required this.task,
    required this.canAct,
    required this.onToggle,
    required this.onMenu,
  });
  final ManualTask task;
  final bool canAct;
  final VoidCallback onToggle;
  final VoidCallback onMenu;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final done = task.status == 'completed';
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        IconButton(
          tooltip: done
              ? L('重新打开「${task.title}」', 'Reopen “${task.title}”')
              : L('完成「${task.title}」', 'Complete “${task.title}”'),
          onPressed: canAct ? onToggle : null,
          icon: Icon(
            done
                ? Icons.check_circle
                : task.status == 'in_progress'
                ? Icons.radio_button_checked
                : Icons.radio_button_unchecked,
            size: 22,
            color: done || task.status == 'in_progress'
                ? c.accentText
                : c.textMuted,
          ),
        ),
        Expanded(
          child: InkWell(
            onTap: canAct ? onMenu : null,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(0, 12, 16, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    task.title,
                    style: TextStyle(
                      fontSize: Fs.ui,
                      color: done ? c.textMuted : c.text,
                      decoration: done ? TextDecoration.lineThrough : null,
                    ),
                  ),
                  if (task.note.trim().isNotEmpty)
                    Text(
                      task.note.trim(),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
