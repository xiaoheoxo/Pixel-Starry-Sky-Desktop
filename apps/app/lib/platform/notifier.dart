// 系统通知（flutter_local_notifications）：本机提醒、点通知回到 App、安卓后台保持连接的前台服务通知。
// 平台相关的都在这一个文件；界面和规则只用 Notifier 接口（测试里换成假的）。
import 'dart:async';
import 'dart:io';

import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../data/notify.dart';
import '../i18n/i18n.dart';

abstract interface class Notifier {
  /// 点了通知（App 开着时）
  Stream<NotifyTarget> get taps;

  /// 冷启动时是不是点通知打开的
  Future<NotifyTarget?> launchTarget();

  /// 要通知权限（安卓 13+、iOS）；返回给没给
  Future<bool> requestPermission();

  /// 现在能不能弹通知
  Future<bool> enabled();

  Future<void> show(NotifyPayload payload, String device);

  /// 安卓：前台服务保持连接（通知栏常驻一条）；别的平台什么都不做
  Future<void> keepAlive(String? text);
}

class NoopNotifier implements Notifier {
  @override
  Stream<NotifyTarget> get taps => const Stream.empty();
  @override
  Future<NotifyTarget?> launchTarget() async => null;
  @override
  Future<bool> requestPermission() async => false;
  @override
  Future<bool> enabled() async => false;
  @override
  Future<void> show(NotifyPayload payload, String device) async {}
  @override
  Future<void> keepAlive(String? text) async {}
}

class LocalNotifier implements Notifier {
  final _plugin = FlutterLocalNotificationsPlugin();
  final _taps = StreamController<NotifyTarget>.broadcast();
  bool _ready = false;
  bool _service = false;

  static const _alerts = 'alerts';
  static const _connection = 'connection';

  /// 前台服务通知的 id（不能是 0）；提醒按种类各用一个 id，同一种只留最新一条（同网页版 tag）
  static const _serviceId = 1;
  static const _ids = {
    NotifyKind.waiting: 11,
    NotifyKind.failed: 12,
    NotifyKind.completed: 13,
  };

  Future<void> init() async {
    if (_ready) return;
    await _plugin.initialize(
      settings: const InitializationSettings(
        // 白色剪影的小图标（res/drawable/ic_stat_pixelsky.xml）；用应用图标会显示成一块灰方块
        android: AndroidInitializationSettings('@drawable/ic_stat_pixelsky'),
        iOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
      ),
      onDidReceiveNotificationResponse: (r) {
        final t = NotifyTarget.decode(r.payload);
        if (t != null) _taps.add(t);
      },
    );
    _ready = true;
  }

  AndroidFlutterLocalNotificationsPlugin? get _android => _plugin
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();

  @override
  Stream<NotifyTarget> get taps => _taps.stream;

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
  Future<void> show(NotifyPayload payload, String device) async {
    await init();
    await _plugin.show(
      id: _ids[payload.kind]!,
      title: L('像素星空', 'PixelSky'),
      body: notifyText(payload.kind, payload.count),
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _alerts,
          L('任务提醒', 'Task alerts'),
          channelDescription: L(
            '任务等你处理、完成、出错时提醒',
            'When a task needs you, finishes, or fails',
          ),
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: const DarwinNotificationDetails(),
      ),
      payload: NotifyTarget(
        device: device,
        session: payload.session,
        waiting: payload.kind == NotifyKind.waiting,
      ).encode(),
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
