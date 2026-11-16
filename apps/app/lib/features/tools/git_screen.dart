// Git（docs/mobile-app.md §8.4，照网页版 features/tools/GitScreen.tsx）：大标题是项目名，下面一行分支 · 上游 · ↑↓；
// 改动按冲突 / 已暂存 / 没暂存 / 未跟踪分组，每行状态角标 + 路径 +「+N −N」，点开看改动；底部提交卡片（说明、提交后推送、全部暂存、提交）
// 和推送按钮，提交、推送前确认。放弃改动、强推、删分支、改写历史都不在手机上做（电脑网关也不放行）。
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
import '../session/approval_card.dart' show confirm;
import '../session/items.dart' show DiffView;
import 'common.dart';

class GitScreen extends StatefulWidget {
  const GitScreen(this.tool, {super.key});
  final ToolContext tool;
  @override
  State<GitScreen> createState() => _GitScreenState();
}

/// 暂存 / 提交 / 推送：一次只做一件，结果里带着最新状态
mixin _GitAction<T extends StatefulWidget> on State<T> {
  ToolContext get tool;
  String? busy;
  String? actionError;
  String? done;

  Future<bool> run(
    String label,
    String method,
    Object? arg, {
    String? success,
    void Function(GitStatus)? onStatus,
  }) async {
    setState(() {
      busy = label;
      actionError = null;
      done = null;
    });
    try {
      final r = obj(
        await callTool(
          AppScope.read(context).connections,
          tool.deviceId,
          method,
          [
            {'projectId': tool.project.id},
            arg,
          ],
        ),
      );
      final status = objOrNull(r['status']);
      if (status != null) onStatus?.call(GitStatus(status));
      if (r['ok'] == true) {
        if (success != null) done = success;
        return true;
      }
      actionError = gitFailureText(obj(r['failure']));
    } catch (e) {
      actionError = toolError(e);
    } finally {
      if (mounted) setState(() => busy = null);
    }
    return false;
  }
}

class _GitScreenState extends State<GitScreen> with _GitAction {
  @override
  ToolContext get tool => widget.tool;
  late final ToolData _status = ToolData(
    AppScope.read(context).connections,
    tool.deviceId,
    'projectTools:gitStatus',
    [
      {'projectId': tool.project.id},
    ],
    watch: true,
  );
  final _message = TextEditingController();
  bool _pushAfter = false;

  @override
  void dispose() {
    _status.dispose();
    _message.dispose();
    super.dispose();
  }

  GitStatus? get _s {
    final d = objOrNull(_status.data);
    return d == null ? null : GitStatus(d);
  }

  void _onStatus(GitStatus next) => _status.set(gitKeepCounts(next, _s));

  Future<void> _stage(bool staged, Object paths) => run(
    'stage',
    staged ? 'projectTools:gitUnstage' : 'projectTools:gitStage',
    paths,
    onStatus: _onStatus,
  );

  Future<void> _commit(GitStatus s) async {
    final files = gitCommitFiles(s);
    final staged = s.files(GitArea.staged).isNotEmpty;
    final remote = gitRemote(s);
    final text = [
      _message.text.trim(),
      '',
      staged
          ? L(
              '提交已暂存的 ${files.length} 个文件：',
              'Commit ${files.length} staged ${files.length == 1 ? 'file' : 'files'}:',
            )
          : L(
              '暂存并提交全部 ${files.length} 个文件：',
              'Stage and commit all ${files.length} ${files.length == 1 ? 'file' : 'files'}:',
            ),
      for (final f in files.take(20))
        '${f.code == '?' ? 'A' : f.code} ${f.path}',
      if (files.length > 20)
        L('…等 ${files.length} 个', '…${files.length} in total'),
      if (_pushAfter && remote != null)
        L('提交后推送到 $remote。', 'Then push to $remote.'),
    ].join('\n');
    final ok = await confirm(
      context,
      '${L('提交到 ${s.branch ?? '当前分支'}', 'Commit to ${s.branch ?? 'current branch'}')}\n\n$text',
      ok: _pushAfter ? L('提交并推送', 'Commit and push') : L('提交', 'Commit'),
    );
    if (!ok || !mounted) return;
    final done = await run(
      'commit',
      'projectTools:gitCommit',
      {'message': _message.text.trim(), 'all': !staged, 'push': _pushAfter},
      success: _pushAfter
          ? L('已提交并推送', 'Committed and pushed')
          : L('已提交', 'Committed'),
      onStatus: _onStatus,
    );
    if (done) {
      _message.clear();
      // 提交完收起键盘（不然焦点还在说明框里，键盘又弹出来）
      if (mounted) FocusScope.of(context).unfocus();
    }
  }

