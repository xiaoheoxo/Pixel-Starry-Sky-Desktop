// 反馈（docs/mobile-app.md §8.5，照电脑 设置 › 反馈，docs/ui/feedback.md）：经电脑网关转给电脑的反馈模块，
// 账号令牌不离开电脑。这里是数据：类型、状态文字、正文拼接、限额、未读数。
import 'dart:async';

import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'tools.dart';

/// 和电脑 FEEDBACK_LIMITS 一样
abstract final class FeedbackLimits {
  static const titleChars = 100;
  static const bodyChars = 10000;
  static const images = 5;
}

/// 电脑最近日志默认取多久
const feedbackLogWindow = Duration(hours: 2);

// ---------------------------------------------------------------------------
// 数据（电脑 shared/types/feedback.ts）
// ---------------------------------------------------------------------------

extension type FeedbackSummary(Json json) implements Json {
  String get id => str(json['id']) ?? '';

  /// bug / feature / other
  String get type => str(json['type']) ?? 'other';
  String get title => str(json['title']) ?? '';

  /// open / replied / closed
  String get status => str(json['status']) ?? 'open';
  num get updatedAt => (json['updatedAt'] as num?) ?? 0;
  bool get unread => json['unread'] == true;
  String get preview => str(json['preview']) ?? '';

  /// user / team
  String get previewAuthor => str(json['previewAuthor']) ?? 'user';
  bool get teamSeen => json['teamSeen'] == true;
  bool get working => json['working'] == true;
}

extension type FeedbackAttachmentMeta(Json json) implements Json {
  int get id => (json['id'] as num?)?.toInt() ?? 0;

  /// log / image
  String get kind => str(json['kind']) ?? 'log';
  String get name => str(json['name']) ?? '';
  int get rawSize => (json['rawSize'] as num?)?.toInt() ?? 0;
  bool get available => json['available'] != false;
}

extension type FeedbackMessage(Json json) implements Json {
  int get id => (json['id'] as num?)?.toInt() ?? 0;

  /// user / team
  String get author => str(json['author']) ?? 'user';

  /// message / closed / reopened
  String get kind => str(json['kind']) ?? 'message';
  String get body => str(json['body']) ?? '';
  num get createdAt => (json['createdAt'] as num?) ?? 0;
  bool get hasDiagnostics => json['diagnostics'] is Map;
  List<FeedbackAttachmentMeta> get attachments => [
    for (final a in objList(json['attachments'])) FeedbackAttachmentMeta(a),
  ];
}

// ---------------------------------------------------------------------------
// 文字
// ---------------------------------------------------------------------------

String feedbackTypeText(String type) => switch (type) {
  'bug' => L('问题', 'Problem'),
  'feature' => L('建议', 'Suggestion'),
  _ => L('其他', 'Other'),
};

/// 描述框的提示随类型变
String feedbackBodyHint(String type) => switch (type) {
  'bug' => L('发生了什么？你期望的是什么？', 'What happened? What did you expect?'),
  'feature' => L(
    '想要什么功能？是在什么情况下需要它？',
    'What would you like to see, and when would you need it?',
  ),
  _ => L('想对我们说点什么？', 'What would you like to tell us?'),
};

enum FeedbackStatusKind { closed, replied, working, seen, waiting }

/// 状态（列表和详情一致，同电脑 statusKind）：已关闭 / 已回复 / 团队处理中 / 团队已看到 / 等待回复
FeedbackStatusKind feedbackStatusKind(FeedbackSummary t) {
  if (t.status == 'closed') return FeedbackStatusKind.closed;
  if (t.status == 'replied') return FeedbackStatusKind.replied;
  if (t.working) return FeedbackStatusKind.working;
  if (t.teamSeen) return FeedbackStatusKind.seen;
  return FeedbackStatusKind.waiting;
}

String feedbackStatusText(FeedbackStatusKind k) => switch (k) {
  FeedbackStatusKind.closed => L('已关闭', 'Closed'),
  FeedbackStatusKind.replied => L('已回复', 'Replied'),
  FeedbackStatusKind.working => L('团队处理中', 'Team is on it'),
  FeedbackStatusKind.seen => L('团队已看到', 'Team has seen it'),
  FeedbackStatusKind.waiting => L('等待回复', 'Waiting for reply'),
};

