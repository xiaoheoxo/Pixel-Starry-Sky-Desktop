// 会话的模式（权限、模型、强度、快速模式）：胶囊上的文字和改模式面板里的选项。规则照网页版
// apps/mobile/src/data/mode.ts，测试照 mode.test.ts。值 '' 表示「用电脑上的默认」。
import '../i18n/i18n.dart';
import '../protocol/constants.dart';
import '../protocol/json.dart';

Map<String, String> _permission() => {
  'ask': L('每步问我', 'Ask every step'),
  'edits': L('自动改文件', 'Auto-edit files'),
  'auto': L('自动审核', 'Auto-review'),
  'plan': L('只规划', 'Plan only'),
  'full': L('完全放行', 'Full access'),
};

Map<String, String> _effort() => {
  'low': L('低', 'Low'),
  'medium': L('中', 'Medium'),
  'high': L('高', 'High'),
  'xhigh': L('超高', 'Extra high'),
  'max': L('最高', 'Max'),
  'ultra': L('极致', 'Ultra'),
};

String permissionLabel(String mode) => _permission()[mode] ?? mode;
String effortLabel(String effort) => _effort()[effort] ?? effort;

const _maxRaw = 16;
final _next = RegExp(
  r'^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)',
  caseSensitive: false,
);
final _old = RegExp(
  r'^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?!\w)',
  caseSensitive: false,
);
final _alias = RegExp(r'^(opus|sonnet|haiku)$', caseSensitive: false);

/// 模型名简化：claude-sonnet-4-5-2025… → 「Sonnet 4.5」；认不出的显示原文，太长截断
String modelLabel(String model) {
  final name = model.trim().replaceFirst(RegExp(r'\[\w+\]$'), '');
  String cap(String s) => s[0].toUpperCase() + s.substring(1).toLowerCase();
  final n = _next.firstMatch(name);
  if (n != null) {
    return '${cap(n[1]!)} ${n[2]}${n[3] != null ? '.${n[3]}' : ''}';
  }
  final o = _old.firstMatch(name);
  if (o != null) {
    return '${cap(o[3]!)} ${o[1]}${o[2] != null ? '.${o[2]}' : ''}';
  }
  if (_alias.hasMatch(name)) return cap(name);
  return name.length > _maxRaw ? '${name.substring(0, _maxRaw)}…' : name;
}

// ---- 「先出计划」开关（docs/mobile-app.md §15.2）：权限档位和计划分开，计划中另记批准后回到哪一档（planReturn）----

/// 会话在计划中（先出计划开着）
bool inPlan(Json record) => str(record['permissionMode']) == 'plan';

/// 计划中时批准后回到哪一档；没记（旧记录、旧电脑）是每步问我
String planReturnOf(Json record) => str(record['planReturn']) ?? 'ask';

/// 在手机上批准计划后实际用哪一档：完全放行回到自动改文件（电脑 ops.ts 的 engine:answer）
String approvedOnPhone(String ret) => ret == 'full' ? 'edits' : ret;

/// 手机上关掉「先出计划」切到哪一档：完全放行、自动审核手机开不了，回到自动改文件
String planOffMode(String ret) =>
    ret == 'full' || ret == 'auto' ? 'edits' : ret;

/// 计划卡、开关下面的一句：批准后按哪一档去做
String planAfterText(Json record) {
  final ret = planReturnOf(record);
  final mode = permissionLabel(approvedOnPhone(ret));
  return ret == 'full'
      ? L(
          '批准后按「$mode」去做（电脑上是完全放行，手机上批准回到自动改文件）',
          'After approval it continues with “$mode” (full access on the computer; approving on the phone returns to auto-edit)',
        )
      : L('批准后按「$mode」去做', 'After approval it continues with “$mode”');
}

