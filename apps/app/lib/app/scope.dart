// 全 App 共用的对象（连接、主站接口）：放在 InheritedWidget 里往下传，测试和演示模式换成假的
import 'package:flutter/widgets.dart';

import '../connection/connections.dart';
import '../connection/pair.dart';
import '../data/desktop_lists.dart';
import '../data/feedback.dart';
import '../platform/notifier.dart';
import '../platform/home_widget.dart';
import '../platform/share_inbox.dart';
import 'background.dart';
import 'settings.dart';

class AppServices {
  const AppServices({
    required this.connections,
    required this.api,
    required this.lists,
    required this.settings,
    required this.notifier,
    required this.watcher,
    this.feedback,
    this.share = const NoShareInbox(),
    this.homeWidget = const NoHomeWidget(),
    this.demo = false,
  });
  final Connections connections;
  final BridgeApi api;

  /// 每台电脑的会话列表和项目
  final DesktopLists lists;

  /// 本机设置（后台保持连接、面容 / 指纹锁）
  final AppSettings settings;

  /// 系统通知
  final Notifier notifier;

  /// 在后台时的提醒和保持连接
  final BackgroundWatcher watcher;

  /// 每台电脑的反馈未读数（设置、抽屉的红点）；测试里不给就不显示红点
  final FeedbackUnread? feedback;

  /// 别的 App 分享进来的（D2）
  final ShareInbox share;

  /// 桌面小部件（D3）
  final HomeScreenWidget homeWidget;

  /// 演示模式：不连电脑，用假数据（--dart-define=DEMO=1）
  final bool demo;
}

class AppScope extends InheritedNotifier<Connections> {
  AppScope({super.key, required this.services, required super.child})
    : super(notifier: services.connections);
  final AppServices services;

  static AppServices of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.services;

  /// 不订阅变化（按钮回调里用）
  static AppServices read(BuildContext context) =>
      context.getInheritedWidgetOfExactType<AppScope>()!.services;
}
