// 手机日志页（docs/mobile-app.md §19，D340）：最新的在上面，「只看错误」，长按一条复制，右上角复制全部、清空。
// 设置页「反馈」一组和出错提示上的「查看日志」都到这里。
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../app/log.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';
import '../session/approval_card.dart' show confirm;

void openLogs(BuildContext context, {bool errorsOnly = false}) =>
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => LogScreen(log: appLog, errorsOnly: errorsOnly),
      ),
    );

/// 出错的提示条：带「查看日志」（§19 出错处的入口）
void showErrorSnack(BuildContext context, String text) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  // 点「查看日志」时 context 可能已经没了（会话菜单这类面板先关掉了）：现在就取导航器
  final navigator = Navigator.maybeOf(context);
  messenger?.showSnackBar(
    SnackBar(
      content: Text(text),
      action: SnackBarAction(
        label: L('查看日志', 'View log'),
        onPressed: () => navigator?.push(
          MaterialPageRoute<void>(
            builder: (_) => LogScreen(log: appLog, errorsOnly: true),
          ),
        ),
      ),
    ),
  );
}

class LogScreen extends StatefulWidget {
  const LogScreen({super.key, required this.log, this.errorsOnly = false});
  final AppLog log;
  final bool errorsOnly;

  @override
  State<LogScreen> createState() => _LogScreenState();
}

class _LogScreenState extends State<LogScreen> {
  late bool _errorsOnly = widget.errorsOnly;

  List<LogEntry> get _shown => [
    for (final e in widget.log.entries.reversed)
      if (!_errorsOnly || e.level != LogLevel.info) e,
  ];

  Future<void> _copy(String text, String done) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(done)));
  }

  Future<void> _clear() async {
    final ok = await confirm(
      context,
      L(
        '清空手机上记的日志？电脑上的不受影响。',
        "Clear everything logged on this phone? The computer's log isn't affected.",
      ),
      ok: L('清空', 'Clear'),
    );
    if (ok) await widget.log.clear();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.log,
    builder: (context, _) {
      final c = context.colors;
      final shown = _shown;
      return AppScreen(
        title: L('日志', 'Log'),
        subtitle: L(
          '只记事件和错误，不记消息内容',
          'Events and errors only, no message content',
        ),
        leading: RoundIconButton(
          icon: Icons.arrow_back,
          tooltip: L('返回', 'Back'),
          onPressed: () => Navigator.of(context).pop(),
        ),
        trailing: [
          RoundIconButton(
            icon: Icons.copy_all_outlined,
            tooltip: L('复制全部', 'Copy all'),
            onPressed: shown.isEmpty
                ? null
                : () => _copy(
                    logText(shown.reversed),
                    L(
                      '已复制 ${shown.length} 条',
                      'Copied ${shown.length} entries',
                    ),
                  ),
          ),
          RoundIconButton(
            icon: Icons.delete_outline,
            tooltip: L('清空', 'Clear'),
            onPressed: widget.log.entries.isEmpty ? null : _clear,
          ),
        ],
        body: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(Radii.card),
              child: Material(
                color: c.bgSubtle,
                child: SwitchListTile(
                  value: _errorsOnly,
                  onChanged: (v) => setState(() => _errorsOnly = v),
                  title: Text(
                    L('只看警告和错误', 'Warnings and errors only'),
                    style: TextStyle(fontSize: Fs.prose, color: c.text),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 12),
            if (shown.isEmpty)
              SizedBox(
                height: 280,
                child: EmptyState(
                  icon: Icons.receipt_long_outlined,
                  title: _errorsOnly
                      ? L('没有警告和错误', 'No warnings or errors')
                      : L('还没有日志', 'Nothing logged yet'),
                ),
              )
            else
              for (final e in shown)
                _LogRow(
                  entry: e,
                  onCopy: () => _copy(logText([e]), L('已复制', 'Copied')),
                ),
          ],
        ),
      );
    },
  );
}

class _LogRow extends StatelessWidget {
  const _LogRow({required this.entry, required this.onCopy});
  final LogEntry entry;
  final VoidCallback onCopy;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = switch (entry.level) {
      LogLevel.error => c.danger,
      LogLevel.warn => c.warn,
      LogLevel.info => c.textMuted,
    };
    return InkWell(
      onLongPress: onCopy,
      borderRadius: BorderRadius.circular(Radii.code),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 6, right: 10),
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${logTime(entry.at)} · ${entry.source}',
                    style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    entry.text,
                    maxLines: entry.level == LogLevel.info ? 3 : 12,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: Fs.list,
                      height: 1.4,
                      color: entry.level == LogLevel.error ? c.danger : c.text,
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
