// 账号额度（docs/mobile-app.md §17，电脑 docs/ui/account-quota.md）：订阅账号经网关 quota 方法取，
// 平台账号从 account 里的 rateLimits 换算（同电脑 platformQuota.ts）。纯函数。
import '../i18n/i18n.dart';
import '../protocol/json.dart';

/// 一个额度窗口（5 小时、每周、分模型的周额度…）
typedef QuotaBar = ({
  String label,
  double percent,
  num? resetsAt,
  bool rejected,
  String? money,
});

/// 一个账号的额度：给谁看的名字 + 几条
typedef QuotaGroup = ({String provider, String title, List<QuotaBar> bars});

const quotaProviders = ['claude', 'chatgpt', 'google'];

String providerName(String p) => switch (p) {
  'claude' => 'Claude',
  'chatgpt' => 'ChatGPT',
  'google' => 'Antigravity',
  _ => L('像素星空平台', 'PixelSky platform'),
};

/// 引擎 → 它用的订阅账号（不用订阅的引擎为 null）
String? engineQuotaProvider(String engine) => switch (engine) {
  'claude' => 'claude',
  'codex' => 'chatgpt',
  'antigravity' => 'google',
  _ => null,
};

/// 窗口名：按时长认（同电脑 quotaModel）
String windowLabel(num? mins) {
  if (mins == null) return L('额度', 'Limit');
  if (mins == 300) return L('5 小时', '5 hours');
  if (mins == 1440) return L('每天', 'Daily');
  if (mins == 10080) return L('每周', 'Weekly');
  if (mins % 1440 == 0) return L('${mins ~/ 1440} 天', '${mins ~/ 1440} days');
  if (mins % 60 == 0) return L('${mins ~/ 60} 小时', '${mins ~/ 60} hours');
  return L('$mins 分钟', '$mins min');
}

double _pct(Object? v) => ((v as num?)?.toDouble() ?? 0).clamp(0, 100);

/// 订阅账号的额度；不支持、没数据时 null（不显示这一组）
QuotaGroup? subscriptionQuota(Object? raw) {
  final q = objOrNull(raw);
  if (q == null) return null;
  final provider = str(q['provider']) ?? '';
  if (q['status'] == 'unsupported') return null;
  final bars = <QuotaBar>[
    for (final w
        in objList(q['windows']).toList()..sort(
          (a, b) => ((a['durationMins'] as num?) ?? 1e9).compareTo(
            (b['durationMins'] as num?) ?? 1e9,
          ),
        ))
      (
        label: windowLabel(w['durationMins'] as num?),
        percent: _pct(w['usedPercent']),
        resetsAt: w['resetsAt'] as num?,
        rejected: w['rejected'] == true,
        money: null,
      ),
    for (final m in objList(q['models']))
      (
        label:
            '${str(m['name']) ?? ''} · ${windowLabel(m['durationMins'] as num?)}',
        percent: _pct(m['usedPercent']),
        resetsAt: m['resetsAt'] as num?,
        rejected: m['rejected'] == true,
        money: null,
      ),
  ];
  if (bars.isEmpty) return null;
  final plan = str(q['plan']);
  return (
    provider: provider,
    title: plan == null || plan.isEmpty
        ? providerName(provider)
        : '${providerName(provider)} · $plan',
    bars: bars,
  );
}

/// 「5h」「1d」「7d」→ 分钟（同电脑 platformQuota.windowMinutes）
int? platformWindowMinutes(String w) {
  final m = RegExp(
    r'^(\d+)\s*([hd])$',
    caseSensitive: false,
  ).firstMatch(w.trim());
  if (m == null) return null;
  final n = int.parse(m.group(1)!);
  if (n <= 0) return null;
  return m.group(2)!.toLowerCase() == 'h' ? n * 60 : n * 1440;
}

/// 平台账号的额度：account 里每个有上限的窗口（上限 0 是不限，跳过）；一个都没有时 null
QuotaGroup? platformQuota(Json? account) {
  if (account == null) return null;
  final currency = str(account['currency']) ?? 'USD';
  final bars = <QuotaBar>[];
  for (final r in objList(account['rateLimits'])) {
    final limit = (r['limit'] as num?)?.toDouble() ?? 0;
    final used = (r['used'] as num?)?.toDouble();
    if (!(limit > 0) || used == null || !used.isFinite) continue;
    final sign = currency == 'CNY' ? '¥' : r'$';
    bars.add((
      label: windowLabel(platformWindowMinutes(str(r['window']) ?? '')),
      percent: (used / limit * 100).clamp(0, 100).toDouble(),
      resetsAt: null,
      rejected: false,
      money:
          '$sign${used.toStringAsFixed(2)} / $sign${limit.toStringAsFixed(2)}',
    ));
  }
  if (bars.isEmpty) return null;
  final plan = str(account['plan']);
  return (
    provider: 'platform',
    title: plan == null || plan.isEmpty
        ? providerName('platform')
        : '${providerName('platform')} · $plan',
    bars: bars,
  );
}

/// 「3 小时 20 分后重置」；不知道时空串
String resetText(num? at, [DateTime? now]) {
  if (at == null) return '';
  final ms = at - (now ?? DateTime.now()).millisecondsSinceEpoch;
  if (ms <= 0) return L('已重置', 'Reset');
  final mins = (ms / 60000).ceil();
  if (mins < 60) return L('$mins 分钟后重置', 'Resets in $mins min');
  final h = mins ~/ 60;
  if (h < 24) {
    final m = mins % 60;
    return m == 0
        ? L('$h 小时后重置', 'Resets in ${h}h')
        : L('$h 小时 $m 分后重置', 'Resets in ${h}h ${m}m');
  }
  return L('${h ~/ 24} 天后重置', 'Resets in ${h ~/ 24}d');
}

/// 会话模式面板里那一行：「5 小时 用了 62% · 每周 40%」（最多两条）
String quotaShort(QuotaGroup g) => [
  for (final b in g.bars.take(2))
    b.rejected
        ? L('${b.label} 已用完', '${b.label} used up')
        : L(
            '${b.label} 用了 ${b.percent.round()}%',
            '${b.label} ${b.percent.round()}% used',
          ),
].join(' · ');
