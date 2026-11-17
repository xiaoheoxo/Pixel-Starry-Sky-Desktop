// 通知上的「允许 / 拒绝」（docs/mobile-app.md §15.7）：弹通知前看一眼那个会话在等什么，
// 点了按钮后再看一眼还在不在等（电脑上处理过的审批 engine:answer 不报错，只能先查），在就答复。
import 'dart:async';

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'actions.dart';
import 'notify.dart';
import 'session_controller.dart';
import 'session_view.dart';

/// 取一次会话快照里等着的请求；没连上时 null。会话页没开着就告诉电脑不用再推这个会话
Future<List<Json>?> peekPending(
  Connections connections,
  String device,
  String session,
) async {
  final link = connections.link(device);
  if (link == null || link.state != LinkState.ready) return null;
  try {
    final raw = await link.call('engine:openSessionTail', [session]);
    return objList(Tail.parse(raw).snapshot['pending']);
  } finally {
    if (!SessionController.isOpen(device, session)) {
      link.call('unwatch', [session]).catchError((Object _) => null);
    }
  }
}

/// 通知上要带的审批；不合适（几条在等、是提问或计划、没连上）时 null
Future<QuickApproval?> quickApprovalFor(
  Connections connections,
  String device,
  String session, {
  String sessionTitle = '',
}) async {
  try {
    final pending = await peekPending(
      connections,
      device,
      session,
    ).timeout(const Duration(seconds: 5));
    return pending == null
        ? null
        : quickApproval(pending, sessionTitle: sessionTitle);
  } catch (_) {
    return null;
  }
}

/// 等连上（切到后台被断开时刚点按钮会重连），最多等 wait
Future<bool> _ready(Connections c, String device, Duration wait) async {
  if (c.state(device) == LinkState.ready) return true;
  final done = Completer<bool>();
  void check() {
    if (c.state(device) == LinkState.ready && !done.isCompleted) {
      done.complete(true);
    }
  }

  c.addListener(check);
  final timer = Timer(wait, () {
    if (!done.isCompleted) done.complete(false);
  });
  try {
    return await done.future;
  } finally {
    timer.cancel();
    c.removeListener(check);
  }
}

/// 照通知上点的答复；返回要显示的结果（一行字）
Future<String> answerFromNotice(
  Connections connections,
  NotifyAnswer a, {
  String sessionTitle = '',
  Duration wait = const Duration(seconds: 15),
}) async {
  final t = a.target;
  final session = t.session, request = t.request;
  if (session == null || request == null) return handledText;
  if (!connections.pairings.any((p) => p.deviceId == t.device)) {
    return handledText;
  }
  if (!await _ready(connections, t.device, wait)) {
    return L('没连上电脑，点开 App 处理', 'Not connected — open the app to respond');
  }
  final actions = SessionActions(connections, t.device, session);
  if (!actions.canAct) {
    return L('这部手机是「只看」，不能处理', 'This phone is “View only”');
  }
  try {
    final pending = await peekPending(connections, t.device, session);
    if (pending == null || !pending.any((p) => p['requestId'] == request)) {
      return handledText;
    }
    await actions.answer(request, {'type': a.allow ? 'allow' : 'deny'});
  } catch (e) {
    return actionError(e);
  }
  final name = sessionTitle.isEmpty ? '' : ' · $sessionTitle';
  return a.allow ? L('已允许$name', 'Allowed$name') : L('已拒绝$name', 'Denied$name');
}

String get handledText => L('这条已经处理过了', 'This request was already handled');
