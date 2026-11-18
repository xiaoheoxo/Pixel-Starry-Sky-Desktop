// 手机看频道（第三批 C5，docs/mobile-app.md §15.6，只读）：网关的 channels（列表、成员）、channelMessages（时间线分页）、
// channelImage（一张图）；电脑推 channels:changed（{kind: 'channels'}，重取列表）和 channels:message
// （{kind: 'channelMessage', channelId, message}，开着的那个频道的新消息、任务卡状态变化，按 id 替换）。
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';

/// 频道成员（人或 AI）
extension type ChannelMember(Json json) implements Json {
  String get id => str(json['id']) ?? '';
  String get name => str(json['name']) ?? '';
  bool get agent => json['kind'] == 'agent';
  bool get you => json['you'] == true;
  String? get engine => str(json['engine']);

  /// 头像底色（#RRGGBB）；没有时按引擎 / 名字配
  String? get color => str(json['color']);

  /// 头像上的字；没有时取名字第一个字
  String get initial {
    final t = str(json['text']);
    if (t != null && t.isNotEmpty) return t;
    final n = name.trim();
    return n.isEmpty ? '?' : String.fromCharCode(n.runes.first);
  }
}

/// 列表上的一个频道
extension type ChannelSummary(Json json) implements Json {
  String get id => str(json['id']) ?? '';
  String get name => str(json['name']) ?? '';
  int get unread => (json['unread'] as num?)?.toInt() ?? 0;
  bool get mentioned => json['mentioned'] == true;
  bool get archived => json['archived'] == true;
  num get lastAt => (json['lastAt'] as num?) ?? 0;
  List<String> get memberIds => [
    for (final m in (json['memberIds'] as List? ?? const []))
      if (m is String) m,
  ];

  /// local（本机 AI 协作）/ team（团队频道，§16.2）；旧电脑不给，当本机
  bool get team => json['scope'] == 'team';
  String? get teamId => str(json['teamId']);
  String? get lastAuthor => str(obj(json['last'])['authorId']);
  String? get lastText => str(obj(json['last'])['text']);
}

/// 时间线上的一条：message（消息）/ task（任务卡）/ event（谁加入了之类）
extension type ChannelEntry(Json json) implements Json {
  String get id => str(json['id']) ?? '';
  String get kind => str(json['kind']) ?? 'message';
  num get at => (json['at'] as num?) ?? 0;
  String get authorId => str(json['authorId']) ?? '';
  String get text => str(json['text']) ?? '';
  bool get markdown => json['format'] == 'markdown';
  int get images => (json['images'] as num?)?.toInt() ?? 0;
  List<String> get files => [
    for (final f in (json['files'] as List? ?? const []))
      if (f is String) f,
  ];
  // 任务卡
  String get assigneeId => str(json['assigneeId']) ?? '';
  String get title => str(json['title']) ?? '';

  /// queued / approval / running / waiting / done / failed / stopped
  String get status => str(json['status']) ?? 'queued';
  String? get sessionId => str(json['sessionId']);
  String? get summary => str(json['summary']);
  String? get error => str(json['error']);

  /// 团队卡（§16.2）：失败原因代码、跑过几次、等同意时我能不能点
  String? get reason => str(json['reason']);
  int get runs => (json['runs'] as num?)?.toInt() ?? 0;
  bool get canApprove => json['canApprove'] == true;
  ({int added, int removed})? get diff {
    final d = objOrNull(json['diff']);
    if (d == null) return null;
    return (
      added: (d['added'] as num?)?.toInt() ?? 0,
      removed: (d['removed'] as num?)?.toInt() ?? 0,
    );
  }

  // 事件
  String get event => str(json['event']) ?? '';
  String get actorId => str(json['actorId']) ?? '';
  String? get targetId => str(json['targetId']);
  String? get value => str(json['value']);
}

/// 失败原因代码 → 一句话（同电脑 run.reason.*；认不出的不写，留错误原文）
String? reasonText(String? reason) => switch (reason) {
  'machine_offline' => L('主人的电脑离线', "The owner's computer is offline"),
  'queue_expired' => L('排队太久，已过期', 'Waited too long in the queue'),
  'session_gone' => L('会话没了', 'The conversation is gone'),
  'not_deployed' => L('云端还没开这个功能', 'Not available on the cloud yet'),
  'not_allowed' => L('主人改了派活规则', 'The owner changed who can assign'),
  'requester_left' => L('派活的人已离开团队', 'The requester left the team'),
  'project_blocked' => L('这个项目不接队友的活', 'This project is closed to teammates'),
  'engine.auth' => L('引擎没登录', 'The engine is signed out'),
  'engine.quota' => L('额度用完了', 'Out of quota'),
  'engine.model' => L('模型用不了', 'The model is unavailable'),
  'engine.busy' => L('引擎太忙', 'The engine is busy'),
  'engine.context' => L('上下文太长', 'The context is too long'),
  _ => null,
};

/// 频道分组（§16.2）：本机频道一组，每个团队一组（团队名从电脑给的 teams 里取）
List<({String? teamId, String title, List<ChannelSummary> channels})>
channelGroups(List<ChannelSummary> list, Map<String, String> teams) {
  final local = [
    for (final c in list)
      if (!c.team) c,
  ];
  final byTeam = <String, List<ChannelSummary>>{};
  for (final c in list) {
    if (c.team) (byTeam[c.teamId ?? ''] ??= []).add(c);
  }
  return [
    if (local.isNotEmpty)
      (teamId: null, title: L('本机频道', 'On this computer'), channels: local),
    for (final e in byTeam.entries)
      (
        teamId: e.key,
        title: teams[e.key] ?? L('团队', 'Team'),
        channels: e.value,
      ),
  ];
}

