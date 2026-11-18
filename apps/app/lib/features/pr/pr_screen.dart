// PR 条和详情（第三批 C3，docs/mobile-app.md §15.4）：会话页顶栏下一条（有 PR 时才出），点开详情：
// 检查列表（没过的在前，点开在浏览器看运行页）、让 AI 修检查 / 解决冲突（文字电脑拼）、合并（选方式、二次确认）、
// 合并后问要不要归档。
import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../data/actions.dart';
import '../../data/prs.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../session/session_menu.dart';
import '../settings/log_screen.dart' show showErrorSnack;

/// 在系统浏览器里打开（只开 https）
Future<void> openExternal(String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null || uri.scheme != 'https') return;
  await launchUrl(uri, mode: LaunchMode.externalApplication);
}

/// 圆点的颜色：已合并用强调色（同电脑），没过 / 冲突红，在跑黄，通过绿
Color prColor(AppColors c, Pr pr) => switch (pr.state) {
  'merged' => c.accent,
  'closed' => c.danger,
  'draft' => c.textMuted,
  _ =>
    pr.failing || pr.hasConflict
        ? c.danger
        : pr.ci == 'pending'
        ? c.warn
        : c.success,
};

String prStateText(Pr pr) => switch (pr.state) {
  'merged' => L('已合并', 'Merged'),
  'closed' => L('已关闭', 'Closed'),
  'draft' => L('草稿', 'Draft'),
  _ => L('开着', 'Open'),
};

/// 条上右边的标签：冲突 > 检查 x/y > 关了的写状态
({String text, Color color})? prTag(AppColors c, Pr pr) {
  if (pr.hasConflict) return (text: L('冲突', 'Conflict'), color: c.danger);
  final n = pr.checkCount;
  if (pr.isOpen && n != null) {
    return (
      text: L('检查 ${n.passed}/${n.total}', 'Checks ${n.passed}/${n.total}'),
      color: pr.failing
          ? c.danger
          : pr.ci == 'pending'
          ? c.warn
          : c.success,
    );
  }
  if (!pr.isOpen) return (text: prStateText(pr), color: prColor(c, pr));
  return null;
}

/// 会话页顶栏下面的 PR 条：最要紧的那个 PR（电脑排好了），还有别的写「+N」
class PrBar extends StatelessWidget {
  const PrBar({super.key, required this.prs, required this.onOpen});
  final SessionPrs prs;
  final void Function(Pr pr) onOpen;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListenableBuilder(
      listenable: prs,
      builder: (context, _) {
        if (prs.prs.isEmpty) return const SizedBox.shrink();
        final pr = prs.prs.first;
        final tag = prTag(c, pr);
        final more = prs.prs.length - 1;
        return Material(
          color: c.bgSubtle,
          child: InkWell(
            onTap: () => onOpen(pr),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(
                      color: prColor(c, pr),
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '#${pr.number}',
                    style: TextStyle(
                      fontSize: Fs.ui,
                      fontWeight: FontWeight.w600,
                      color: c.text,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      pr.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: Fs.ui, color: c.textBody),
                    ),
                  ),
                  if (tag != null) _Pill(tag.text, tag.color),
                  if (more > 0) ...[
                    const SizedBox(width: 6),
                    Text(
                      '+$more',
                      style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                    ),
                  ],
                  Icon(Icons.chevron_right, size: 18, color: c.textFaint),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(99),
    ),
    child: Text(
      text,
      style: TextStyle(
        fontSize: Fs.meta,
        color: color,
        fontWeight: FontWeight.w500,
      ),
    ),
  );
}

void openPr(
  BuildContext context, {
  required SessionPrs prs,
  required SessionActions actions,
  required String url,
  bool running = false,
}) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) =>
          PrScreen(prs: prs, actions: actions, url: url, running: running),
    ),
  );
}

class PrScreen extends StatefulWidget {
  const PrScreen({
    super.key,
    required this.prs,
    required this.actions,
    required this.url,
    this.running = false,
  });
  final SessionPrs prs;
  final SessionActions actions;
  final String url;

  /// 对话在跑：归档前要先停（同会话菜单）
  final bool running;

  @override
  State<PrScreen> createState() => _PrScreenState();
}

class _PrScreenState extends State<PrScreen> {
  bool _busy = false;
  bool _refreshing = false;

