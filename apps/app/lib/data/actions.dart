// 手机对一个会话能做的操作（照网页版各组件里的 link.call）：发送、停止、作答、队列、改设置、改名、置顶、归档、新建。
// 只管调用和把电脑回的错误代码换成人话；界面状态（忙、出错）由各组件自己管。
import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'mode.dart';
import 'queue.dart';
import 'retry.dart';
import 'sources.dart';

/// 电脑回的错误代码 → 给人看的话；别的原样
String actionError(Object e) {
  final code = '$e'.replaceFirst(RegExp(r'^Exception: '), '');
  return switch (code) {
    'MOBILE_FORBIDDEN' => L(
      '这部手机是「只看」，要在电脑上处理。',
      'This phone is set to “View only”. Handle this on the computer.',
    ),
    'MOBILE_UNSUPPORTED' => L(
      '电脑上的像素星空版本较旧，先更新电脑版。',
      'The PixelSky app on your computer is out of date. Update it first.',
    ),
    'MOBILE_BAD_ARGUMENT' => L(
      '电脑不接受这个设置。',
      "The computer didn't accept this setting.",
    ),
    'MOBILE_NOT_READY' => L('还没连上电脑。', 'Not connected to the computer yet.'),
    'SESSION_RUNNING' => L('这个会话还在运行。', 'This conversation is still running.'),
    _ when code.startsWith('RPC_TIMEOUT') => L(
      '电脑没有回应，稍后再试。',
      "The computer didn't respond. Try again later.",
    ),
    _ => queueErrorText(code),
  };
}

/// 一张待发的图片（packages/protocol 的 ImageAttachment）
typedef Attachment = Json;

/// 回退的结果（电脑网关 phoneRewind）：放回输入框的文字、手机发得出的图片，没带回的附件个数，能不能撤销
class Rewound {
  Rewound(Json r)
    : text = str(r['text']) ?? '',
      attachments = objList(r['attachments']),
      dropped = (r['dropped'] as num?)?.toInt() ?? 0,
      undoable = r['undoable'] == true;
  final String text;
  final List<Attachment> attachments;
  final int dropped;
  final bool undoable;
}

/// 旁聊的一轮问答
typedef SideTurn = ({String question, String answer});

class SessionActions {
  SessionActions(this._connections, this.deviceId, this.sessionId);
  final Connections _connections;
  final String deviceId;
  final String sessionId;

  DesktopLink? get link => _connections.link(deviceId);

  /// 这部手机能操作（连上了，而且不是「只看」）
  bool get canAct =>
      link?.state == LinkState.ready && link?.hello?.access == 'act';

  Future<Object?> _call(
    String method, [
    List<Object?> args = const [],
    Duration? timeout,
  ]) {
    final l = link;
    if (l == null) return Future.error(const LinkNotReady());
    return l.call(method, [sessionId, ...args], timeout);
  }

  // 上次没发成功的内容和它的 ID：原样重发时沿用（retry.dart）
  SendAttempt? _attempt;

  /// 发一条消息（运行中时由电脑排队）。失败抛出，内容不变再发时沿用同一个 ID
  Future<void> send(
    String text, [
    List<Attachment> attachments = const [],
  ]) async {
    final current = attemptFor(
      _attempt,
      sendKey(sessionId, text, [
        for (final a in attachments) a['id'] as String,
      ]),
      uuid,
    );
    _attempt = current;
    await _call('engine:send', [
      {
        'text': text,
        'clientMessageId': current.id,
        if (attachments.isNotEmpty) 'attachments': attachments,
      },
    ]);
    if (identical(_attempt, current)) _attempt = null;
  }

  SendAttempt? _retry;

  /// 出错后「重试」：发「继续」；同一条错误再点沿用上次的 ID
  Future<void> retry(String noticeId) async {
    final text = L('继续', 'Continue');
    final current = attemptFor(
      _retry,
      sendKey('$sessionId/$noticeId', text, const []),
      uuid,
    );
    _retry = current;
    await _call('engine:send', [
      {'text': text, 'clientMessageId': current.id},
    ]);
    if (identical(_retry, current)) _retry = null;
  }

  Future<void> interrupt() => _call('engine:interrupt');