/// 频道列表：没归档的按最后一条时间排，归档的放后面
List<ChannelSummary> sortChannels(List<ChannelSummary> list) =>
    [...list]..sort((a, b) {
      if (a.archived != b.archived) return a.archived ? 1 : -1;
      return b.lastAt.compareTo(a.lastAt);
    });

/// 新到的一条并进时间线：同 id 的原地换掉（任务卡状态变了），新的按时间插进去
List<ChannelEntry> mergeEntry(List<ChannelEntry> list, ChannelEntry e) {
  final i = list.indexWhere((x) => x.id == e.id);
  if (i >= 0) return [...list]..[i] = e;
  final out = [...list, e];
  if (list.isNotEmpty && e.at < list.last.at) {
    out.sort((a, b) => a.at.compareTo(b.at));
  }
  return out;
}

/// 一台电脑的频道列表和成员；连上时取，电脑说变了就重取
class ChannelList extends ChangeNotifier {
  ChannelList(this._connections, this.deviceId) {
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

  List<ChannelSummary> channels = const [];
  final members = <String, ChannelMember>{};

  /// 团队 id → 名字
  final teams = <String, String>{};
  bool loaded = false;
  String? error;

  void _check() {
    final state = _connections.state(deviceId);
    if (state == _state) return;
    _state = state;
    if (state == LinkState.ready) load();
  }

  Future<void> load() async {
    final link = _connections.link(deviceId);
    if (link == null) return;
    try {
      final r = obj(await link.call('channels'));
      if (_disposed) return;
      channels = sortChannels([
        for (final c in objList(r['channels'])) ChannelSummary(c),
      ]);
      members
        ..clear()
        ..addEntries([
          for (final m in objList(r['members']))
            MapEntry(str(m['id']) ?? '', ChannelMember(m)),
        ]);
      teams
        ..clear()
        ..addEntries([
          for (final t in objList(r['teams']))
            MapEntry(str(t['id']) ?? '', str(t['name']) ?? ''),
        ]);
      error = null;
    } catch (e) {
      if (_disposed) return;
      error = '$e';
    }
    loaded = true;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _connections.removeListener(_check);
    _events.cancel();
    super.dispose();
  }
}

/// 一个频道的时间线：最近一页，往上翻取更早的；开着时电脑推新的
class ChannelTimeline extends ChangeNotifier {
  ChannelTimeline(this._connections, this.deviceId, this.channelId) {
    _connections.addListener(_check);
    _events = _connections.events.listen(_onEvent);
    _check();
  }

  final Connections _connections;
  final String deviceId;
  final String channelId;
  late final StreamSubscription<DesktopEvent> _events;
  LinkState? _state;
  bool _disposed = false;

  List<ChannelEntry> entries = const [];
  bool more = false;
  bool loaded = false;
  bool loadingOlder = false;
  String? error;

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
      final r = obj(await link.call('channelMessages', [channelId]));
      if (_disposed) return;
      entries = [for (final m in objList(r['messages'])) ChannelEntry(m)];
      more = r['more'] == true;
      error = null;
    } catch (e) {
      if (_disposed) return;
      error = '$e';
    }
    loaded = true;
    notifyListeners();
  }

  Future<void> loadOlder() async {
    final link = _link;
    if (link == null || !more || loadingOlder || entries.isEmpty) return;
    loadingOlder = true;
    notifyListeners();
    try {
      final first = entries.first;
      final r = obj(
        await link.call('channelMessages', [channelId, first.at, first.id]),
      );
      if (_disposed) return;
      final known = {for (final e in entries) e.id};
      entries = [
        for (final m in objList(r['messages']))
          if (!known.contains(str(m['id']))) ChannelEntry(m),
        ...entries,
      ];
      more = r['more'] == true;
    } catch (_) {
      // 下次再翻
    } finally {
      loadingOlder = false;
      if (!_disposed) notifyListeners();
    }
  }

  void _onEvent(DesktopEvent e) {
    if (e.deviceId != deviceId || e.channel != 'channels:message') return;
    final data = objOrNull(e.data);
    if (data?['kind'] != 'channelMessage' || data?['channelId'] != channelId) {
      return;
    }
    final m = objOrNull(data!['message']);
    if (m == null) return;
    entries = mergeEntry(entries, ChannelEntry(m));
    notifyListeners();
  }

  /// 同意 / 拒绝队友派的活（§16.2）：电脑转给云端，云端再核对一次还在不在等；成功后重取这一页
  Future<void> approve(String taskId, bool yes) async {
    final l = _link;
    if (l == null) throw const LinkNotReady();
    await l.call('teamApprove', [taskId, yes]);
    if (!_disposed) await _load();
  }

  /// 一条消息里的第 index 张图（放不进一帧时电脑缩小了）
  Future<Json> image(String messageId, int index) async {
    final l = _link;
    if (l == null) throw const LinkNotReady();
    return obj(await l.call('channelImage', [channelId, messageId, index]));
  }

  @override
  void dispose() {
    _disposed = true;
    _connections.removeListener(_check);
    _events.cancel();
    _link?.call('channelUnwatch', [channelId]).catchError((Object _) => null);
    super.dispose();
  }
}
