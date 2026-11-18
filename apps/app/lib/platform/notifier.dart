// 系统通知（flutter_local_notifications）：本机提醒、点通知回到 App、安卓后台保持连接的前台服务通知。
// 平台相关的都在这一个文件；界面和规则只用 Notifier 接口（测试里换成假的）。
// 通知上的「允许 / 拒绝」（§15.7）：按钮在后台 isolate 里回调，经 IsolateNameServer 的端口转给主 isolate
// （连接在那边）；App 被关掉了就换成一条点开处理的通知。
import 'dart:async';
import 'dart:io';
import 'dart:isolate';
import 'dart:ui' show IsolateNameServer;

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../data/notify.dart';
import '../i18n/i18n.dart';

abstract interface class Notifier {
  /// 点了通知（App 开着时）
  Stream<NotifyTarget> get taps;

  /// 在通知上点了「允许」或「拒绝」
  Stream<NotifyAnswer> get answers;

  /// 冷启动时是不是点通知打开的
  Future<NotifyTarget?> launchTarget();

  /// 要通知权限（安卓 13+、iOS）；返回给没给
  Future<bool> requestPermission();

  /// 现在能不能弹通知
  Future<bool> enabled();

  /// unlockFirst：开了面容 / 指纹锁时，通知上的按钮先打开 App 解锁再处理
  Future<void> show(
    NotifyPayload payload,
    String device, {
    bool unlockFirst = false,
  });

  /// 处理完通知上的审批后显示的一行结果（几秒后消失）
  Future<void> showResult(String text);

  /// 安卓：前台服务保持连接（通知栏常驻一条）；别的平台什么都不做
  Future<void> keepAlive(String? text);
}

class NoopNotifier implements Notifier {
  @override
  Stream<NotifyTarget> get taps => const Stream.empty();
  @override
  Stream<NotifyAnswer> get answers => const Stream.empty();
  @override
  Future<NotifyTarget?> launchTarget() async => null;
  @override
  Future<bool> requestPermission() async => false;
  @override
  Future<bool> enabled() async => false;
  @override
  Future<void> show(
    NotifyPayload payload,
    String device, {
    bool unlockFirst = false,
  }) async {}
  @override
  Future<void> showResult(String text) async {}
  @override
  Future<void> keepAlive(String? text) async {}
}

/// 主 isolate 收通知按钮的端口名
const _answerPort = 'pixelsky.notify.answer';

/// 通知按钮在后台 isolate 里的回调（不打开界面时）：转给主 isolate；主 isolate 不在了（App 被关掉）
/// 换成一条点开处理的通知
@pragma('vm:entry-point')
void notifyActionInBackground(NotificationResponse r) {
  final port = IsolateNameServer.lookupPortByName(_answerPort);
  if (port != null) {
    port.send([r.actionId, r.payload]);
    return;
  }
  final plugin = FlutterLocalNotificationsPlugin();
  plugin
      .initialize(settings: LocalNotifier._settings)
      .then(
        (_) => plugin.show(
          id: LocalNotifier._ids[NotifyKind.waiting]!,
          title: L('像素星空', 'PixelSky'),
          body: L('App 已经关了，点开处理', 'The app was closed — tap to respond'),
          notificationDetails: NotificationDetails(
            android: LocalNotifier._alertDetails(),
          ),
          payload: r.payload,
        ),
      )
      .catchError((Object _) {});
}

class LocalNotifier implements Notifier {
  final _plugin = FlutterLocalNotificationsPlugin();
  final _taps = StreamController<NotifyTarget>.broadcast();
  final _answers = StreamController<NotifyAnswer>.broadcast();
  ReceivePort? _port;
  bool _ready = false;
  bool _service = false;

  static const _alerts = 'alerts';
  static const _connection = 'connection';

  /// 前台服务通知的 id（不能是 0）；提醒按种类各用一个 id，同一种只留最新一条（同网页版 tag）
  static const _serviceId = 1;
  static const _resultId = 14;
  static const _ids = {
    NotifyKind.waiting: 11,
    NotifyKind.failed: 12,
    NotifyKind.completed: 13,
    NotifyKind.team: 15,
  };