/// 电脑上反馈出错的原因 → 给人看的话（没登录、云端没开放单独说）
String feedbackError(Object e) {
  final text = toolError(e);
  if (text.contains('请先登录')) {
    return L(
      '电脑上还没有登录像素星空账号，登录后才能反馈。',
      'Sign in to PixelSky on your computer to send feedback.',
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// 正文
// ---------------------------------------------------------------------------

/// 手机信息一行：「像素星空 App 1.0.0 · Android 16 · Google Pixel 9」
String phoneInfoLine(String appVersion, String os, String model) => [
  '${L('像素星空 App', 'PixelSky app')} $appVersion',
  if (os.isNotEmpty) os,
  if (model.isNotEmpty) model,
].join(' · ');

/// 发出去的正文：描述 + 复现步骤（仅问题，填了才有）+ 手机信息小节（云端只认电脑的诊断格式，手机的拼在正文里）
String composeFeedbackBody({
  required String body,
  String steps = '',
  required String phone,
  String phoneLog = '',
}) {
  final parts = [
    body.trim(),
    if (steps.trim().isNotEmpty)
      '## ${L('复现步骤', 'Steps to reproduce')}\n${steps.trim()}',
    '## ${L('手机', 'Phone')}\n$phone\n${L('（从手机 App 提交）', '(Sent from the phone app)')}',
    // 手机日志（§19）：放最后，限额不够时只留最新的几行
    if (phoneLog.isNotEmpty)
      '## ${L('手机日志（最近 2 小时）', 'Phone log (last 2 hours)')}\n```\n$phoneLog\n```',
  ];
  return parts.join('\n\n');
}

/// 提交前查限额；没问题返回 null
String? feedbackLimitError({
  required String title,
  required String body,
  required int images,
}) {
  if (title.trim().isEmpty) return L('请填写标题', 'Enter a title');
  if (title.trim().length > FeedbackLimits.titleChars) {
    return L(
      '标题最多 ${FeedbackLimits.titleChars} 字',
      'The title can be at most ${FeedbackLimits.titleChars} characters',
    );
  }
  return replyLimitError(body: body, images: images);
}

/// 补充只查正文和图片
String? replyLimitError({required String body, required int images}) {
  if (body.trim().isEmpty) return L('请填写描述', 'Enter a description');
  if (body.length > FeedbackLimits.bodyChars) {
    return L(
      '描述（含复现步骤和手机信息）最多 ${FeedbackLimits.bodyChars} 字',
      'The description (including steps and phone info) can be at most ${FeedbackLimits.bodyChars} characters',
    );
  }
  if (images > FeedbackLimits.images) {
    return L(
      '最多 ${FeedbackLimits.images} 张截图',
      'At most ${FeedbackLimits.images} screenshots',
    );
  }
  return null;
}

/// 手机上压好的图（data/images.dart）→ 电脑要的 { name, mediaType, data }
List<Json> feedbackImages(List<Json> images) => [
  for (final i in images)
    {
      'name': str(i['name']) ?? 'image.jpg',
      'mediaType': str(i['mediaType']) ?? 'image/jpeg',
      'data': str(i['dataBase64']) ?? '',
    },
];

// ---------------------------------------------------------------------------
// 未读数（抽屉、设置的红点）
// ---------------------------------------------------------------------------

/// 每台电脑的反馈未读数：连上时问一次 feedback:state，之后电脑推 feedback:changed（{kind: 'feedback', unread}）就更新。
/// 电脑不支持（旧版本）、没登录时为 0；version 每次电脑说变了就加一，开着的反馈页据此重取
class FeedbackUnread extends ChangeNotifier {
  FeedbackUnread(this._connections) {
    _connections.addListener(_onLinks);
    _events = _connections.events.listen((e) {
      final data = objOrNull(e.data);
      if (e.channel != 'feedback:changed' || data?['kind'] != 'feedback') {
        return;
      }
      final n = data!['unread'];
      _unread[e.deviceId] = n is num ? n.toInt() : 0;
      _versions[e.deviceId] = version(e.deviceId) + 1;
      notifyListeners();
    });
    _onLinks();
  }

  final Connections _connections;
  late final StreamSubscription<DesktopEvent> _events;
  final _unread = <String, int>{};
  final _versions = <String, int>{};
  final _states = <String, LinkState?>{};

  int unread(String deviceId) => _unread[deviceId] ?? 0;
  int version(String deviceId) => _versions[deviceId] ?? 0;

  void _onLinks() {
    final ids = {for (final p in _connections.pairings) p.deviceId};
    _unread.removeWhere((id, _) => !ids.contains(id));
    for (final id in ids) {
      final state = _connections.state(id);
      final before = _states[id];
      _states[id] = state;
      if (state == LinkState.ready && before != LinkState.ready) _fetch(id);
    }
  }

  Future<void> _fetch(String deviceId) async {
    try {
      final s = obj(
        await callTool(_connections, deviceId, 'feedback:state', const []),
      );
      final n = s['unreadCount'];
      set(deviceId, n is num ? n.toInt() : 0);
    } catch (_) {
      // 旧电脑不认、没连上：不显示红点
    }
  }

  /// 反馈页取到新的列表后顺手更新（全部标为已读、看了一条）
  void set(String deviceId, int unread) {
    if (_unread[deviceId] == unread) return;
    _unread[deviceId] = unread;
    notifyListeners();
  }

  @override
  void dispose() {
    _connections.removeListener(_onLinks);
    _events.cancel();
    super.dispose();
  }
}
