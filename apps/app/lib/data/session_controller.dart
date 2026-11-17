// 打开一个会话（照网页版 data/hooks.ts 的 useSession）：连上（或重连）时取尾部快照，
// 之后按 seq 应用电脑推来的事件；seq 接不上就重新取。关掉时告诉电脑不用再推（unwatch）。
import 'dart:async';

import 'package:flutter/foundation.dart';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../protocol/json.dart';
import 'session_view.dart';

class SessionController extends ChangeNotifier {
  SessionController(this._connections, this.deviceId, this.sessionId) {
    _opened.update(_key, (n) => n + 1, ifAbsent: () => 1);
    _connections.addListener(_check);
    _events = _connections.events.listen(_onEvent);
    _check();
  }

  final Connections _connections;
  final String deviceId;
  final String sessionId;

  /// 手机上开着的会话页（同一个会话可能开了两层）：别处临时取快照后，开着的不能 unwatch
  static final _opened = <String, int>{};
  String get _key => '$deviceId/$sessionId';
  static bool isOpen(String deviceId, String sessionId) =>
      _opened.containsKey('$deviceId/$sessionId');
  late final StreamSubscription<DesktopEvent> _events;

  SessionView view = const SessionView();
  String? error;
  bool loadingOlder = false;
  LinkState? _state;

  /// 每次重新打开加一：旧的请求回来时丢掉
  int _generation = 0;

  DesktopLink? get _link => _connections.link(deviceId);

  void _check() {
    final state = _connections.state(deviceId);
    if (state == _state) return;
    _state = state;
    if (state == LinkState.ready) _open();
  }

  void _open() {
    final link = _link;
    if (link == null) return;
    final gen = ++_generation;
    error = null;
    // 已经有快照时清掉缓冲（重新取的快照会补上）；还没有时留着先到的事件
    view = SessionView(buffer: view.snapshot != null ? const [] : view.buffer);
    notifyListeners();
    link
        .call('engine:openSessionTail', [sessionId])
        .then(
          (raw) {
            if (gen != _generation) return;
            view = applyTail(view, Tail.parse(raw));
            notifyListeners();
          },
          onError: (Object e) {
            if (gen != _generation) return;
            error = '$e';
            notifyListeners();
          },
        );
  }

  void _onEvent(DesktopEvent e) {
    if (e.deviceId != deviceId || e.channel != 'engine:event') return;
    final data = e.data;
    if (data is! Map ||
        data['kind'] != 'session' ||
        data['sessionId'] != sessionId) {
      return;
    }
    final seq = (data['seq'] as num?)?.toInt();
    if (seq == null) return;
    view = applyEvent(view, seq, obj(data['event']));
    notifyListeners();
    // seq 接不上：重新取
    if (view.stale) _open();
  }

  /// 向上翻页
  Future<void> loadOlder() async {
    final link = _link;
    final before = view.before;
    if (link == null || before == null || loadingOlder) return;
    loadingOlder = true;
    notifyListeners();
    try {
      final raw = await link.call('engine:openSessionTail', [
        sessionId,
        {'before': before},
      ]);
      view = prependOlder(view, Tail.parse(raw));
    } catch (e) {
      error = '$e';
    } finally {
      loadingOlder = false;
      notifyListeners();
    }
  }

  /// 「查看完整」：取一条完整的内容
  Future<void> detail(String itemId) async {
    final raw = await _link?.call('engine:itemDetail', [sessionId, itemId]);
    final m = objOrNull(raw);
    if (m == null) return;
    view = replaceItem(view, Item(obj(m['item'])), m['truncated'] == true);
    notifyListeners();
  }

  @override
  void dispose() {
    final n = (_opened[_key] ?? 1) - 1;
    n <= 0 ? _opened.remove(_key) : _opened[_key] = n;
    _connections.removeListener(_check);
    _events.cancel();
    _link?.call('unwatch', [sessionId]).catchError((Object _) => null);
    super.dispose();
  }
}
