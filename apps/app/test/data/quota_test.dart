// 账号额度（docs/mobile-app.md §17）：订阅额度、平台额度的换算和文字
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/quota.dart';
import 'package:pixelsky_app/i18n/i18n.dart';

void main() {
  setUp(() => language.value = AppLanguage.zh);

  test('订阅额度：按时长排、分模型的放后面；不支持、没数据的不显示', () {
    final g = subscriptionQuota({
      'provider': 'claude',
      'status': 'ok',
      'plan': 'max',
      'windows': [
        {'durationMins': 10080, 'usedPercent': 40, 'resetsAt': null},
        {'durationMins': 300, 'usedPercent': 120, 'resetsAt': null},
      ],
      'models': [
        {
          'name': 'Opus',
          'durationMins': 10080,
          'usedPercent': 55,
          'rejected': true,
        },
      ],
    })!;
    expect(g.title, 'Claude · max');
    expect([for (final b in g.bars) b.label], ['5 小时', '每周', 'Opus · 每周']);
    expect(g.bars.first.percent, 100);
    expect(g.bars.last.rejected, isTrue);
    expect(
      subscriptionQuota({'provider': 'google', 'status': 'unsupported'}),
      isNull,
    );
    expect(
      subscriptionQuota({
        'provider': 'claude',
        'status': 'empty',
        'windows': [],
      }),
      isNull,
    );
    expect(subscriptionQuota('MOBILE_UNSUPPORTED'), isNull);
  });

  test('平台额度：上限 0 的窗口跳过，金额写出来；一个都没有不显示', () {
    final g = platformQuota({
      'currency': 'USD',
      'plan': 'Pro',
      'rateLimits': [
        {'window': '5h', 'used': 3.2, 'limit': 10},
        {'window': '1d', 'used': 1, 'limit': 0},
        {'window': '7d', 'used': 41.5, 'limit': 50},
      ],
    })!;
    expect([for (final b in g.bars) b.label], ['5 小时', '每周']);
    expect(g.bars.first.percent.round(), 32);
    expect(g.bars.first.money, r'$3.20 / $10.00');
    expect(platformQuota({'rateLimits': []}), isNull);
    expect(platformQuota(null), isNull);
    expect(platformWindowMinutes('1d'), 1440);
    expect(platformWindowMinutes('x'), isNull);
  });

  test('简写和重置时间', () {
    final g = subscriptionQuota({
      'provider': 'chatgpt',
      'status': 'ok',
      'windows': [
        {'durationMins': 300, 'usedPercent': 62.4},
        {'durationMins': 10080, 'usedPercent': 40, 'rejected': true},
      ],
    })!;
    expect(quotaShort(g), '5 小时 用了 62% · 每周 已用完');
    final now = DateTime(2026, 11, 18, 12);
    final at = now.millisecondsSinceEpoch;
    expect(resetText(at + 40 * 60000, now), '40 分钟后重置');
    expect(resetText(at + (2 * 60 + 20) * 60000, now), '2 小时 20 分后重置');
    expect(resetText(at + 3 * 86400000, now), '3 天后重置');
    expect(resetText(null, now), '');
    expect(engineQuotaProvider('codex'), 'chatgpt');
    expect(engineQuotaProvider('pixel'), isNull);
  });
}
