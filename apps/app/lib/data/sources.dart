// 额度来源（docs/mobile-app.md §14.4）：手机只能在电脑上配好的来源里选（自己的账号、平台线路、自定义接口），
// 列表来自电脑网关的 sources；换到平台、或换成更贵的线路时先确认倍率。规则都是纯函数，界面在 mode_sheet.dart。
import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'mode.dart';

class SourceLine {
  SourceLine(Json j)
    : id = str(j['id']) ?? '',
      name = str(j['name']) ?? '',
      rate = (j['rate'] as num?)?.toDouble() ?? 1,
      models = [for (final m in (j['models'] as List? ?? const [])) '$m'];
  final String id;
  final String name;
  final double rate;
  final List<String> models;
}

class SourceProvider {
  SourceProvider(Json j)
    : id = str(j['id']) ?? '',
      name = str(j['name']) ?? '',
      models = [for (final m in (j['models'] as List? ?? const [])) '$m'];
  final String id;
  final String name;
  final List<String> models;
}

/// 电脑上配好的来源（网关 PhoneSources）
class PhoneSources {
  PhoneSources(Json j)
    : platform = j['platform'] is List
          ? [for (final g in objList(j['platform'])) SourceLine(g)]
          : null,
      platformError = str(j['platformError']),
      providers = [for (final p in objList(j['providers'])) SourceProvider(p)];

  /// 平台线路，倍率从低到高；电脑没登录、余额不足、读不到时为 null（原因在 platformError）
  final List<SourceLine>? platform;
  final String? platformError;
  final List<SourceProvider> providers;

  SourceLine? line(String? id) {
    for (final g in platform ?? const <SourceLine>[]) {
      if (g.id == id) return g;
    }
    return null;
  }

  SourceProvider? provider(String? id) {
    for (final p in providers) {
      if (p.id == id) return p;
    }
    return null;
  }
}

/// 会话现在用的来源：'self' / 'platform:<线路>' / 'provider:<接口>'
String sourceKey(Json record) {
  final platform = objOrNull(record['platform']);
  if (platform != null) return 'platform:${str(platform['groupId']) ?? ''}';
  final provider = objOrNull(record['provider']);
  if (provider != null) return 'provider:${str(provider['id']) ?? ''}';
  return 'self';
}

/// 倍率怎么写：×0.6、×1、×1.5，最多三位小数（同电脑 formatMultiplier）
String rateText(double rate) =>
    '×${rate.toStringAsFixed(3).replaceFirst(RegExp(r'\.?0+$'), '')}';

/// 面板里的选项：自己的账号、各条平台线路（带倍率）、各个自定义接口；现在用的不在列表里时照样列出来（灰掉）
List<ModeOption> sourceOptions(PhoneSources s, Json record) {
  final current = sourceKey(record);
  final out = <ModeOption>[
    ModeOption(
      'self',
      L('自己的账号', 'My own account'),
      hint: L('引擎自己的登录或配置', "The engine's own sign-in or config"),
    ),
    for (final g in s.platform ?? const <SourceLine>[])
      ModeOption(
        'platform:${g.id}',
        L('平台 · ${g.name}', 'Platform · ${g.name}'),
        hint: L('倍率 ${rateText(g.rate)}', 'Rate ${rateText(g.rate)}'),
      ),
    for (final p in s.providers)
      ModeOption(
        'provider:${p.id}',
        L('自定义接口 · ${p.name}', 'Custom API · ${p.name}'),
      ),
  ];
  if (!out.any((o) => o.value == current)) {
    out.add(
      ModeOption(
        current,
        current.startsWith('platform:')
            ? L('平台线路（电脑上现在用不了）', 'Platform route (not available now)')
            : L('自定义接口（电脑上已删除）', 'Custom API (removed on the computer)'),
        disabled: true,
      ),
    );
  }
  return out;
}

/// 选了某个来源要发给电脑的补丁
Json sourcePatch(String key) {
  if (key.startsWith('platform:')) {
    return {
      'source': {'kind': 'platform', 'groupId': key.substring(9)},
    };
  }
  if (key.startsWith('provider:')) {
    return {
      'source': {'kind': 'provider', 'id': key.substring(9)},
    };
  }
  return {
    'source': {'kind': 'self'},
  };
}

/// 换到这个来源前要不要确认、确认时说什么：换到平台（花平台余额），或换成倍率更高的线路
String? sourceConfirm(PhoneSources s, Json record, String key) {
  if (!key.startsWith('platform:')) return null;
  final next = s.line(key.substring(9));
  if (next == null) return null;
  final now = sourceKey(record);
  final before = now.startsWith('platform:') ? s.line(now.substring(9)) : null;
  if (before != null && next.rate <= before.rate) return null;
  return before == null
      ? L(
          '改用平台线路「${next.name}」？之后的对话按倍率 ${rateText(next.rate)} 花平台余额。',
          'Switch to the platform route “${next.name}”? Following turns use your platform balance at rate ${rateText(next.rate)}.',
        )
      : L(
          '换成更贵的线路「${next.name}」？倍率从 ${rateText(before.rate)} 变成 ${rateText(next.rate)}。',
          'Switch to the pricier route “${next.name}”? The rate goes from ${rateText(before.rate)} to ${rateText(next.rate)}.',
        );
}

/// 平台 / 自定义接口的会话能选哪些模型（来自那条线路 / 那个接口）；自己的账号或接口没列模型时为 null（用引擎目录 / 不能改）
List<String>? sourceModels(PhoneSources? s, Json record) {
  if (s == null) return null;
  final key = sourceKey(record);
  if (key.startsWith('platform:')) return s.line(key.substring(9))?.models;
  if (key.startsWith('provider:')) {
    final models = s.provider(key.substring(9))?.models;
    return models == null || models.isEmpty ? null : models;
  }
  return null;
}
