// 提醒的规则（docs/mobile-app.md §8.2）：比较前后两次会话列表算出要提醒的、合成一条的内容、点开去哪、逐个处理。
// 算法照电脑 apps/desktop/src/main/mobile/push.ts（pushChanges / pushPayload），文字照网页版 public/sw.js，
// 逐个处理照网页版 data/triage.ts。只写种类和数量，不写任务标题（锁屏上别人也看得到）。
import 'dart:convert';

import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'tasks.dart';

/// team：团队收件箱里来了「@ 你」「等你同意」「失败」（§16.2，不在 _order 里，单独算）
enum NotifyKind { waiting, failed, completed, team }

/// 几种同时有时取最要紧的
const _order = [NotifyKind.waiting, NotifyKind.failed, NotifyKind.completed];

typedef NotifySessions = Map<NotifyKind, Set<String>>;

NotifySessions emptyNotify() => {for (final k in _order) k: <String>{}};

/// 在忙：这一轮在跑，或者说完了但后台子智能体还在跑（跑完才算做完，§17）
bool _busy(SessionSummary? s) =>
    s?.state == 'running' || s?.state == 'starting' || (s?.background ?? 0) > 0;

/// 前后两次列表之间要提醒的会话；prev 为 null（刚连上）时不算，免得把旧状态当成新消息。
/// 「等你处理」要上一份里有这个会话（远程机器连上时它的会话整批出现，已经在等的不算新的）
NotifySessions notifyChanges(
  List<SessionSummary>? prev,
  List<SessionSummary> next,
) {
  final out = emptyNotify();
  if (prev == null) return out;
  final before = {for (final s in prev) s.id: s};
  for (final s in next) {
    if (s.archived) continue;
    final old = before[s.id];
    if (s.state == 'waiting' && old != null && old.state != 'waiting') {
      out[NotifyKind.waiting]!.add(s.id);
    } else if (_busy(old) && !_busy(s) && s.state == 'idle') {
      if (s.lastOutcome == 'failed') out[NotifyKind.failed]!.add(s.id);
      if (s.lastOutcome == 'completed') out[NotifyKind.completed]!.add(s.id);
    }
  }
  return out;
}

/// 把 add 并进 into（攒着的那份）
void mergeNotify(NotifySessions into, NotifySessions add) {
  for (final k in _order) {
    into[k]!.addAll(add[k]!);
  }
}

/// 一条提醒：最要紧的那种、涉及几个会话、只涉及一个时是哪个
class NotifyPayload {
  const NotifyPayload(this.kind, this.count, this.session, {this.approval});
  final NotifyKind kind;
  final int count;
  final String? session;

  /// 只有一个会话在等、等的是普通权限审批时：通知上直接「允许 / 拒绝」（§15.7）
  final QuickApproval? approval;

  NotifyPayload withApproval(QuickApproval? a) =>
      NotifyPayload(kind, count, session, approval: a);
}

/// 通知上能直接处理的审批：哪一条、做什么（标题、命令）、哪个会话
class QuickApproval {
  const QuickApproval({
    required this.requestId,
    required this.title,
    this.command,
    this.sessionTitle = '',
  });
  final String requestId;
  final String title;
  final String? command;
  final String sessionTitle;

  /// 通知正文：「运行命令 · npm test」（锁屏上不显示，见 LocalNotifier）
  String get text {
    final cmd = command == null ? null : jsTrim(command!).split('\n').first;
    final line = cmd == null || cmd.isEmpty ? title : '$title · $cmd';
    return line.length > 200 ? '${line.substring(0, 200)}…' : line;
  }
}

/// 会话里等着的请求能不能在通知上直接处理：只有一条、是普通的权限审批（命令、改文件、工具），
/// 能允许也能拒绝、不用填表。提问、计划、要填表的点开 App 处理（§15.7）
QuickApproval? quickApproval(List<Json> pending, {String sessionTitle = ''}) {
  if (pending.length != 1) return null;
  final p = pending.single;
  final id = str(p['requestId']);
  final kind = str(p['kind']) ?? 'tool';
  if (id == null || !NotifyTarget.validId(id)) return null;
  if (kind != 'command' && kind != 'file_change' && kind != 'tool') return null;
  if (p['canAllow'] == false || p['canDeny'] == false) return null;
  if (p.containsKey('formSchema')) return null;
  return QuickApproval(
    requestId: id,
    title: str(p['title']) ?? '',
    command: str(p['command']),
    sessionTitle: sessionTitle,
  );
}

