// 协议数据在 App 里就是 JSON（电脑经加密通道发来的就是 JSON）：不另建一套类，
// 条目、事件、快照都用 Map 表示，读字段时按 TS 的类型取（packages/protocol/src/types）。
// 好处是和 TS 的结构逐字段一致，测试直接比较 JSON；新字段电脑先加了，App 原样保留不丢。
import 'dart:convert';

typedef Json = Map<String, Object?>;

/// 取对象字段；不是对象时返回空表（只读）
Json obj(Object? value) =>
    value is Map ? value.cast<String, Object?>() : const <String, Object?>{};

/// 取对象字段；不是对象时返回 null
Json? objOrNull(Object? value) =>
    value is Map ? value.cast<String, Object?>() : null;

/// 取对象数组字段；不是数组时返回空数组（只读）
List<Json> objList(Object? value) => value is List
    ? [
        for (final v in value)
          if (v is Map) v.cast<String, Object?>(),
      ]
    : const <Json>[];

String? str(Object? value) => value is String ? value : null;

/// JS 的真假：null、false、0、空串为假（只用在 TS 写了 `!!x` / `x ?` 的字段上）
bool truthy(Object? value) => switch (value) {
  null || false => false,
  final num n => n != 0 && !n.isNaN,
  final String s => s.isNotEmpty,
  _ => true,
};

// JS 的 String.prototype.trim：Dart 的 trim 还会去掉 U+0085，和 TS 不一致；RegExp 的 \s 和 JS 相同
final _edges = RegExp(r'^\s+|\s+$');
String jsTrim(String s) => s.replaceAll(_edges, '');

/// 同 TS 的 JSON.stringify 比较（顺序敏感）；没有这个键时为 null（JSON.stringify(undefined) 是 undefined）
String? stringifyField(Json map, String key) =>
    map.containsKey(key) ? jsonEncode(map[key]) : null;

/// 条目（packages/protocol/src/types/item.ts 的 Item）：按 kind 区分的 JSON 对象
extension type Item(Json json) implements Json {
  String get kind => json['kind'] as String;
  String get id => json['id'] as String;
  String get text => str(json['text']) ?? '';
  String? get status => str(json['status']);
  String? get mode => str(json['mode']);
  String? get level => str(json['level']);
  String? get tool => str(json['tool']);

  bool get isUser => kind == 'user';

  /// 命令、文件改动、工具调用
  bool get isToolLike =>
      kind == 'command' || kind == 'file_change' || kind == 'tool';

  /// 带 review 时的审核状态
  String? get reviewStatus => str(obj(json['review'])['status']);
}

List<Item> itemsOf(Object? value) => [for (final m in objList(value)) Item(m)];