/// 胶囊上的三段：权限、模型（没指定时 null）、强度（没指定时 null）。计划中权限写「先出计划 · 批准后那档」
({String permission, String? model, String? effort}) modeChip(Json record) {
  final model = str(record['model']);
  final effort = str(record['effort']);
  return (
    permission: inPlan(record)
        ? '${L('先出计划', 'Plan first')} · ${permissionLabel(planReturnOf(record))}'
        : permissionLabel(str(record['permissionMode']) ?? 'ask'),
    model: model != null && model.isNotEmpty ? modelLabel(model) : null,
    effort: effort != null && effort.isNotEmpty ? effortLabel(effort) : null,
  );
}

class ModeOption {
  const ModeOption(this.value, this.label, {this.hint, this.disabled = false});
  final String value;
  final String label;
  final String? hint;
  final bool disabled;

  @override
  bool operator ==(Object other) =>
      other is ModeOption &&
      other.value == value &&
      other.label == label &&
      other.hint == hint &&
      other.disabled == disabled;

  @override
  int get hashCode => Object.hash(value, label, hint, disabled);

  @override
  String toString() => 'ModeOption($value, $label, $hint, $disabled)';
}

/// 手机能切的档（从严到宽）；自动审核、完全放行只能在电脑上开。计划不是一档，是另外的开关
const _phoneModes = ['ask', 'edits'];
const _rank = {'plan': 0, 'ask': 1, 'edits': 2, 'auto': 3, 'full': 4};

/// 往更宽的权限切（要确认一次）
bool widens(String? from, String to) =>
    (_rank[to] ?? 0) > (_rank[from ?? 'ask'] ?? 1);

List<ModeOption> permissionOptions(String engine, String? current) {
  final caps = engines[engine]?.permissionModes ?? _phoneModes;
  final labels = _permission();
  final hints = {
    'ask': L(
      '改文件、运行命令前都问你',
      'Asks you before editing files or running commands',
    ),
    'edits': L(
      '改文件不问，运行命令前问你',
      'Edits files freely, asks before running commands',
    ),
  };
  final out = [
    for (final m in _phoneModes)
      if (caps.contains(m)) ModeOption(m, labels[m]!, hint: hints[m]),
  ];
  if (current == 'full' || current == 'auto') {
    out.add(
      ModeOption(
        current!,
        labels[current]!,
        hint: L('只能在电脑上打开', 'Can only be turned on on the computer'),
        disabled: true,
      ),
    );
  }
  if (current == null) {
    out.insert(0, ModeOption('', L('电脑上的设置', "Computer's settings")));
  }
  return out;
}

/// 模型目录里的一项（packages/protocol 的 EngineModel）
extension type EngineModel(Json json) implements Json {
  String get id => json['id'] as String;
  String get label => str(json['label']) ?? '';
  String? get description {
    final d = str(json['description']);
    return d == null || d.isEmpty ? null : d;
  }

  List<String> get efforts => [
    for (final e in (json['efforts'] as List?) ?? const []) e as String,
  ];
}

List<ModeOption> modelOptions(List<EngineModel>? models, String? current) {
  final out = [
    ModeOption(
      '',
      L('默认', 'Default'),
      hint: L('用电脑上设的模型', 'Uses the model set on the computer'),
    ),
    for (final m in models ?? const <EngineModel>[])
      ModeOption(
        m.id,
        m.label.isNotEmpty ? m.label : modelLabel(m.id),
        hint: m.description,
      ),
  ];
  if (current != null &&
      current.isNotEmpty &&
      !out.any((o) => o.value == current)) {
    out.add(ModeOption(current, modelLabel(current)));
  }
  return out;
}

List<ModeOption> effortOptions(
  String engine,
  EngineModel? model,
  String? current,
) {
  final list = model != null && model.efforts.isNotEmpty
      ? model.efforts
      : (engines[engine]?.efforts ?? const <String>[]);
  final labels = _effort();
  return [
    ModeOption('', L('默认', 'Default')),
    for (final e in list) ModeOption(e, labels[e] ?? e),
    if (current != null && current.isNotEmpty && !list.contains(current))
      ModeOption(current, labels[current] ?? current),
  ];
}