  void _toast(String text) =>
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(text)));

  Future<void> _run(Future<void> Function() f, String done) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await f();
      if (mounted) _toast(done);
    } catch (e) {
      if (mounted) showErrorSnack(context, actionError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refresh() async {
    setState(() => _refreshing = true);
    try {
      await widget.prs.refresh();
    } catch (e) {
      if (mounted) showErrorSnack(context, actionError(e));
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Future<void> _merge(Pr pr) async {
    PrMergeOptions options;
    try {
      options = await widget.prs.mergeOptions(pr.url);
    } catch (e) {
      if (mounted) showErrorSnack(context, actionError(e));
      return;
    }
    if (!mounted) return;
    final choice = await showPanel<({String method, bool delete})>(
      context,
      (_) => _MergeSheet(pr: pr, options: options),
    );
    if (choice == null || !mounted) return;
    await _run(
      () => widget.prs.merge(pr.url, choice.method, choice.delete),
      L('已合并', 'Merged'),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final canAct = widget.actions.canAct;
    return ListenableBuilder(
      listenable: widget.prs,
      builder: (context, _) {
        final pr = widget.prs.find(widget.url);
        return AppScreen(
          title: pr == null ? 'PR' : 'PR #${pr.number}',
          leading: RoundIconButton(
            icon: Icons.arrow_back,
            tooltip: L('返回', 'Back'),
            onPressed: () => Navigator.of(context).pop(),
          ),
          trailing: [
            RoundIconButton(
              icon: Icons.refresh,
              tooltip: L('重查', 'Refresh'),
              onPressed: _refreshing ? null : _refresh,
            ),
          ],
          body: pr == null
              ? EmptyState(
                  icon: Icons.merge_type,
                  title: L('这个 PR 不在这个对话里了', 'This PR is no longer here'),
                )
              : ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  children: [
                    Text(
                      pr.title,
                      style: TextStyle(
                        fontSize: Fs.section,
                        fontWeight: FontWeight.w600,
                        color: c.text,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text.rich(
                      TextSpan(
                        style: TextStyle(
                          fontSize: Fs.meta,
                          color: c.textMuted,
                          fontFamily: 'monospace',
                        ),
                        children: [
                          TextSpan(text: '${pr.head} → ${pr.base}'),
                          if (pr.additions + pr.deletions > 0) ...[
                            const TextSpan(text: ' · '),
                            TextSpan(
                              text: '+${pr.additions}',
                              style: TextStyle(color: c.success),
                            ),
                            const TextSpan(text: ' '),
                            TextSpan(
                              text: '−${pr.deletions}',
                              style: TextStyle(color: c.danger),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        _Pill(prStateText(pr), prColor(c, pr)),
                        if (pr.isOpen && pr.ci == 'fail')
                          _Pill(
                            L(
                              '${pr.ciFailed} 项检查没过',
                              '${pr.ciFailed} checks failed',
                            ),
                            c.danger,
                          ),
                        if (pr.isOpen && pr.ci == 'pending')
                          _Pill(L('检查在跑', 'Checks running'), c.warn),
                        if (pr.isOpen && pr.ci == 'pass')
                          _Pill(L('检查全部通过', 'All checks passed'), c.success),
                        if (pr.hasConflict)
                          _Pill(L('有冲突', 'Has conflicts'), c.danger),
                        if (pr.unknown)
                          _Pill(L('查不到状态', 'Status unavailable'), c.textMuted),
                      ],
                    ),
                    if (pr.checks.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Section(
                        children: [
                          for (final ch in pr.sortedChecks) _CheckRow(ch),
                        ],
                      ),
                    ],
                    const SizedBox(height: 16),
                    if (pr.failing)
                      _Gap(
                        PrimaryButton(
                          label: L('让 AI 修检查', 'Ask AI to fix checks'),
                          busy: _busy,
                          onPressed: canAct
                              ? () => _run(
                                  () => widget.prs.fix(pr.url, 'checks'),
                                  L('已发给 AI', 'Sent to the AI'),
                                )
                              : null,
                        ),
                      ),
                    if (pr.hasConflict)
                      _Gap(
                        PrimaryButton(
                          label: L('让 AI 解决冲突', 'Ask AI to resolve conflicts'),
                          busy: _busy,
                          onPressed: canAct
                              ? () => _run(
                                  () => widget.prs.fix(pr.url, 'conflict'),
                                  L('已发给 AI', 'Sent to the AI'),
                                )
                              : null,
                        ),
                      ),
                    if (pr.state == 'open')
                      _Gap(
                        SecondaryButton(
                          label: pr.canMerge
                              ? L('合并', 'Merge')
                              : L(
                                  '合并（检查全部通过、没有冲突后可用）',
                                  'Merge (once checks pass and no conflicts)',
                                ),
                          onPressed: pr.canMerge && canAct && !_busy
                              ? () => _merge(pr)
                              : null,
                        ),
                      ),
                    if (pr.state == 'merged')
                      _Gap(
                        SecondaryButton(
                          label: L('归档这个对话', 'Archive this conversation'),
                          onPressed: canAct
                              ? () => archiveSession(
                                  context,
                                  actions: widget.actions,
                                  running: widget.running,
                                  onArchived: () {
                                    if (context.mounted) {
                                      Navigator.of(context)
                                          .popUntil((r) => r.isFirst);
                                    }
                                  },
                                )
                              : null,
                        ),
                      ),
                    _Gap(
                      SecondaryButton(
                        label: L('在浏览器打开', 'Open in browser'),
                        icon: Icons.open_in_new,
                        onPressed: () => openExternal(pr.url),
                      ),
                    ),
                    if (!canAct)
                      Text(
                        L(
                          '这部手机是「只看」，修和合并要在电脑上做',
                          'This phone is “View only” — fix and merge on the computer',
                        ),
                        style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                      ),
                  ],
                ),
        );
      },
    );
  }
}

class _Gap extends StatelessWidget {
  const _Gap(this.child);
  final Widget child;

  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.only(bottom: 8), child: child);
}

class _CheckRow extends StatelessWidget {
  const _CheckRow(this.check);
  final PrCheck check;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (icon, color) = switch (check.state) {
      'fail' => (Icons.close, c.danger),
      'pass' => (Icons.check, c.success),
      _ => (Icons.schedule, c.warn),
    };
    return ListRow(
      leading: Icon(icon, size: 18, color: color),
      title: check.name,
      trailing: check.url.isEmpty
          ? const SizedBox.shrink()
          : Icon(Icons.open_in_new, size: 16, color: c.textFaint),
      onTap: check.url.isEmpty ? null : () => openExternal(check.url),
    );
  }
}

/// 合并确认：仓库允许的方式（第一个是推荐的）、合并后删不删分支
class _MergeSheet extends StatefulWidget {
  const _MergeSheet({required this.pr, required this.options});
  final Pr pr;
  final PrMergeOptions options;

  @override
  State<_MergeSheet> createState() => _MergeSheetState();
}

class _MergeSheetState extends State<_MergeSheet> {
  late final List<String> _methods = widget.options.methods.isEmpty
      ? const ['merge']
      : widget.options.methods;
  late String _method = _methods.first;
  late bool _delete = widget.options.deleteBranch;

  static String _label(String m) => switch (m) {
    'squash' => L('压成一个提交（squash）', 'Squash and merge'),
    'rebase' => L('变基（rebase）', 'Rebase and merge'),
    _ => L('合并提交（merge）', 'Create a merge commit'),
  };

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            L('合并 PR #${widget.pr.number}？', 'Merge PR #${widget.pr.number}?'),
            style: TextStyle(
              fontSize: Fs.section,
              fontWeight: FontWeight.w600,
              color: c.text,
            ),
          ),
          const SizedBox(height: 8),
          RadioGroup<String>(
            groupValue: _method,
            onChanged: (v) => setState(() => _method = v ?? _method),
            child: Column(
              children: [
                for (final m in _methods)
                  RadioListTile<String>(
                    value: m,
                    title: Text(_label(m)),
                    contentPadding: EdgeInsets.zero,
                  ),
              ],
            ),
          ),
          SwitchListTile(
            value: _delete,
            onChanged: (v) => setState(() => _delete = v),
            contentPadding: EdgeInsets.zero,
            title: Text(
              L(
                '合并后删掉分支 ${widget.pr.head}',
                'Delete branch ${widget.pr.head} after merging',
              ),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: SecondaryButton(
                  label: L('取消', 'Cancel'),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: PrimaryButton(
                  label: L('合并', 'Merge'),
                  onPressed: () =>
                      Navigator.of(context)
                          .pop((method: _method, delete: _delete)),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
