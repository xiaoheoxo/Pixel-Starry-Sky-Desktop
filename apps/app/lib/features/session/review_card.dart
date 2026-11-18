// 审查卡（第三批 C4，docs/mobile-app.md §15.5）：电脑上 AI 审查过的那一轮，改动卡片下面出一张：
// 严重程度、一句话、文件:行；每条「修这条」「忽略」，底部「全部修复（N）」。修的文字电脑拼，发出去后条目变「已发去修」。
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../data/reviews.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../settings/log_screen.dart' show showErrorSnack;

class ReviewCard extends StatefulWidget {
  const ReviewCard({
    super.key,
    required this.reviews,
    required this.turnKey,
    required this.canAct,
  });
  final SessionReviews reviews;
  final String turnKey;
  final bool canAct;

  @override
  State<ReviewCard> createState() => _ReviewCardState();
}

class _ReviewCardState extends State<ReviewCard> {
  /// 正在处理的条目（'*' 是全部修复）
  String? _busy;

  Future<void> _run(String key, Future<void> Function() f) async {
    if (_busy != null) return;
    setState(() => _busy = key);
    try {
      await f();
    } catch (e) {
      if (mounted) {
        showErrorSnack(context, actionError(e));
      }
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListenableBuilder(
      listenable: widget.reviews,
      builder: (context, _) {
        final review = widget.reviews.turns[widget.turnKey];
        if (review == null) return const SizedBox.shrink();
        final shown = review.shown;
        final open = review.open;
        final r = widget.reviews;
        final canAct = widget.canAct && _busy == null;
        return Container(
          margin: const EdgeInsets.only(top: 8),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(
            color: c.bgSurface,
            border: Border.all(color: c.borderCard),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.manage_search, size: 18, color: c.textSecondary),
                  const SizedBox(width: 6),
                  Text(
                    L('AI 审查', 'AI review'),
                    style: TextStyle(
                      fontSize: Fs.ui,
                      fontWeight: FontWeight.w600,
                      color: c.text,
                    ),
                  ),
                  Expanded(
                    child: Text(
                      L(
                        ' · ${shown.length} 条 · 在电脑上审的',
                        ' · ${shown.length} · reviewed on the computer',
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                    ),
                  ),
                ],
              ),
              if (shown.isEmpty && review.raw == null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    review.ignored > 0
                        ? L(
                            '都忽略了（${review.ignored} 条）',
                            'All ignored (${review.ignored})',
                          )
                        : L('没发现问题', 'No issues found'),
                    style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                  ),
                ),
              if (shown.isEmpty && review.raw != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(
                    review.raw!,
                    maxLines: 8,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: Fs.meta, color: c.textBody),
                  ),
                ),
              for (final item in shown)
                _Row(
                  item: item,
                  busy: _busy == item.id,
                  onFix: canAct && item.status == 'open'
                      ? () => _run(
                          item.id,
                          () => r.fix(widget.turnKey, [item.id]),
                        )
                      : null,
                  onIgnore: canAct && item.status == 'open'
                      ? () => _run(
                          item.id,
                          () => r.setStatus(widget.turnKey, item.id, 'ignored'),
                        )
                      : null,
                ),
              if (open > 1)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: FilledButton(
                    onPressed: canAct
                        ? () => _run('*', () => r.fix(widget.turnKey, null))
                        : null,
                    child: Text(L('全部修复（$open）', 'Fix all ($open)')),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({
    required this.item,
    required this.busy,
    required this.onFix,
    required this.onIgnore,
  });
  final ReviewEntry item;
  final bool busy;
  final VoidCallback? onFix;
  final VoidCallback? onIgnore;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (icon, color) = switch (item.severity) {
      'high' => (Icons.change_history, c.danger),
      'medium' => (Icons.circle, c.warn),
      _ => (Icons.info_outline, c.textMuted),
    };
    final fixed = item.status == 'fixed';
    final note = switch (item.status) {
      'sent' => L('已发去修', 'Sent to fix'),
      'fixed' => L('已修', 'Fixed'),
      _ => null,
    };
    final where = [?item.where, ?note].join(' · ');
    return Opacity(
      opacity: fixed ? 0.5 : 1,
      child: Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Icon(icon, size: 14, color: color),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    item.title,
                    style: TextStyle(
                      fontSize: Fs.ui,
                      color: c.textBody,
                      decoration: fixed ? TextDecoration.lineThrough : null,
                    ),
                  ),
                  if (where.isNotEmpty)
                    Text(
                      where,
                      style: TextStyle(
                        fontSize: Fs.meta,
                        color: c.textMuted,
                        fontFamily: 'monospace',
                      ),
                    ),
                  if (onFix != null || onIgnore != null || busy)
                    Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Row(
                        children: [
                          OutlinedButton(
                            onPressed: onFix,
                            style: OutlinedButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                            ),
                            child: Text(L('修这条', 'Fix this')),
                          ),
                          const SizedBox(width: 6),
                          OutlinedButton(
                            onPressed: onIgnore,
                            style: OutlinedButton.styleFrom(
                              visualDensity: VisualDensity.compact,
                            ),
                            child: Text(L('忽略', 'Ignore')),
                          ),
                        ],
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
