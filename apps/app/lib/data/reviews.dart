// AI 审查结果（第三批 C4，docs/mobile-app.md §15.5）：电脑上「AI 审查」过的那一轮，结果存在电脑主进程；
// 手机经网关的 reviews 取、reviews:changed（{kind: 'reviews', sessionId, turns}）推。
// 「修这条」「全部修复」发的文字由电脑拼（reviewFix），「忽略」「恢复」是 reviewItem。这一批手机上不能发起审查。
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../protocol/json.dart';

/// 一条审查意见（apps/desktop 的 ReviewItem）
extension type ReviewEntry(Json json) implements Json {
  String get id => str(json['id']) ?? '';

  /// open / sent / fixed / ignored
  String get status => str(json['status']) ?? 'open';

  /// high / medium / low
  String get severity => str(json['severity']) ?? 'low';
  String get title => str(json['title']) ?? '';
  String get detail => str(json['detail']) ?? '';
  String get file => str(json['file']) ?? '';
  int? get line => (json['line'] as num?)?.toInt();

  /// 「文件:行」；没有文件时 null
  String? get where =>
      file.isEmpty ? null : (line == null ? file : '$file:$line');
}

/// 一轮的审查结果（apps/desktop 的 TurnReview）
extension type TurnReviewData(Json json) implements Json {
  String get model => str(json['model']) ?? '';
  List<ReviewEntry> get items => [
    for (final i in objList(json['items'])) ReviewEntry(i),
  ];

  /// 没按格式回时的原文
  String? get raw => str(json['raw']);

  /// 没忽略的（严重的在前）
  List<ReviewEntry> get shown {
    const order = {'high': 0, 'medium': 1, 'low': 2};
    return items.where((i) => i.status != 'ignored').toList()..sort(
      (a, b) => (order[a.severity] ?? 3).compareTo(order[b.severity] ?? 3),
    );
  }

  /// 还没处理的条数（「全部修复（N）」）
  int get open => items.where((i) => i.status == 'open').length;
  int get ignored => items.where((i) => i.status == 'ignored').length;
}

/// 这一轮的轮次 key（同电脑 changeBlocks.ts）：这一轮开头那条用户消息的 id；接着说的指导、
/// 断线重连自动发的「继续」不算新的一轮。第一条用户消息之前的改动是 'start'
String turnKeyOf(List<Item> turn) {
  for (final i in turn) {
    if (i.kind == 'user' &&
        i['mode'] != 'guidance' &&
        !i.json.containsKey('reconnect')) {
      return i.id;
    }
  }
  return 'start';
}

/// 一个会话页的审查结果：连上时取，电脑推了就换
class SessionReviews extends ChangeNotifier {
  SessionReviews(this._connections, this.deviceId, this.sessionId) {
    _connections.addListener(_check);
    _events = _connections.events.listen(_onEvent);
    _check();
  }

  final Connections _connections;
  final String deviceId;
  final String sessionId;
  late final StreamSubscription<DesktopEvent> _events;
  LinkState? _state;
  bool _disposed = false;

  Map<String, TurnReviewData> turns = const {};

  DesktopLink? get _link => _connections.link(deviceId);

  void _check() {
    final state = _connections.state(deviceId);
    if (state == _state) return;
    _state = state;
    if (state == LinkState.ready) _load();
  }

  Future<void> _load() async {
    final link = _link;
    if (link == null) return;
    try {
      _set(await link.call('reviews', [sessionId]));
    } catch (_) {
      // 电脑版本旧：没有审查卡
    }
  }

  void _set(Object? raw) {
    if (_disposed || raw is! Map) return;
    turns = {
      for (final e in raw.entries)
        if (e.key is String && e.value is Map)
          e.key as String: TurnReviewData(obj(e.value)),
    };
    notifyListeners();
  }

  void _onEvent(DesktopEvent e) {
    if (e.deviceId != deviceId || e.channel != 'reviews:changed') return;
    final data = objOrNull(e.data);
    if (data?['kind'] != 'reviews' || data?['sessionId'] != sessionId) return;
    _set(data!['turns']);
  }

  Future<Object?> _call(String method, List<Object?> args) {
    final l = _link;
    if (l == null) return Future.error(const LinkNotReady());
    return l.call(method, [sessionId, ...args]);
  }

  /// 忽略 / 恢复一条
  Future<void> setStatus(String turnKey, String itemId, String status) =>
      _call('reviewItem', [turnKey, itemId, status]).then((_) {});

  /// 发去修：ids 为 null 是「全部修复」（没处理的那些）
  Future<void> fix(String turnKey, List<String>? ids) =>
      _call('reviewFix', [turnKey, ids]).then((_) {});

  @override
  void dispose() {
    _disposed = true;
    _connections.removeListener(_check);
    _events.cancel();
    super.dispose();
  }
}
