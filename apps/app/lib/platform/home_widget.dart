// 桌面小部件（home_widget，只接了安卓，第三批 D3，docs/mobile-app.md §15.9）：App 写字，
// 原生的 PixelSkyWidget.kt 画；点小部件打开 App（pixelsky://widget/triage）。平台相关的都在这里，界面只用接口。
import 'dart:io';

import 'package:home_widget/home_widget.dart';

import '../data/widget_state.dart';

/// 点小部件打开 App 时带的链接
const widgetTriageUri = 'pixelsky://widget/triage';

abstract interface class HomeScreenWidget {
  Future<void> show(WidgetState state);

  /// App 开着时点了小部件
  Stream<Uri?> get clicks;

  /// 冷启动时是不是点小部件打开的
  Future<Uri?> launched();
}

class NoHomeWidget implements HomeScreenWidget {
  const NoHomeWidget();
  @override
  Future<void> show(WidgetState state) async {}
  @override
  Stream<Uri?> get clicks => const Stream.empty();
  @override
  Future<Uri?> launched() async => null;
}

class PluginHomeWidget implements HomeScreenWidget {
  static const _provider = 'xyz.pixelstarrysky.pixelsky_app.PixelSkyWidget';

  @override
  Future<void> show(WidgetState state) async {
    if (!Platform.isAndroid) return;
    await HomeWidget.saveWidgetData<String>('title', state.title);
    await HomeWidget.saveWidgetData<String>('body', state.body);
    await HomeWidget.saveWidgetData<bool>('waiting', state.waiting);
    await HomeWidget.updateWidget(qualifiedAndroidName: _provider);
  }

  @override
  Stream<Uri?> get clicks =>
      Platform.isAndroid ? HomeWidget.widgetClicked : const Stream.empty();

  @override
  Future<Uri?> launched() async => Platform.isAndroid
      ? await HomeWidget.initiallyLaunchedFromHomeWidget()
      : null;
}
