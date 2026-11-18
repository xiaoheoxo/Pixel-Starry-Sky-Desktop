// 团队收件箱（docs/mobile-app.md §16.2，同电脑 multica-learn.md §11.5）：借电脑的登录读，一件事一行；
// 标已读 / 归档 / 延后 / 取消订阅、同意 / 拒绝队友派的活都交给电脑转给云端。电脑说频道变了就重取。
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';

/// 收件箱一行
extension type InboxItem(Json json) implements Json {
  String get teamId => str(json['teamId']) ?? '';
  String get key => str(json['key']) ?? '';
  String get channelId => str(json['channelId']) ?? '';

  /// mention / reply / assigned / approval / failed / done / review / rejected
  String get kind => str(json['kind']) ?? 'mention';
  String get actor => str(json['actor']) ?? '';
  String get text => str(json['text']) ?? '';
  int get count => (json['count'] as num?)?.toInt() ?? 1;
  num get at => (json['at'] as num?) ?? 0;
  bool get read => json['read'] == true;
  bool get muted => json['muted'] == true;
  num? get snoozeUntil => json['snoozeUntil'] as num?;

  /// 延后到的时间还没到：先不显示
  bool snoozed(num now) => (snoozeUntil ?? 0) > now;
}

/// 这一行是什么事（列表上的小标签）
String inboxKindText(String kind) => switch (kind) {
  'mention' => L('@ 你', 'Mentioned you'),
  'reply' => L('回复你', 'Replied'),
  'assigned' => L('派给你的 AI', 'Assigned to your AI'),
  'approval' => L('等你同意', 'Needs your OK'),
  'failed' => L('失败', 'Failed'),
  'done' => L('完成', 'Done'),
  'review' => L('等你决定', 'Needs your decision'),
  'rejected' => L('被拒绝', 'Declined'),
  _ => L('通知', 'Notice'),
};

/// 后台要提醒的几类（D333：只有「@ 你」「等你同意」「失败」）
const alertKinds = {'mention', 'approval', 'failed'};

/// 前后两次收件箱之间要提醒的（§16.2）：新来的或又有更新的、没读、没取消订阅、没在延后、是那三类。
/// prev 为 null（刚连上、第一次取）时不算，免得把旧的当成新的
List<InboxItem> inboxAlerts(
  List<InboxItem>? prev,
  List<InboxItem> next,
  num now,
) {
  if (prev == null) return const [];
  final before = {for (final i in prev) '${i.teamId}/${i.key}': i};
  return [
    for (final i in next)
      if (alertKinds.contains(i.kind) &&
          !i.read &&
          !i.muted &&
          !i.snoozed(now) &&
          (before['${i.teamId}/${i.key}'] == null ||
              before['${i.teamId}/${i.key}']!.at < i.at))
        i,
  ];
}

/// 延后到什么时候：1 小时 / 明天早上 9 点 / 下周一早上 9 点（同电脑 teamInboxModel）
DateTime snoozeAt(String choice, DateTime now) => switch (choice) {
  'hour' => now.add(const Duration(hours: 1)),
  'tomorrow' => DateTime(now.year, now.month, now.day + 1, 9),
  _ => DateTime(now.year, now.month, now.day + (8 - now.weekday), 9),
};

/// 显示哪些：没归档（电脑只给没归档的）、没在延后；新的在前
List<InboxItem> visibleInbox(List<InboxItem> items, num now) => [
  for (final i in items)
    if (!i.snoozed(now)) i,
]..sort((a, b) => b.at.compareTo(a.at));

class TeamInbox extends ChangeNotifier {
  TeamInbox(this._connections, this.deviceId) {
    _connections.addListener(_check);
    _events = _connections.events.listen((e) {
      if (e.deviceId != deviceId || e.channel != 'channels:changed') return;
      if (objOrNull(e.data)?['kind'] == 'channels') load();
    });
    _check();
  }

  final Connections _connections;
  final String deviceId;
  late final StreamSubscription<DesktopEvent> _events;
  LinkState? _state;
  bool _disposed = false;

  /// 电脑那边有收件箱（登录了、云端开了团队、电脑版本够新）
  bool supported = false;

  /// 在手机上答过的「等你同意」：key → 同意了没有（行上不再出按钮，写结果）
  final answered = <String, bool>{};
  bool loaded = false;
  List<InboxItem> items = const [];

  int get unread => [
    for (final i in visibleInbox(items, DateTime.now().millisecondsSinceEpoch))
      if (!i.read) i,
  ].length;

  DesktopLink? get _link => _connections.link(deviceId);

  void _check() {
    final state = _connections.state(deviceId);
    if (state == _state) return;
    _state = state;
    if (state == LinkState.ready) load();
  }

  Future<void> load() async {
    final link = _link;
    if (link == null) return;
    try {
      final r = obj(await link.call('teamInbox'));
      if (_disposed) return;
      supported = r['supported'] == true;
      items = [for (final i in objList(r['items'])) InboxItem(i)];
    } catch (_) {
      // 旧电脑不认（MOBILE_UNSUPPORTED）或没连上：当没有收件箱
      if (_disposed) return;
      supported = false;
      items = const [];
    }
    loaded = true;
    notifyListeners();
  }

  /// 改一行（read / archived / muted / snoozeUntil）：先在手机上改掉，失败了再取一次
  Future<void> patch(InboxItem item, Json patch) async {
    final link = _link;
    if (link == null) throw const LinkNotReady();
    final before = items;
    items = [
      for (final i in items)
        if (i.teamId == item.teamId && i.key == item.key)
          if (patch['archived'] == true) ...[] else InboxItem({...i, ...patch})
        else
          i,
    ];
    notifyListeners();
    try {
      await link.call('teamInboxPatch', [item.teamId, item.key, patch]);
    } catch (_) {
      if (!_disposed) {
        items = before;
        notifyListeners();
      }
      rethrow;
    }
  }

  /// 「等你同意」那行：同意 / 拒绝后标已读
  Future<void> approve(InboxItem item, bool yes) async {
    final link = _link;
    if (link == null) throw const LinkNotReady();
    await link.call('teamApprove', [item.key, yes]);
    answered['${item.teamId}/${item.key}'] = yes;
    notifyListeners();
    await patch(item, {'read': true}).catchError((Object _) {});
  }

  @override
  void dispose() {
    _disposed = true;
    _connections.removeListener(_check);
    _events.cancel();
    super.dispose();
  }
}