NotifyPayload? notifyPayload(NotifySessions sessions) {
  for (final k in _order) {
    final ids = sessions[k]!;
    if (ids.isEmpty) continue;
    return NotifyPayload(
      k,
      ids.length > 99 ? 99 : ids.length,
      ids.length == 1 ? ids.first : null,
    );
  }
  return null;
}

/// 通知里的字（同网页版 sw.js）
String notifyText(NotifyKind kind, int n) => switch (kind) {
  NotifyKind.waiting => L(
    '有 $n 个任务等你处理',
    n == 1 ? '1 task needs your attention' : '$n tasks need your attention',
  ),
  NotifyKind.failed => L(
    '$n 个任务出错了',
    n == 1 ? '1 task failed' : '$n tasks failed',
  ),
  NotifyKind.completed => L(
    '$n 个任务完成',
    n == 1 ? '1 task finished' : '$n tasks finished',
  ),
  NotifyKind.team => L(
    '团队里有 $n 件事找你',
    n == 1 ? '1 team update needs you' : '$n team updates need you',
  ),
};

/// 点通知去哪：哪台电脑、哪个会话（涉及多个时没有）、是不是「等你处理」
class NotifyTarget {
  const NotifyTarget({
    required this.device,
    this.session,
    this.waiting = false,
    this.request,
    this.inbox = false,
  });
  final String device;
  final String? session;
  final bool waiting;

  /// 团队收件箱的提醒（§16.2）：点了打开收件箱
  final bool inbox;

  /// 通知上带「允许 / 拒绝」时：那条审批的 id
  final String? request;

  String encode() => jsonEncode({
    'device': device,
    'session': ?session,
    'waiting': waiting,
    'request': ?request,
    if (inbox) 'inbox': true,
  });

  static final _id = RegExp(r'^[A-Za-z0-9_.:~-]{1,128}$');
  static bool validId(String id) => _id.hasMatch(id);

  /// 解析通知里带的；不对的返回 null
  static NotifyTarget? decode(String? raw) {
    if (raw == null) return null;
    Object? v;
    try {
      v = jsonDecode(raw);
    } on FormatException {
      return null;
    }
    if (v is! Map) return null;
    final device = v['device'];
    if (device is! String || !_id.hasMatch(device)) return null;
    final session = v['session'];
    final request = v['request'];
    return NotifyTarget(
      device: device,
      session: session is String && _id.hasMatch(session) ? session : null,
      waiting: v['waiting'] == true,
      request: request is String && _id.hasMatch(request) ? request : null,
      inbox: v['inbox'] == true,
    );
  }
}

/// 在通知上点了「允许」或「拒绝」
typedef NotifyAnswer = ({NotifyTarget target, bool allow});

/// 通知按钮的 id
const notifyAllow = 'allow';
const notifyDeny = 'deny';

// ---------------------------------------------------------------------------
// 逐个处理（网页版 data/triage.ts）
// ---------------------------------------------------------------------------

/// 现在等你处理的会话（不含归档），新的在前
List<String> waitingIds(List<SessionSummary> sessions) {
  final list = [
    for (final s in sessions)
      if (s.state == 'waiting' && !s.archived) s,
  ]..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return [for (final s in list) s.id];
}

/// 打开时记下的这一批
class Triage {
  const Triage(this.ids);
  final List<String> ids;

  /// 现在等你处理的会话；没有时 null（都在电脑上处理过了）
  static Triage? start(List<SessionSummary> sessions) {
    final ids = waitingIds(sessions);
    return ids.isEmpty ? null : Triage(ids);
  }

  /// current 之后还在等你的下一个；没有了是 null。电脑上已经处理掉、归档了的跳过
  String? next(String current, List<SessionSummary> sessions) {
    final waiting = waitingIds(sessions).toSet();
    final from = ids.indexOf(current);
    for (final id in ids.skip(from + 1)) {
      if (waiting.contains(id)) return id;
    }
    return null;
  }

  /// 「等你处理 2 / 3」：第几个（从 1 数）和一共几个；不在这一批里是 null
  ({int index, int total})? position(String current) {
    final i = ids.indexOf(current);
    return i < 0 ? null : (index: i + 1, total: ids.length);
  }
}
