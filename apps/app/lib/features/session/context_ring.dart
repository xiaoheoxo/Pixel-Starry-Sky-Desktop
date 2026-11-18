// 输入框里的上下文用量圆环（docs/mobile-app.md §18，同电脑 ContextWindowButton）：
// 快满变警示色，点开看「上下文 62%：已用 124k / 200k」，空闲时能压缩。
import 'package:material_ui/material_ui.dart';

import '../../data/actions.dart';
import '../../data/mode.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

class ContextRing extends StatelessWidget {
  const ContextRing({
    super.key,
    required this.info,
    required this.canCompact,
    required this.onCompact,
  });

  /// 快照里的 context（used / window / compacting / stale）
  final Json? info;

  /// 能不能压缩：有「可以操作」、这一轮没在跑
  final bool canCompact;
  final Future<void> Function() onCompact;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final compacting = info?['compacting'] == true;
    final u = contextUsage(info);
    if (u == null && !compacting) return const SizedBox.shrink();
    final color = u == null
        ? c.textMuted
        : u.percent >= 95
        ? c.danger
        : u.percent >= 80
        ? c.warn
        : c.textMuted;
    return Tooltip(
      message: compacting
          ? L('正在压缩上下文', 'Compacting context')
          : contextLabel(u!),
      child: InkResponse(
        radius: 22,
        onTap: () => _show(context),
        child: SizedBox.square(
          dimension: 40,
          child: Center(
            child: SizedBox.square(
              dimension: 20,
              child: CircularProgressIndicator(
                value: compacting ? null : u!.percent / 100,
                strokeWidth: 2.5,
                color: color,
                backgroundColor: c.borderSubtle,
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _show(BuildContext context) =>
      showPanel<void>(context, (context) => _ContextPanel(ring: this));
}

class _ContextPanel extends StatefulWidget {
  const _ContextPanel({required this.ring});
  final ContextRing ring;

  @override
  State<_ContextPanel> createState() => _ContextPanelState();
}

class _ContextPanelState extends State<_ContextPanel> {
  bool _busy = false;
  String? _error;

  Future<void> _compact() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.ring.onCompact();
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _error = actionError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final ctx = widget.ring.info;
    final compacting = ctx?['compacting'] == true;
    final u = contextUsage(ctx);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              L('上下文', 'Context'),
              style: TextStyle(
                fontSize: Fs.section,
                fontWeight: FontWeight.w600,
                color: c.text,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              compacting
                  ? L('正在压缩上下文…', 'Compacting context…')
                  : contextLabel(u!),
              style: TextStyle(fontSize: Fs.ui, color: c.textSecondary),
            ),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(3),
              child: LinearProgressIndicator(
                value: compacting ? null : u!.percent / 100,
                minHeight: 6,
                color: u != null && u.percent >= 80 ? c.warn : c.accent,
                backgroundColor: c.borderSubtle,
              ),
            ),
            const SizedBox(height: 10),
            Text(
              L(
                '快满时 AI 会自动压缩；也可以现在压缩，把前面的对话缩成一段摘要，腾出空间。',
                'The AI compacts automatically when it gets full. You can also compact now: earlier messages become a summary to free up space.',
              ),
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(
                _error!,
                style: TextStyle(fontSize: Fs.meta, color: c.danger),
              ),
            ],
            const SizedBox(height: 14),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                onPressed: compacting || _busy || !widget.ring.canCompact
                    ? null
                    : _compact,
                child: Text(L('压缩上下文', 'Compact context')),
              ),
            ),
            if (!widget.ring.canCompact && !compacting)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    L(
                      '这一轮做完、并且手机是「可以操作」时才能压缩',
                      'Available when the turn is done and this phone can act',
                    ),
                    style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