  Future<void> _push(GitStatus s) async {
    final remote = gitRemote(s);
    final ok = await confirm(
      context,
      s.upstream != null
          ? L(
              '把 ${s.branch} 的 ${s.ahead} 个提交推送到 ${s.upstream}。',
              'Push ${s.ahead} ${s.ahead == 1 ? 'commit' : 'commits'} on ${s.branch} to ${s.upstream}.',
            )
          : L(
              '把 ${s.branch} 发布到 $remote，并设为上游分支。',
              'Publish ${s.branch} to $remote and set it as the upstream branch.',
            ),
      ok: L('推送', 'Push'),
    );
    if (!ok || !mounted) return;
    await run(
      'push',
      'projectTools:gitPush',
      {'publish': s.upstream == null},
      success: L('已推送', 'Pushed'),
      onStatus: _onStatus,
    );
  }

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    return ListenableBuilder(
      listenable: Listenable.merge([_status, services.connections]),
      builder: (context, _) {
        final s = _s;
        final canAct = canActOn(services.connections, tool.deviceId);
        final disabled = !canAct || busy != null;
        return ToolFrame(
          title: 'Git',
          heading: tool.project.name,
          crumb: s != null && s.repo ? _Branch(s) : null,
          loading: _status.loading,
          onRefresh: _status.reload,
          footer: s != null && s.repo && canAct ? _footer(s, disabled) : null,
          children: [
            if (s == null)
              ToolLoading(error: _status.error)
            else if (s.missing)
              EmptyState(
                icon: Icons.account_tree_outlined,
                title: L('电脑上没有找到 Git', 'Git not found on the computer'),
                body: L('安装 Git 后再试。', 'Install Git and try again.'),
              )
            else if (!s.repo)
              EmptyState(
                icon: Icons.account_tree_outlined,
                title: L('不是 Git 仓库', 'Not a Git repository'),
                body: L(
                  '这个项目还没有用 Git 管理。',
                  "This project isn't managed with Git yet.",
                ),
              )
            else
              ..._body(s, canAct, disabled),
          ],
        );
      },
    );
  }

  List<Widget> _body(GitStatus s, bool canAct, bool disabled) {
    final count = gitChangeCount(s);
    return [
      if (_status.error != null) ToolBanner(_status.error!, tone: Tone.danger),
      if (actionError != null) ToolBanner(actionError!, tone: Tone.danger),
      if (done != null) ToolBanner(done!),
      if (s.operation != null)
        ToolBanner(
          L(
            '正在进行 ${s.operation}，请到电脑上完成或中止。',
            'A ${s.operation} is in progress. Finish or abort it on your computer.',
          ),
          tone: Tone.warn,
        ),
      if (s.busySessions > 0)
        ToolBanner(
          L(
            'AI 正在这个工作区运行，它可能还在改文件。',
            'AI is running in this workspace and may still be editing files.',
          ),
          tone: Tone.warn,
        ),
      if (s.behind > 0)
        ToolBanner(
          L(
            '远端有 ${s.behind} 个新提交，拉取请到电脑上做。',
            'The remote has ${s.behind} new ${s.behind == 1 ? 'commit' : 'commits'}. Pull on your computer.',
          ),
        ),
      if (count == 0)
        EmptyState(
          icon: Icons.check_circle_outline,
          title: L('没有改动', 'No changes'),
          body: L('工作区是干净的。', 'The working tree is clean.'),
        ),
      for (final area in GitArea.values)
        if (s.files(area) case final files when files.isNotEmpty) ...[
          GroupTitle(
            gitAreaTitle(area),
            count: files.length,
            action: canAct && area != GitArea.conflicted
                ? TextButton(
                    onPressed: disabled
                        ? null
                        : () => _stage(
                            area == GitArea.staged,
                            area == GitArea.staged
                                ? 'all'
                                : [for (final f in files) f.path],
                          ),
                    child: Text(
                      area == GitArea.staged
                          ? L('全部取消暂存', 'Unstage all')
                          : L('全部暂存', 'Stage all'),
                      style: const TextStyle(fontSize: Fs.meta),
                    ),
                  )
                : null,
          ),
          Group(
            children: [
              for (final f in files)
                _FileRow(
                  file: f,
                  area: area,
                  canAct: canAct && area != GitArea.conflicted,
                  busy: disabled,
                  onOpen: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) =>
                          _DiffPage(tool: tool, area: area, file: f),
                    ),
                  ),
                  onStage: () => _stage(area == GitArea.staged, [f.path]),
                ),
            ],
          ),
        ],
      if (s.truncated)
        ToolNote(
          L(
            '改动太多，只列出了前 5000 项。',
            'Too many changes. Only the first 5000 are listed.',
          ),
        ),
    ];
  }

  Widget? _footer(GitStatus s, bool disabled) {
    final c = context.colors;
    final count = gitChangeCount(s);
    final canPush = gitCanPush(s);
    if (count == 0 && !canPush) return null;
    final stagedCount = s.files(GitArea.staged).length;
    final unstaged = [
      for (final f in [
        ...s.files(GitArea.unstaged),
        ...s.files(GitArea.untracked),
      ])
        f.path,
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (count > 0)
            Container(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
              decoration: BoxDecoration(
                color: c.bgSurface,
                borderRadius: BorderRadius.circular(Radii.card),
                border: Border.all(color: c.borderComposer),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextField(
                    controller: _message,
                    minLines: 1,
                    maxLines: 4,
                    onChanged: (_) => setState(() {}),
                    style: TextStyle(fontSize: Fs.prose, color: c.text),
                    decoration: InputDecoration(
                      isDense: true,
                      border: InputBorder.none,
                      hintText: L('提交说明', 'Commit message'),
                      hintStyle: TextStyle(color: c.textFaint),
                    ),
                  ),
                  Row(
                    children: [
                      Checkbox(
                        value: _pushAfter,
                        visualDensity: VisualDensity.compact,
                        onChanged: s.remotes.isEmpty || s.detached
                            ? null
                            : (v) => setState(() => _pushAfter = v == true),
                      ),
                      Text(
                        L('提交后推送', 'Push after commit'),
                        style: TextStyle(
                          fontSize: Fs.meta,
                          color: c.textSecondary,
                        ),
                      ),
                    ],
                  ),
                  Row(
                    children: [
                      if (unstaged.isNotEmpty) ...[
                        OutlinedButton(
                          onPressed: disabled
                              ? null
                              : () => _stage(false, unstaged),
                          style: OutlinedButton.styleFrom(
                            shape: const StadiumBorder(),
                            side: BorderSide(color: c.borderCard),
                            foregroundColor: c.text,
                          ),
                          child: Text(L('全部暂存', 'Stage all')),
                        ),
                        const SizedBox(width: 8),
                      ],
                      Expanded(
                        child: FilledButton(
                          style: FilledButton.styleFrom(
                            backgroundColor: c.btnPrimaryBg,
                            foregroundColor: c.btnPrimaryText,
                            shape: const StadiumBorder(),
                          ),
                          onPressed:
                              disabled ||
                                  _message.text.trim().isEmpty ||
                                  s.files(GitArea.conflicted).isNotEmpty
                              ? null
                              : () => _commit(s),
                          child: Text(
                            busy == 'commit'
                                ? L('正在提交…', 'Committing…')
                                : stagedCount > 0
                                ? L(
                                    '提交 $stagedCount 个文件',
                                    'Commit $stagedCount ${stagedCount == 1 ? 'file' : 'files'}',
                                  )
                                : L(
                                    '提交全部改动（$count）',
                                    'Commit all changes ($count)',
                                  ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          if (canPush) ...[
            if (count > 0) const SizedBox(height: 8),
            SecondaryButton(
              icon: Icons.upload,
              label: s.upstream != null
                  ? L(
                      '推送 ${s.ahead} 个提交',
                      'Push ${s.ahead} ${s.ahead == 1 ? 'commit' : 'commits'}',
                    )
                  : L(
                      '发布分支到 ${gitRemote(s)}',
                      'Publish branch to ${gitRemote(s)}',
                    ),
              onPressed: disabled ? null : () => _push(s),
            ),
          ],
        ],
      ),
    );
  }
}

class _Branch extends StatelessWidget {
  const _Branch(this.s);
  final GitStatus s;
  @override
  Widget build(BuildContext context) {
    final branch = s.detached
        ? L('分离 HEAD', 'Detached HEAD')
        : (s.branch ?? L('（没有分支）', '(no branch)'));
    final rest = [
      if (s.upstream != null) ' → ${s.upstream}',
      if (s.ahead > 0) ' · ↑${s.ahead}',
      if (s.behind > 0) ' ↓${s.behind}',
      if (s.initial)
        ' · ${L('还没有提交', 'No commits yet')}'
      else if (s.upstream == null)
        ' · ${L('没有上游分支', 'No upstream branch')}',
    ].join();
    return Row(
      children: [
        const Icon(Icons.account_tree_outlined, size: 14),
        const SizedBox(width: 6),
        Flexible(
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(
                  text: branch,
                  style: const TextStyle(fontFamily: 'monospace'),
                ),
                TextSpan(text: rest),
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

/// 状态角标：低透明度底色 + 同色字（改 = 暖色，新增 = 绿，删除 / 冲突 = 红，其余 = 灰）
class GitBadge extends StatelessWidget {
  const GitBadge(this.code, {super.key});
  final String code;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = switch (code) {
      'D' || 'U' => c.danger,
      'A' || '?' => c.success,
      'M' => c.warn,
      _ => c.textMuted,
    };
    return Tooltip(
      message: gitCodeText(code),
      child: Container(
        width: 24,
        height: 24,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text(
          code == '?' ? 'U' : code,
          style: TextStyle(
            fontSize: Fs.label,
            fontWeight: FontWeight.w600,
            fontFamily: 'monospace',
            color: color,
          ),
        ),
      ),
    );
  }
}

String _dirOf(String path) {
  final i = path.lastIndexOf('/');
  return i < 0 ? '' : path.substring(0, i + 1);
}

class _FileRow extends StatelessWidget {
  const _FileRow({
    required this.file,
    required this.area,
    required this.canAct,
    required this.busy,
    required this.onOpen,
    required this.onStage,
  });
  final GitFileChange file;
  final GitArea area;
  final bool canAct;
  final bool busy;
  final VoidCallback onOpen;
  final VoidCallback onStage;
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final staged = area == GitArea.staged;
    return Row(
      children: [
        Expanded(
          child: InkWell(
            onTap: file.submodule ? null : onOpen,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 9, 8, 9),
              child: Row(
                children: [
                  GitBadge(file.code),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          baseName(file.path),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: Fs.meta,
                            fontFamily: 'monospace',
                            color: c.text,
                          ),
                        ),
                        // 第二行：增删行数 + 所在目录（长路径截掉的是目录，文件名总能看到）
                        Row(
                          children: [
                            if (file.insertions != null) ...[
                              LineStat(file.insertions!, file.deletions),
                              const SizedBox(width: 8),
                            ],
                            Expanded(
                              child: Text(
                                [
                                  _dirOf(file.path),
                                  if (file.origPath != null)
                                    '← ${file.origPath}',
                                ].where((x) => x.isNotEmpty).join('  '),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: Fs.label,
                                  fontFamily: 'monospace',
                                  color: c.textFaint,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (canAct)
          IconButton(
            tooltip: staged
                ? L('取消暂存 ${file.path}', 'Unstage ${file.path}')
                : L('暂存 ${file.path}', 'Stage ${file.path}'),
            onPressed: busy ? null : onStage,
            icon: Icon(
              staged ? Icons.remove : Icons.add,
              size: 20,
              color: c.textMuted,
            ),
          ),
      ],
    );
  }
}

class _DiffPage extends StatefulWidget {
  const _DiffPage({required this.tool, required this.area, required this.file});
  final ToolContext tool;
  final GitArea area;
  final GitFileChange file;
  @override
  State<_DiffPage> createState() => _DiffPageState();
}

class _DiffPageState extends State<_DiffPage> with _GitAction {
  @override
  ToolContext get tool => widget.tool;
  late final ToolData _diff = ToolData(
    AppScope.read(context).connections,
    tool.deviceId,
    'projectTools:gitDiff',
    [
      {'projectId': tool.project.id},
      {
        'path': widget.file.path,
        'area': widget.area.name,
        'origPath': ?widget.file.origPath,
      },
    ],
  );

  @override
  void dispose() {
    _diff.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final services = AppScope.of(context);
    final c = context.colors;
    final staged = widget.area == GitArea.staged;
    return ListenableBuilder(
      listenable: _diff,
      builder: (context, _) {
        final d = objOrNull(_diff.data);
        final canAct =
            canActOn(services.connections, tool.deviceId) &&
            widget.area != GitArea.conflicted;
        return ToolFrame(
          title: baseName(widget.file.path),
          subtitle: '${gitAreaTitle(widget.area)} · ${widget.file.path}',
          loading: _diff.loading,
          onRefresh: _diff.reload,
          footer: canAct
              ? Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                  child: SecondaryButton(
                    icon: staged ? Icons.remove : Icons.add,
                    label: staged
                        ? L('取消暂存这个文件', 'Unstage this file')
                        : L('暂存这个文件', 'Stage this file'),
                    onPressed: busy != null
                        ? null
                        : () async {
                            final ok = await run(
                              'stage',
                              staged
                                  ? 'projectTools:gitUnstage'
                                  : 'projectTools:gitStage',
                              [widget.file.path],
                            );
                            if (ok && context.mounted) {
                              Navigator.of(context).pop();
                            }
                          },
                  ),
                )
              : null,
          children: [
            if (actionError != null)
              ToolBanner(actionError!, tone: Tone.danger),
            if (d == null)
              ToolLoading(error: _diff.error)
            else if (d['binary'] == true)
              EmptyState(
                icon: Icons.insert_drive_file_outlined,
                title: L('二进制文件', 'Binary file'),
                body: L('不能按行比较。', "Can't compare line by line."),
              )
            else if (d['tooLarge'] == true)
              EmptyState(
                icon: Icons.insert_drive_file_outlined,
                title: L('文件太大', 'File too large'),
                body: L(
                  '超过 2 MB，请到电脑上看。',
                  'Over 2 MB. View it on your computer.',
                ),
              )
            else ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
                child: LineStat(
                  (d['added'] as num?)?.toInt() ?? 0,
                  (d['removed'] as num?)?.toInt() ?? 0,
                ),
              ),
              Container(
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                  color: c.bgSurface,
                  border: Border.all(color: c.borderSubtle),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: DiffView(str(d['diff']) ?? ''),
              ),
              if (d['cut'] == true)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: ToolNote(
                    L(
                      '改动太多，只显示了前面一部分，完整的请到电脑上看。',
                      'Too many changes. Only the first part is shown; view the full diff on your computer.',
                    ),
                  ),
                ),
            ],
          ],
        );
      },
    );
  }
}