  static const _settings = InitializationSettings(
    // 白色剪影的小图标（res/drawable/ic_stat_pixelsky.xml）；用应用图标会显示成一块灰方块
    android: AndroidInitializationSettings('@drawable/ic_stat_pixelsky'),
    iOS: DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    ),
  );

  /// private：带审批内容的通知在锁屏上不显示正文
  static AndroidNotificationDetails _alertDetails({
    List<AndroidNotificationAction>? actions,
    bool private = false,
    Duration? timeoutAfter,
  }) => AndroidNotificationDetails(
    _alerts,
    L('任务提醒', 'Task alerts'),
    channelDescription: L(
      '任务等你处理、完成、出错时提醒',
      'When a task needs you, finishes, or fails',
    ),
    importance: Importance.high,
    priority: Priority.high,
    actions: actions,
    visibility: private ? NotificationVisibility.private : null,
    timeoutAfter: timeoutAfter?.inMilliseconds,
  );

  Future<void> init() async {
    if (_ready) return;
    _listenAnswers();
    await _plugin.initialize(
      settings: _settings,
      onDidReceiveNotificationResponse: _onResponse,
      onDidReceiveBackgroundNotificationResponse: notifyActionInBackground,
    );
    _ready = true;
  }

  /// 点了通知本身，或点了要打开界面的按钮（开了锁时）
  void _onResponse(NotificationResponse r) {
    final t = NotifyTarget.decode(r.payload);
    if (t == null) return;
    final id = r.actionId;
    if (id == notifyAllow || id == notifyDeny) {
      _answers.add((target: t, allow: id == notifyAllow));
    } else {
      _taps.add(t);
    }
  }

  void _listenAnswers() {
    if (!Platform.isAndroid || _port != null) return;
    final port = _port = ReceivePort();
    IsolateNameServer.removePortNameMapping(_answerPort);
    IsolateNameServer.registerPortWithName(port.sendPort, _answerPort);
    port.listen((m) {
      if (m is! List || m.length != 2) return;
      final id = m[0], raw = m[1];
      final t = NotifyTarget.decode(raw is String ? raw : null);
      if (t == null || (id != notifyAllow && id != notifyDeny)) return;
      _answers.add((target: t, allow: id == notifyAllow));
    });
  }

  AndroidFlutterLocalNotificationsPlugin? get _android => _plugin
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();

  @override
  Stream<NotifyTarget> get taps => _taps.stream;

  @override
  Stream<NotifyAnswer> get answers => _answers.stream;

  @override
  Future<NotifyTarget?> launchTarget() async {
    await init();
    final d = await _plugin.getNotificationAppLaunchDetails();
    if (d?.didNotificationLaunchApp != true) return null;
    return NotifyTarget.decode(d!.notificationResponse?.payload);
  }

  @override
  Future<bool> requestPermission() async {
    await init();
    if (Platform.isAndroid) {
      return await _android?.requestNotificationsPermission() ?? false;
    }
    final ios = _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >();
    return await ios?.requestPermissions(alert: true, sound: true) ?? false;
  }

  @override
  Future<bool> enabled() async {
    await init();
    if (Platform.isAndroid) {
      return await _android?.areNotificationsEnabled() ?? false;
    }
    final ios = _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >();
    final p = await ios?.checkPermissions();
    return p?.isEnabled ?? false;
  }

  @override
  Future<void> show(
    NotifyPayload payload,
    String device, {
    bool unlockFirst = false,
  }) async {
    await init();
    // 审批按钮只在安卓上有（iOS 要注册通知类别，等 A3b 的系统推送一起做）
    final a = Platform.isAndroid ? payload.approval : null;
    await _plugin.show(
      id: _ids[payload.kind]!,
      title: a == null || a.sessionTitle.isEmpty
          ? L('像素星空', 'PixelSky')
          : a.sessionTitle,
      body: a?.text ?? notifyText(payload.kind, payload.count),
      notificationDetails: NotificationDetails(
        android: a == null
            ? _alertDetails()
            : _alertDetails(
                private: true,
                actions: [
                  AndroidNotificationAction(
                    notifyDeny,
                    L('拒绝', 'Deny'),
                    showsUserInterface: unlockFirst,
                  ),
                  AndroidNotificationAction(
                    notifyAllow,
                    L('允许', 'Allow'),
                    showsUserInterface: unlockFirst,
                  ),
                ],
              ),
        iOS: const DarwinNotificationDetails(),
      ),
      payload: NotifyTarget(
        device: device,
        session: payload.session,
        waiting: payload.kind == NotifyKind.waiting,
        request: a?.requestId,
        inbox: payload.kind == NotifyKind.team,
      ).encode(),
    );
  }

  @override
  Future<void> showResult(String text) async {
    if (!Platform.isAndroid) return;
    await init();
    await _plugin.show(
      id: _resultId,
      title: L('像素星空', 'PixelSky'),
      body: text,
      notificationDetails: NotificationDetails(
        android: _alertDetails(timeoutAfter: const Duration(seconds: 3)),
      ),
    );
  }

  @override
  Future<void> keepAlive(String? text) async {
    if (!Platform.isAndroid) return;
    await init();
    final android = _android;
    if (android == null) return;
    if (text == null) {
      if (_service) await android.stopForegroundService();
      _service = false;
      return;
    }
    await android.startForegroundService(
      id: _serviceId,
      title: L('像素星空', 'PixelSky'),
      body: text,
      notificationDetails: AndroidNotificationDetails(
        _connection,
        L('保持连接', 'Stay connected'),
        channelDescription: L(
          '切到后台时保持和电脑的连接',
          'Keeps the connection to your computer in the background',
        ),
        importance: Importance.low,
        priority: Priority.low,
        ongoing: true,
        showWhen: false,
      ),
      foregroundServiceTypes: {
        AndroidServiceForegroundType.foregroundServiceTypeRemoteMessaging,
      },
    );
    _service = true;
  }
}
