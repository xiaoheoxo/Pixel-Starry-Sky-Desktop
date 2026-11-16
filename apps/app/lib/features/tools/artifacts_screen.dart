// 产物（docs/mobile-app.md §8.4，照网页版 features/tools/ArtifactsScreen.tsx，同电脑的产物面板）：
// 这个项目最近 AI 改过的文件（按轮）和交给你的文件。点文件看那次改动，点一轮的标题打开那个会话。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import '../../data/tasks.dart' show Tone, ago;
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/type.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/widgets.dart';
import '../session/items.dart' show DiffView;
import 'common.dart';

class ArtifactsScreen extends StatefulWidget {
  const ArtifactsScreen(this.tool, {super.key});
  final ToolContext tool;
  @override
  State<ArtifactsScreen> createState() => _ArtifactsScreenState();
}

class _ArtifactsScreenState extends State<ArtifactsScreen> {
  int _days = 7;
  ToolData? _list;

  ToolData _load() {
    _list?.dispose();
    return _list = ToolData(
      AppScope.read(context).connections,
      widget.tool.deviceId,
      'engine:artifacts',
      [
        {'projectId': widget.tool.project.id, 'days': _days},
      ],
    );
  }

  @override
  void dispose() {
    _list?.dispose();
    super.dispose();
  }

  void _change(String sessionId, String itemId, String path) =>
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => _ChangePage(
            tool: widget.tool,
            sessionId: sessionId,
            itemId: itemId,
            path: path,
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final list = _list ?? _load();
    return ListenableBuilder(
      listenable: list,
      builder: (context, _) {
        final r = objOrNull(list.data);
        final turns = [
          for (final t in objList(r?['turns']))
            if (objList(t['files']).isNotEmpty) t,
        ];
        final delivered = objList(r?['delivered']);
        final outside = (r?['outsideCount'] as num?)?.toInt() ?? 0;
        return ToolFrame(
          title: L('产物', 'Artifacts'),
          heading: widget.tool.project.name,
          loading: list.loading,
          onRefresh: list.reload,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: SegmentedButton<int>(
                showSelectedIcon: false,
                style: SegmentedButton.styleFrom(
                  backgroundColor: Colors.transparent,
                  foregroundColor: c.textMuted,
                  selectedBackgroundColor: c.bgSelected,
                  selectedForegroundColor: c.text,
                  side: BorderSide(color: c.borderSubtle),
                  visualDensity: VisualDensity.compact,
                  textStyle: const TextStyle(fontSize: Fs.ui),
                ),
                segments: [
                  ButtonSegment(value: 1, label: Text(L('今天', 'Today'))),
                  ButtonSegment(value: 7, label: Text(L('7 天', '7 days'))),
                  ButtonSegment(value: 30, label: Text(L('30 天', '30 days'))),
                ],
                selected: {_days},
                onSelectionChanged: (v) => setState(() {
                  _days = v.first;
                  _load();
                }),
              ),
            ),
            if (r == null)
              ToolLoading(error: list.error)
            else if (turns.isEmpty && delivered.isEmpty)
              EmptyState(
                icon: Icons.inventory_2_outlined,
                title: L('没有产物', 'No artifacts'),
                body: L(
                  '这段时间 AI 没有在这个项目里改过文件。',
                  "AI didn't change any files in this project during this period.",
                ),
              )
            else ...[
              if (list.error != null)
                ToolBanner(list.error!, tone: Tone.danger),
              if (delivered.isNotEmpty) ...[
                GroupTitle(L('交给你的', 'Delivered to you')),
                Group(
                  children: [
                    for (final d in delivered)
                      _PathRow(
                        path: str(d['local']) ?? str(d['path']) ?? '',
                        icon: Icons.inventory_2_outlined,
                        badge: Text(
                          deliveryText(str(d['type']) ?? ''),
                          style: TextStyle(
                            fontSize: Fs.label,
                            color: c.textFaint,
                          ),
                        ),
                        trailing: Text(
                          d['exists'] == true
                              ? (d['bytes'] is num
                                    ? fileSize((d['bytes'] as num).toInt())
                                    : '')
                              : L('已删除', 'Deleted'),
                          style: TextStyle(
                            fontSize: Fs.label,
                            color: c.textFaint,
                          ),
                        ),
                        onTap: () => _change(
                          str(d['sessionId']) ?? '',
                          str(d['itemId']) ?? '',
                          str(d['path']) ?? '',
                        ),
                      ),
                  ],
                ),
              ],
              for (final t in turns)
                Group(
                  children: [
                    InkWell(
                      onTap: () =>
                          widget.tool.openSession(str(t['sessionId']) ?? ''),
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    _turnTitle(t),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: Fs.ui,
                                      color: c.text,
                                    ),
                                  ),
                                  Text(
                                    _turnMeta(t),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: Fs.meta,
                                      color: c.textMuted,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            Icon(
                              Icons.chevron_right,
                              size: 18,
                              color: c.textFaint,
                            ),
                          ],
                        ),
                      ),
                    ),
                    for (final f in objList(t['files']))
                      _PathRow(
                        path: str(f['local']) ?? str(f['path']) ?? '',
                        icon: Icons.difference_outlined,
                        badge: switch (str(f['kind'])) {
                          'add' => Text(
                            L('新建', 'New'),
                            style: TextStyle(
                              fontSize: Fs.label,
                              color: c.success,
                            ),
                          ),
                          'delete' => Text(
                            L('删除', 'Deleted'),
                            style: TextStyle(
                              fontSize: Fs.label,
                              color: c.danger,
                            ),
                          ),
                          _ => null,
                        },
                        trailing: LineStat(
                          (f['added'] as num?)?.toInt() ?? 0,
                          (f['removed'] as num?)?.toInt() ?? 0,
                        ),
                        onTap: () => _change(
                          str(t['sessionId']) ?? '',
                          str(f['itemId']) ?? '',
                          str(f['path']) ?? '',
                        ),
                      ),
                  ],
                ),
              if (outside > 0)
                ToolNote(
                  L(
                    '另有 $outside 个项目目录外的文件被改过，请到电脑上看。',
                    '$outside ${outside == 1 ? 'file' : 'files'} outside the project folder ${outside == 1 ? 'was' : 'were'} changed. View them on your computer.',
                  ),
                ),
              if (r['truncated'] == true || r['partial'] == true)
                ToolNote(
                  L(
                    '记录较多，只列出了最近的一部分。',
                    'Too many records. Only the most recent are listed.',
                  ),
                ),
            ],
          ],
        );
      },
    );
  }

  String _turnTitle(Json t) {
    final prompt = str(t['prompt']) ?? '';
    return prompt.isNotEmpty ? prompt : (str(t['title']) ?? '');
  }

  String _turnMeta(Json t) {
    final prompt = str(t['prompt']) ?? '';
    final title = str(t['title']) ?? '';
    final at = (t['at'] as num?) ?? 0;
    return [
      if (prompt.isNotEmpty && title.isNotEmpty && title != prompt) title,
      ago(at),
    ].join(' · ');
  }
}