  /// 审批 / 提问的决定：{type: allow | deny | allow_always(scope) | answer(answers)}
  Future<void> answer(String requestId, Json decision) =>
      _call('engine:answer', [requestId, decision]);

  // 队列
  Future<void> runQueuedNow(String id) => _call('engine:runQueuedNow', [id]);
  Future<void> steerQueued(String id, String turnId) =>
      _call('engine:steerQueued', [id, turnId]);
  Future<void> moveQueued(String id, Object? to) =>
      _call('engine:moveQueued', [id, to]);
  Future<void> dismissQueued(String id) => _call('engine:dismissQueued', [id]);
  Future<void> resumeQueue() => _call('engine:resumeQueue');

  /// 撤回：返回撤回的文字（放回输入框）
  Future<String?> cancelQueued(String id) async {
    final r = await _call('engine:cancelQueued', [id]);
    return r is String ? r : null;
  }

  /// 编辑重发：回退到自己的这条消息（只回退对话，电脑上的文件不动，docs/mobile-app.md §14.3），
  /// 返回要放回输入框的文字和图片
  Future<Rewound> rewind(String userItemId) async =>
      Rewound(obj(await _call('engine:rewind', [userItemId])));

  /// 撤销上一次回退（发出新消息之前）
  Future<void> undoRewind() => _call('engine:undoRewind');

  /// 旁聊（docs/mobile-app.md §15.3）：不打断正在跑的这一轮问一句，返回回答。
  /// history 是这次旁聊里之前的问答（只在手机内存里）；等 AI 回答，最多 3 分钟
  Future<String> sideQuestion(String question, List<SideTurn> history) async {
    final r = await _call('engine:sideQuestion', [
      question,
      [
        for (final t in history) {'question': t.question, 'answer': t.answer},
      ],
    ], const Duration(minutes: 3));
    return r is String ? r : '';
  }

  /// 停掉正在问的那一句
  Future<void> cancelSideQuestion() => _call('engine:cancelSideQuestion');

  /// 改设置：permissionMode / model / effort / fast / thinkingSummaries
  Future<void> update(Json patch) => _call('engine:updateSession', [patch]);
  Future<void> rename(String title) => _call('engine:renameSession', [title]);
  Future<void> pin(bool pinned) => _call('engine:setSessionPinned', [pinned]);

  /// 归档；stop 为 true 时先停止正在运行的
  Future<void> archive({bool stop = false}) =>
      _call('engine:archiveSession', [true, stop]);
}

/// 和具体会话无关的调用：模型目录、默认引擎、新建会话
class DesktopActions {
  DesktopActions(this._connections, this.deviceId);
  final Connections _connections;
  final String deviceId;

  DesktopLink? get link => _connections.link(deviceId);

  Future<Object?> _call(String method, [List<Object?> args = const []]) {
    final l = link;
    if (l == null) return Future.error(const LinkNotReady());
    return l.call(method, args);
  }

  static final _catalogs = <String, List<EngineModel>>{};

  /// 引擎的模型目录；同一台电脑、同一个引擎只取一次。旧电脑抛 MOBILE_UNSUPPORTED，别的错当作没有目录
  Future<List<EngineModel>> catalog(String engine) async {
    final key = '$deviceId/$engine';
    final cached = _catalogs[key];
    if (cached != null) return cached;
    try {
      final r = obj(await _call('engine:catalog', [engine]));
      return _catalogs[key] = [
        for (final m in objList(r['models'])) EngineModel(m),
      ];
    } catch (e) {
      if ('$e' == 'MOBILE_UNSUPPORTED') rethrow;
      return const [];
    }
  }

  /// 这个引擎在电脑上配好的额度来源（docs/mobile-app.md §14.4）；旧电脑抛 MOBILE_UNSUPPORTED
  Future<PhoneSources> sources(String engine) async =>
      PhoneSources(obj(await _call('sources', [engine])));

  /// 电脑上设的默认引擎；旧电脑、取不到为 null
  Future<String?> defaultEngine() async {
    try {
      return str(obj(await _call('defaults'))['engine']);
    } catch (_) {
      return null;
    }
  }

  /// 新建会话，返回会话 id
  Future<String> createSession(Json settings) async {
    final record = obj(await _call('engine:createSession', [settings]));
    return record['id'] as String;
  }
}
