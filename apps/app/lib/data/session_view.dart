// 一个会话在手机上的状态：快照 + 按 seq 应用的事件（照网页版 apps/mobile/src/data/session.ts）。
// 纯函数，测试在 test/data/session_view_test.dart。
import '../protocol/json.dart';
import '../protocol/reduce.dart';

class SessionView {
  const SessionView({
    this.snapshot,
    this.seq = 0,
    this.before,
    this.truncated = const [],
    this.buffer = const [],
    this.stale = false,
  });

  final Json? snapshot;
  final int seq;

  /// 还有更早的条目时，向上翻页用的 id
  final String? before;

  /// 被截断过的条目（显示「查看完整」）
  final List<String> truncated;

  /// 快照还没到时先存下来的事件
  final List<({int seq, Json event})> buffer;

  /// seq 接不上（断线、电脑重启）：要重新打开
  final bool stale;

  List<Item> get items => itemsOf(snapshot?['items']);

  SessionView copyWith({
    Json? snapshot,
    int? seq,
    String? before,
    bool clearBefore = false,
    List<String>? truncated,
    List<({int seq, Json event})>? buffer,
    bool? stale,
  }) => SessionView(
    snapshot: snapshot ?? this.snapshot,
    seq: seq ?? this.seq,
    before: clearBefore ? null : before ?? this.before,
    truncated: truncated ?? this.truncated,
    buffer: buffer ?? this.buffer,
    stale: stale ?? this.stale,
  );
}

/// engine:openSessionTail 的回复
class Tail {
  const Tail({
    required this.snapshot,
    required this.seq,
    this.before,
    this.truncated = const [],
  });
  final Json snapshot;
  final int seq;
  final String? before;
  final List<String> truncated;

  static Tail parse(Object? raw) {
    final m = obj(raw);
    return Tail(
      snapshot: obj(m['snapshot']),
      seq: (m['seq'] as num?)?.toInt() ?? 0,
      before: str(m['before']),
      truncated: [
        for (final t in (m['truncated'] as List? ?? const []))
          if (t is String) t,
      ],
    );
  }
}

SessionView _applyOne(SessionView view, int seq, Json event) {
  if (seq <= view.seq) return view;
  if (seq != view.seq + 1) return view.copyWith(stale: true);
  return view.copyWith(seq: seq, snapshot: reduce(view.snapshot!, event));
}

/// 收到会话事件
SessionView applyEvent(SessionView view, int seq, Json event) {
  if (view.snapshot == null) {
    return view.copyWith(buffer: [...view.buffer, (seq: seq, event: event)]);
  }
  if (view.stale) return view;
  return _applyOne(view, seq, event);
}

/// 快照到了：替换，再补上之前存下的、seq 更大的事件
SessionView applyTail(SessionView view, Tail tail) {
  var next = SessionView(
    snapshot: tail.snapshot,
    seq: tail.seq,
    before: tail.before,
    truncated: tail.truncated,
  );
  final buffered = [...view.buffer]..sort((a, b) => a.seq.compareTo(b.seq));
  for (final b in buffered) {
    next = _applyOne(next, b.seq, b.event);
  }
  return next;
}

/// 向上翻页：更早的条目接在前面（按 id 去重）
SessionView prependOlder(SessionView view, Tail older) {
  final snapshot = view.snapshot;
  if (snapshot == null) return view;
  final have = {for (final i in view.items) i.id};
  return SessionView(
    snapshot: {
      ...snapshot,
      'items': [
        ...itemsOf(older.snapshot['items']).where((i) => !have.contains(i.id)),
        ...view.items,
      ],
    },
    seq: view.seq,
    before: older.before,
    truncated: [...older.truncated, ...view.truncated],
    buffer: view.buffer,
    stale: view.stale,
  );
}

/// 点了「查看完整」：换成完整的那一条
SessionView replaceItem(SessionView view, Item item, bool truncated) {
  final snapshot = view.snapshot;
  if (snapshot == null) return view;
  return view.copyWith(
    snapshot: {
      ...snapshot,
      'items': [for (final i in view.items) i.id == item.id ? item : i],
    },
    truncated: truncated
        ? view.truncated
        : [
            for (final id in view.truncated)
              if (id != item.id) id,
          ],
  );
}
