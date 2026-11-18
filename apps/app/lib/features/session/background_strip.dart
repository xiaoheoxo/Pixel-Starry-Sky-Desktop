// 一轮说完了、后台子智能体还在跑时输入框上面那一条（docs/mobile-app.md §17）：「后台 2 个子智能体在跑」，点开看每一个在做什么。
// 这批只显示，不在手机上停（D335）。
import 'package:material_ui/material_ui.dart';

import '../../data/background_agents.dart';
import '../../i18n/i18n.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';
import '../../ui/widgets.dart';

String backgroundText(int n) =>
    L('后台 $n 个子智能体在跑', '$n subagent${n == 1 ? '' : 's'} running in background');

class BackgroundStrip extends StatelessWidget {
  const BackgroundStrip({super.key, required this.agents, required this.count});
  final List<BackgroundAgent> agents;

  /// 宿主报的个数（可能比列表多：子智能体条还没到）
  final int count;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final n = count > agents.length ? count : agents.length;
    // 放在输入框卡片的第一行（Composer.top），同 RunningStrip
    return InkWell(
      onTap: agents.isEmpty ? null : () => _show(context),
      child: Container(
        padding: const EdgeInsets.fromLTRB(10, 4, 10, 8),
        margin: const EdgeInsets.only(bottom: 2),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: c.borderSubtle)),
        ),
        child: Row(
          children: [
            SizedBox.square(
              dimension: 12,
              child: CircularProgressIndicator(
                strokeWidth: 1.5,
                color: c.accent,
              ),
            ),
            const SizedBox(width: 8),
            Icon(Icons.call_split, size: 15, color: c.textMuted),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                agents.length == 1
                    ? '${backgroundText(1)} · ${agents.first.label}'
                    : backgroundText(n),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
              ),
            ),
            if (agents.isNotEmpty)
              Icon(Icons.chevron_right, size: 16, color: c.textMuted),
          ],
        ),
      ),
    );
  }

  void _show(BuildContext context) => showPanel<void>(context, (context) {
    final c = context.colors;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              backgroundText(agents.length),
              style: TextStyle(
                fontSize: Fs.section,
                fontWeight: FontWeight.w600,
                color: c.text,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              L(
                '跑完后会接着回复；要停在电脑上停',
                'The reply continues when they finish. Stop them on the computer',
              ),
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
            const SizedBox(height: 12),
            for (final a in agents)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Icon(
                        a.workflow
                            ? Icons.account_tree_outlined
                            : Icons.call_split,
                        size: 16,
                        color: c.textMuted,
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            a.label,
                            style: TextStyle(fontSize: Fs.ui, color: c.text),
                          ),
                          if ((a.message ?? '').isNotEmpty)
                            Text(
                              a.message!,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: Fs.meta,
                                color: c.textMuted,
                              ),
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
  });
}
