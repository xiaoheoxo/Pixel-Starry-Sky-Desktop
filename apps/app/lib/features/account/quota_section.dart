// 账号额度（docs/mobile-app.md §17）：账号页的「额度」一节，和会话模式面板里那一行简写。
// 订阅账号（Claude / ChatGPT / Antigravity）经网关 quota 方法取；平台账号从 account 换算。
import 'package:material_ui/material_ui.dart';

import '../../app/scope.dart';
import 'account_screen.dart' show openAccount;
import '../../connection/connections.dart';
import '../../data/quota.dart';
import '../../data/tools.dart';
import '../../i18n/i18n.dart';
import '../../protocol/json.dart';
import '../../ui/theme/theme.dart';
import '../../ui/theme/tokens.dart';
import '../../ui/theme/type.dart';

/// 几个订阅账号的额度一起取；电脑太旧（不认 quota）时 error，整节不显示
class QuotaData {
  QuotaData(Connections connections, String deviceId)
    : _data = [
        for (final p in quotaProviders)
          ToolData(connections, deviceId, 'quota', [p]),
      ];
  final List<ToolData> _data;

  Listenable get listenable => Listenable.merge(_data);

  List<QuotaGroup> get groups => [
    for (final d in _data) ?subscriptionQuota(d.data),
  ];

  QuotaGroup? of(String provider) {
    for (final g in groups) {
      if (g.provider == provider) return g;
    }
    return null;
  }

  void reload() {
    for (final d in _data) {
      d.reload();
    }
  }

  void dispose() {
    for (final d in _data) {
      d.dispose();
    }
  }
}

/// 账号页的「额度」一节：平台在前，订阅账号在后；一组都没有时什么都不画
class QuotaSection extends StatefulWidget {
  const QuotaSection({super.key, required this.deviceId, this.account});
  final String deviceId;

  /// 平台账号（account 方法的结果）；没登录为 null
  final Json? account;

  @override
  State<QuotaSection> createState() => _QuotaSectionState();
}

class _QuotaSectionState extends State<QuotaSection> {
  late final QuotaData _quota = QuotaData(
    AppScope.read(context).connections,
    widget.deviceId,
  );

  @override
  void dispose() {
    _quota.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _quota.listenable,
    builder: (context, _) {
      final groups = [?platformQuota(widget.account), ..._quota.groups];
      if (groups.isEmpty) return const SizedBox.shrink();
      final c = context.colors;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 20, 4, 8),
            child: Text(
              L('额度', 'Usage limits'),
              style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
            ),
          ),
          for (final g in groups)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: QuotaCard(group: g),
            ),
        ],
      );
    },
  );
}

class QuotaCard extends StatelessWidget {
  const QuotaCard({super.key, required this.group});
  final QuotaGroup group;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      decoration: BoxDecoration(
        color: c.bgSubtle,
        borderRadius: BorderRadius.circular(Radii.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            group.title,
            style: TextStyle(
              fontSize: Fs.ui,
              fontWeight: FontWeight.w600,
              color: c.text,
            ),
          ),
          const SizedBox(height: 8),
          for (final b in group.bars) _Bar(bar: b),
        ],
      ),
    );
  }
}

class _Bar extends StatelessWidget {
  const _Bar({required this.bar});
  final QuotaBar bar;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final full = bar.rejected || bar.percent >= 100;
    // 快用完（≥ 90%）变警示色，用完是危险色
    final color = full
        ? c.danger
        : bar.percent >= 90
        ? c.warn
        : c.accent;
    final right = [
      if (bar.money != null) bar.money!,
      if (resetText(bar.resetsAt) case final r when r.isNotEmpty) r,
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  bar.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: Fs.meta, color: c.textSecondary),
                ),
              ),
              Text(
                full
                    ? L('已用完', 'Used up')
                    : L(
                        '用了 ${bar.percent.round()}%',
                        '${bar.percent.round()}% used',
                      ),
                style: TextStyle(
                  fontSize: Fs.meta,
                  color: full ? c.danger : c.textSecondary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: LinearProgressIndicator(
              value: full ? 1 : bar.percent / 100,
              minHeight: 6,
              color: color,
              backgroundColor: c.borderSubtle,
            ),
          ),
          if (right.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                right,
                style: TextStyle(fontSize: Fs.meta, color: c.textMuted),
              ),
            ),
        ],
      ),
    );
  }
}

/// 会话模式面板里那一行（§17）：这个会话用的账号「5 小时 用了 62% · 每周 40%」，点了去账号页
class QuotaLine extends StatefulWidget {
  const QuotaLine({super.key, required this.deviceId, required this.provider});
  final String deviceId;

  /// claude / chatgpt / google，或 platform（平台线路的会话）
  final String provider;

  @override
  State<QuotaLine> createState() => _QuotaLineState();
}

class _QuotaLineState extends State<QuotaLine> {
  late final ToolData _data = widget.provider == 'platform'
      ? ToolData(
          AppScope.read(context).connections,
          widget.deviceId,
          'account',
          const [],
        )
      : ToolData(AppScope.read(context).connections, widget.deviceId, 'quota', [
          widget.provider,
        ]);

  @override
  void dispose() {
    _data.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _data,
    builder: (context, _) {
      final g = widget.provider == 'platform'
          ? platformQuota(objOrNull(_data.data))
          : subscriptionQuota(_data.data);
      if (g == null) return const SizedBox.shrink();
      final c = context.colors;
      final hot = g.bars.any((b) => b.rejected || b.percent >= 90);
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: InkWell(
          borderRadius: BorderRadius.circular(Radii.code),
          onTap: () => openAccount(context, widget.deviceId),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Row(
              children: [
                Icon(
                  Icons.data_usage,
                  size: 15,
                  color: hot ? c.warn : c.textMuted,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${providerName(g.provider)} · ${quotaShort(g)}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: Fs.meta,
                      color: hot ? c.warn : c.textSecondary,
                    ),
                  ),
                ),
                Icon(Icons.chevron_right, size: 16, color: c.textMuted),
              ],
            ),
          ),
        ),
      );
    },
  );
}
