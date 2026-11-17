// 对话的 PR（第三批 C3，docs/mobile-app.md §15.4）：电脑的 session-status 查到的，经网关的 prs 取、
// sessionStatus:changed（{kind: 'prs', sessionId, prs}）推。让 AI 修的文字由电脑拼，合并由电脑核对是这个对话自己的 PR。
// 规则照电脑 overviewModel.ts（canMergePr）。电脑版本旧（MOBILE_UNSUPPORTED）时没有 PR 条。
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../protocol/json.dart';

/// 一项检查（packages 里的 PrCheck）
extension type PrCheck(Json json) implements Json {
  String get name => str(json['name']) ?? '';

  /// fail / pending / pass
  String get state => str(json['state']) ?? 'pending';
  String get url => str(json['url']) ?? '';
}

/// 一个 PR（apps/desktop 的 SessionPr）
extension type Pr(Json json) implements Json {
  String get url => str(json['url']) ?? '';
  int get number => (json['number'] as num?)?.toInt() ?? 0;
  String get title => str(json['title']) ?? '';

  /// open / draft / merged / closed
  String get state => str(json['state']) ?? 'open';

  /// pass / fail / pending；没有检查为 null
  String? get ci => str(json['ci']);
  int get ciFailed => (json['ciFailed'] as num?)?.toInt() ?? 0;
  bool get conflict => json['conflict'] == true;
  int get additions => (json['additions'] as num?)?.toInt() ?? 0;
  int get deletions => (json['deletions'] as num?)?.toInt() ?? 0;
  String get head => str(json['head']) ?? '';
  String get base => str(json['base']) ?? '';
  bool get unknown => json['unknown'] == true;
  List<PrCheck> get checks => [
    for (final c in objList(json['checks'])) PrCheck(c),
  ];

  bool get isOpen => state == 'open' || state == 'draft';

  /// 有冲突（只算开着的）
  bool get hasConflict => state == 'open' && conflict;

  /// 有没过的检查
  bool get failing => isOpen && ci == 'fail';

  /// 能合并：查得到状态、开着、没冲突、检查没失败也没在跑（同电脑 canMergePr）
  bool get canMerge =>
      !unknown &&
      state == 'open' &&
      !conflict &&
      ci != 'fail' &&
      ci != 'pending';

  /// 检查过了几项、一共几项；没有检查明细时 null
  ({int passed, int total})? get checkCount {
    final list = checks;
    if (list.isEmpty) return null;
    return (
      passed: list.where((c) => c.state == 'pass').length,
      total: list.length,
    );
  }

  /// 没过的在前，在跑的其次
  List<PrCheck> get sortedChecks {
    const order = {'fail': 0, 'pending': 1, 'pass': 2};
    final list = checks;
    return [...list]
      ..sort((a, b) => (order[a.state] ?? 3).compareTo(order[b.state] ?? 3));
  }
}

/// 合并确认框要的：仓库允许的合并方式、默认删不删分支
typedef PrMergeOptions = ({List<String> methods, bool deleteBranch});

/// 一个会话页的 PR：连上时取一次，之后电脑推
class SessionPrs extends ChangeNotifier {
  SessionPrs(this._connections, this.deviceId, this.sessionId) {
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

  List<Pr> prs = const [];

  DesktopLink? get _link => _connections.link(deviceId);

  void _check() {
    final state = _connections.state(deviceId);
    if (state == _state) return;
    _state = state;
    if (state == LinkState.ready) _load('prs');
  }

  Future<void> _load(String method) async {
    final link = _link;
    if (link == null) return;
    try {
      _set(await link.call(method, [sessionId]));
    } catch (_) {
      // 电脑版本旧、session-status 还没起来：没有 PR 条
    }
  }

  void _set(Object? raw) {
    if (_disposed || raw is! List) return;
    prs = [for (final p in objList(raw)) Pr(p)];
    notifyListeners();
  }

  void _onEvent(DesktopEvent e) {
    if (e.deviceId != deviceId || e.channel != 'sessionStatus:changed') return;
    final data = objOrNull(e.data);
    if (data?['kind'] != 'prs' || data?['sessionId'] != sessionId) return;
    _set(data!['prs']);
  }

  Pr? find(String url) {
    for (final p in prs) {
      if (p.url == url) return p;
    }
    return null;
  }

  Future<Object?> _call(String method, List<Object?> args) {
    final l = _link;
    if (l == null) return Future.error(const LinkNotReady());
    return l.call(method, [sessionId, ...args]);
  }

  /// 重查一次（电脑限 10 秒一次，太快了回的是上次的）
  Future<void> refresh() async => _set(await _call('prRefresh', const []));

  /// 让 AI 修：kind 为 checks（没过的检查）/ conflict（合并冲突）
  Future<void> fix(String url, String kind) =>
      _call('prFix', [url, kind]).then((_) {});

  Future<PrMergeOptions> mergeOptions(String url) async {
    final r = obj(await _call('prMergeOptions', [url]));
    return (
      methods: [
        for (final m in (r['methods'] as List? ?? const []))
          if (m is String) m,
      ],
      deleteBranch: r['deleteBranch'] == true,
    );
  }

  /// 合并（gh pr merge），回来的是合并后重查的列表
  Future<void> merge(String url, String method, bool deleteBranch) async =>
      _set(await _call('prMerge', [url, method, deleteBranch]));

  @override
  void dispose() {
    _disposed = true;
    _connections.removeListener(_check);
    _events.cancel();
    super.dispose();
  }
}
