// B4：在手机上换额度来源（docs/mobile-app.md §14.4）。用演示电脑走真的连接、会话页和改模式面板：
// 面板里列出电脑上配好的来源；换到平台线路先确认倍率，取消就不换；确认后会话记录换成那条线路，模型列表换成线路上的。
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixelsky_app/app/app.dart';
import 'package:pixelsky_app/app/background.dart';
import 'package:pixelsky_app/app/scope.dart';
import 'package:pixelsky_app/app/settings.dart';
import 'package:pixelsky_app/connection/connections.dart';
import 'package:pixelsky_app/connection/pair.dart';
import 'package:pixelsky_app/connection/storage.dart';
import 'package:pixelsky_app/data/desktop_lists.dart';
import 'package:pixelsky_app/data/list_cache.dart';
import 'package:pixelsky_app/data/session_controller.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/platform/notifier.dart';
import 'package:pixelsky_app/protocol/json.dart';

void main() {
  testWidgets('改模式面板里换额度来源：换到平台先确认倍率，取消不换，确认后换成那条线路', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);

    final demo = DemoDesktop();
    final device = demo.pairing.deviceId;
    final connections = Connections(
      store: MemoryPairingStore([demo.pairing]),
      connect: demo.accept,
    );
    await connections.load();
    final settings = AppSettings(persist: false)..language = LanguageChoice.zh;
    final notifier = NoopNotifier();
    final lists = DesktopLists(
      connections,
      cache: ListCache(MemoryCacheStore()),
    );
    await tester.pumpWidget(
      PixelSkyApp(
        services: AppServices(
          connections: connections,
          api: IoBridgeApi(),
          lists: lists,
          settings: settings,
          notifier: notifier,
          watcher: BackgroundWatcher(notifier: notifier, settings: settings),
          demo: true,
        ),
      ),
    );

    Future<void> until(bool Function() ok, String what) async {
      for (var i = 0; i < 100 && !ok(); i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(ok(), isTrue, reason: what);
    }

    // 另开一个控制器看 s3 的会话记录
    final watch = SessionController(connections, device, 's3');
    Json record() => obj(watch.view.snapshot?['record']);

    await until(() => find.text(L10n.title3).evaluate().isNotEmpty, '连上并拿到列表');
    await tester.tap(find.text(L10n.title3).first);
    await until(
      () => find.byIcon(Icons.auto_awesome).evaluate().isNotEmpty,
      '打开 s3',
    );
    await tester.tap(find.byIcon(Icons.auto_awesome));
    await until(
      () => find.text('平台 · 官方直连').evaluate().isNotEmpty,
      '面板里列出电脑上配好的来源',
    );
    expect(find.text('额度来源'), findsOneWidget);
    expect(find.text('自己的账号'), findsOneWidget);
    expect(find.text('自定义接口 · 我的中转'), findsOneWidget);
    expect(find.text('倍率 ×1.5'), findsOneWidget);

    // 取消：不换
    await tester.tap(find.text('平台 · 官方直连'));
    await until(
      () => find.textContaining('×1.5 花平台余额').evaluate().isNotEmpty,
      '先确认倍率',
    );
    await tester.tap(find.text('取消'));
    await tester.pump(const Duration(milliseconds: 500));
    expect(record()['platform'], isNull);

    // 确认：换成那条线路，模型用线路上的
    await tester.tap(find.text('平台 · 官方直连'));
    await until(() => find.text('确定').evaluate().isNotEmpty, '再弹确认');
    await tester.tap(find.text('确定'));
    await until(() => record()['platform'] != null, '换成平台线路');
    expect(obj(record()['platform'])['groupId'], '35');
    expect(record()['model'], L10n.claudeModels.first['id']);

    // 换成自定义接口不用确认
    await tester.tap(find.text('自定义接口 · 我的中转'));
    await until(() => record()['provider'] != null, '换成自定义接口');
    expect(record()['platform'], isNull);

    watch.dispose();
    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
