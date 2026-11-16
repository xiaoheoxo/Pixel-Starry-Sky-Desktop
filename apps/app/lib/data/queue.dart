// 消息队列：哪些显示在对话末尾、每条写什么、能做什么。规则照网页版 apps/mobile/src/data/queue.ts（同桌面 queueView.ts，
// docs/ui/message-queue.md）；测试用例照 queue.test.ts。
import '../i18n/i18n.dart';
import '../protocol/errors.dart';
import '../protocol/json.dart';

/// 排队的消息（packages/protocol/src/types/session.ts 的 QueuedMessage）
extension type Queued(Json json) implements Json {
  String get id => json['id'] as String;
  String get text => str(json['text']) ?? '';
  String get status => str(json['status']) ?? 'queued';
  String? get error => str(json['error']);
  bool get direct => json['direct'] == true;
  bool get held => json['held'] == true;
  String? get messageUuid => str(json['messageUuid']);
  Json? get reconnect => objOrNull(json['reconnect']);
  Json? get limit => objOrNull(json['limit']);
  int get attachments => (json['attachments'] as List?)?.length ?? 0;
  int get reconnected => (json['reconnected'] as num?)?.toInt() ?? 0;
}

List<Queued> queueOf(Json snapshot) => [
  for (final q in objList(snapshot['queue'])) Queued(q),
];

/// 空闲时直接发送、正在启动的消息：显示成对话里的「正在启动」，不算排队
bool isStarting(Queued q, bool paused) =>
    q.direct &&
    !q.held &&
    !paused &&
    q.reconnect == null &&
    (q.status == 'queued' || q.status == 'dispatching');

/// 断线后电脑正在自动重连的那条（单独暂停的按普通暂停项）
bool isReconnecting(Queued q) =>
    q.reconnect != null &&
    !q.held &&
    (q.status == 'queued' || q.status == 'dispatching');

/// 额度用完 / 限流后在等到点自动继续
bool isLimitWait(Queued q) =>
    isReconnecting(q) && q.reconnect!['limited'] == true;

bool _limitStopped(Queued q) =>
    ((q.limit?['tries'] as List?)?.length ?? 0) >=
    ((q.reconnect?['max'] as num?) ?? 3);

/// 限流等待那条的第二行
String limitNote(Queued q, bool paused) {
  if (paused || _limitStopped(q)) {
    return L('不会自己继续，可以现在试一次', "Won't continue on its own; you can try now");
  }
  return q.limit?['kind'] == 'rate'
      ? L('请求太频繁，到点自动继续', 'Too many requests; continues automatically')
      : L('额度用完，到点自动继续', 'Usage limit reached; continues automatically');
}

/// 失败的这条已经在对话里：可以「关掉」
bool canDismiss(Queued q) =>
    (q.status == 'failed' || q.status == 'uncertain') && q.messageUuid != null;

/// 直接发送却没能开始的
bool isSendFailure(Queued q) => q.direct && q.status == 'failed';

/// 要显示成排队的消息（正在执行的、正在启动的在对话里）
List<Queued> queueItems(Json snapshot) {
  final paused = snapshot['queuePaused'] == true;
  return [
    for (final q in queueOf(snapshot))
      if (q.status != 'running' && !isStarting(q, paused)) q,
  ];
}

/// 已经在交付，不能撤回 / 插队
bool isPending(Queued q) =>
    q.status == 'dispatching' || q.status == 'delivering';

String _hm(num at) {
  final d = DateTime.fromMillisecondsSinceEpoch(at.toInt());
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(d.hour)}:${two(d.minute)}';
}

/// 每条的状态文字；paused 是整个队列暂停
String queueLabel(Queued q, [bool paused = false]) {
  if (isLimitWait(q)) {
    if (_limitStopped(q)) return L('自动继续已停止', 'Auto-continue stopped');
    if (paused) return L('等待已暂停', 'Waiting paused');
    final what = q.limit?['kind'] == 'rate'
        ? L('等限流结束', 'Waiting for rate limit')
        : L('等额度恢复', 'Waiting for usage limit');
    final at = q.limit?['resetsAt'];
    return at is num ? '$what（${_hm(at)}）' : what;
  }
  if (isReconnecting(q)) {
    final r = q.reconnect!;
    return '${paused ? L('重连已暂停', 'Reconnect paused') : L('正在重连', 'Reconnecting')} ${r['attempt']}/${r['max']}';
  }
  if (isSendFailure(q)) return L('发送失败', 'Failed to send');
  if (q.status == 'failed') return L('执行失败', 'Failed');
  if (q.status == 'uncertain') return L('待核对', 'Needs checking');
  if (q.status == 'delivering') return L('等待接收', 'Waiting to be received');
  if (q.status == 'dispatching') return L('正在启动', 'Starting');
  if (q.held) return L('已暂停', 'Paused');
  return L('排队中', 'Queued');
}

/// 一组排队消息的标题
String queueTitle(List<Queued> items, bool paused) {
  if (items.isNotEmpty && items.every(isSendFailure)) {
    return L('发送失败', 'Failed to send');
  }
  return paused || items.any((q) => q.held)
      ? L('队列已暂停', 'Queue paused')
      : L('排队中', 'Queued');
}

/// 能不能「插话」（引导）：排队中、引擎支持、正在跑一轮
bool canSteer(Queued q, Json snapshot) =>
    q.status == 'queued' &&
    obj(snapshot['flags'])['steerAvailable'] == true &&
    snapshot['state'] == 'running' &&
    truthy(snapshot['turnId']);

/// 调序目标 { before: 消息 id | null }；挪不了返回 null（用 [noMove] 区分「排到最后」）
const noMove = Object();

/// 上移 / 下移：按邻居的 id 算（同网页版 queueMoveTarget）。挪不了返回 [noMove]
Object? queueMoveTarget(List<Queued> items, String id, int dir) {
  final list = [
    for (final q in items)
      if (q.id == id || !isReconnecting(q)) q,
  ];
  final at = list.indexWhere((q) => q.id == id);
  if (at < 0 || list[at].status != 'queued') return noMove;
  if (dir < 0) {
    if (at == 0) return noMove;
    final prev = list[at - 1];
    return prev.status != 'running' && !isPending(prev)
        ? {'before': prev.id}
        : noMove;
  }
  if (at + 1 >= list.length) return noMove;
  return {'before': at + 2 < list.length ? list[at + 2].id : null};
}

/// 发给电脑的调序参数：新电脑发 { before }，旧电脑发整个队列里的下标 ±1。挪不了返回 [noMove]
Object? queueMoveArg(
  List<Queued> queue,
  List<Queued> items,
  String id,
  int dir,
  bool supportsBefore,
) {
  if (supportsBefore) return queueMoveTarget(items, id, dir);
  final index = queue.indexWhere((q) => q.id == id);
  if (index < 0 || queue[index].status != 'queued') return noMove;
  if (dir < 0) return index <= 0 ? noMove : index - 1;
  return index >= queue.length - 1 ? noMove : index + 1;
}

/// 操作失败的话：「队列已变化」换成中文，别的原样
String queueErrorText(String message) => replaceCodedErrors(
  message,
  (info) => info.code == 'queue.changed'
      ? L('队列已变化，排序未保存', 'The queue changed; new order not saved')
      : message,
);