Map<String, String> _fastBlocked() => {
  'free': L('免费账号不能用', 'Not available on free accounts'),
  'preference': L(
    '账号没有开启 Fast 模式',
    'Fast mode is not enabled for this account',
  ),
  'extra_usage_disabled': L(
    '账号没有开启额外用量',
    'Extra usage is not enabled for this account',
  ),
  'network_error': L('网络错误', 'Network error'),
  'not_first_party': L(
    '只支持 Anthropic 官方接口',
    'Only supported with the official Anthropic API',
  ),
  'disabled_by_env': L('被环境变量关闭了', 'Disabled by an environment variable'),
  'model_not_allowed': L('当前模型不支持', 'Not supported by the current model'),
  'pending': L('正在确认账号状态', 'Checking account status'),
};

Map<String, String> _fastHint() => {
  'codex_gateway': L(
    '接口支持 Fast 时生效，不支持的打开了也没有效果',
    'Takes effect if the API supports Fast; otherwise turning it on does nothing',
  ),
  'codex_unverified': L(
    '你的接口或当前模型可能不支持 Fast，打开了可能不生效',
    'Your API or the current model may not support Fast, so it might not take effect',
  ),
};

String fastDefaultHint() =>
    L('回复更快，按更高的价格计费', 'Faster replies, billed at a higher rate');

/// 快速模式开关的状态：能不能拨、下面那行字、是不是警示、是否冷却中
({bool available, String hint, bool warn, bool cooldown}) fastStatus(
  Json? flags,
) {
  final reason = str(flags?['fastBlocked']);
  if (flags?['fastAvailable'] == false) {
    final why = (reason != null ? _fastBlocked()[reason] : null);
    return (
      available: false,
      hint: L(
        '暂时不可用：${why ?? '原因未知'}',
        'Unavailable: ${why ?? 'unknown reason'}',
      ),
      warn: true,
      cooldown: false,
    );
  }
  if (flags?['fastState'] == 'cooldown') {
    return (
      available: true,
      hint: L(
        'Fast 暂时不可用（冷却中），这段时间按普通速度回复，会自动恢复',
        'Fast is cooling down. Replies use normal speed for now and Fast resumes automatically',
      ),
      warn: true,
      cooldown: true,
    );
  }
  return (
    available: true,
    hint: (reason != null ? _fastHint()[reason] : null) ?? fastDefaultHint(),
    warn: false,
    cooldown: false,
  );
}

String fastConfirm() => L(
  '打开快速模式？回复更快，但按更高的价格计费。这个会话之后的每一轮都算，随时可以关掉。',
  'Turn on Fast mode? Replies are faster but billed at a higher rate. It applies to every following turn in this conversation, and you can turn it off anytime.',
);

String widenConfirm() => L(
  '放宽权限：AI 改文件时不再先问你。确定吗？',
  'Loosen permissions: the AI will edit files without asking you first. Continue?',
);

// ---------------------------------------------------------------------------
// 上下文用量圆环（同网页版 data/context.ts）
// ---------------------------------------------------------------------------

/// 过期、压缩中、没有数据时返回 null；百分比最高 100
({double percent, num used, num window})? contextUsage(Json? c) {
  if (c == null || c['stale'] == true || c['compacting'] == true) return null;
  final used = c['used'], window = c['window'];
  if (used is! num || window is! num) return null;
  if (!used.isFinite || !window.isFinite || window <= 0) return null;
  return (
    percent: (used / window * 100).clamp(0, 100).toDouble(),
    used: used,
    window: window,
  );
}

String _trim(num v, int digits) {
  final s = v.toStringAsFixed(digits);
  return s.contains('.') ? s.replaceFirst(RegExp(r'\.?0+$'), '') : s;
}

String contextNumber(num value) {
  if (value >= 1000000) return '${_trim(value / 1000000, 2)}M';
  if (value >= 1000) return '${_trim(value / 1000, 1)}k';
  return '$value';
}

String contextLabel(({double percent, num used, num window}) u) {
  final p = u.percent.round();
  final used = contextNumber(u.used), window = contextNumber(u.window);
  return L('上下文 $p%：已用 $used / $window', 'Context $p%: $used / $window used');
}