class _PathRow extends StatelessWidget {
  const _PathRow({
    required this.path,
    required this.icon,
    this.badge,
    this.trailing,
    required this.onTap,
  });
  final String path;
  final IconData icon;
  final Widget? badge;
  final Widget? trailing;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final name = baseName(path);
    final dir = path.length > name.length
        ? path.substring(0, path.length - name.length)
        : '';
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
        child: Row(
          children: [
            Icon(icon, size: 18, color: c.textMuted),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: Fs.meta,
                            fontFamily: 'monospace',
                            color: c.text,
                          ),
                        ),
                      ),
                      if (badge != null) ...[const SizedBox(width: 6), badge!],
                    ],
                  ),
                  if (dir.isNotEmpty)
                    Text(
                      dir,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: Fs.label,
                        fontFamily: 'monospace',
                        color: c.textFaint,
                      ),
                    ),
                ],
              ),
            ),
            if (trailing != null) ...[const SizedBox(width: 8), trailing!],
          ],
        ),
      ),
    );
  }
}

class _ChangePage extends StatefulWidget {
  const _ChangePage({
    required this.tool,
    required this.sessionId,
    required this.itemId,
    required this.path,
  });
  final ToolContext tool;
  final String sessionId;
  final String itemId;
  final String path;
  @override
  State<_ChangePage> createState() => _ChangePageState();
}

class _ChangePageState extends State<_ChangePage> {
  late final ToolData _change = ToolData(
    AppScope.read(context).connections,
    widget.tool.deviceId,
    'engine:artifactChange',
    [
      {'sessionId': widget.sessionId, 'itemId': widget.itemId},
    ],
  );

  @override
  void dispose() {
    _change.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListenableBuilder(
      listenable: _change,
      builder: (context, _) {
        final item = objOrNull(_change.data);
        final changes = objList(item?['changes']);
        Json? ch;
        for (final x in changes) {
          if (x['path'] == widget.path) ch = x;
        }
        ch ??= changes.isEmpty ? null : changes.first;
        return ToolFrame(
          title: baseName(widget.path),
          subtitle: widget.path,
          loading: _change.loading,
          onRefresh: _change.reload,
          actions: [
            TextButton(
              onPressed: () => widget.tool.openSession(widget.sessionId),
              child: Text(
                L('打开会话', 'Open conversation'),
                style: const TextStyle(fontSize: Fs.meta),
              ),
            ),
          ],
          children: [
            if (_change.loaded && item == null)
              EmptyState(
                icon: Icons.difference_outlined,
                title: L('找不到这次改动', 'Change not found'),
                body: L(
                  '会话记录可能已经被清掉。',
                  'The conversation history may have been cleared.',
                ),
              )
            else if (ch == null)
              ToolLoading(error: _change.error)
            else ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
                child: LineStat(
                  (ch['added'] as num?)?.toInt() ?? 0,
                  (ch['removed'] as num?)?.toInt() ?? 0,
                ),
              ),
              Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: c.bgSurface,
                  border: Border.all(color: c.borderSubtle),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: DiffView(str(ch['diff']) ?? ''),
              ),
            ],
          ],
        );
      },
    );
  }
}
