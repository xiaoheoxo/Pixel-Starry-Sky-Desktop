// C1：「先出计划」开关（docs/mobile-app.md §15.2）。演示电脑走真的连接和改模式面板：
// 打开开关进计划，记下原来那档；计划中点档位只换批准后回到的那档；关掉回到那档。
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
  testWidgets('改模式面板里的先出计划开关：进计划记下原来那档，计划中换批准后的档，关掉回到那档', (tester) async {
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

    // 「先出计划」开关跟在权限那组下面
    Future<void> toggle(String text) => tester.tap(find.text(text));

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
    await until(() => find.text('先出计划').evaluate().isNotEmpty, '面板里有先出计划开关');
    // 等底部弹层滑上来再点
    await tester.pump(const Duration(seconds: 1));
    final before = record()['permissionMode'];
    expect(before, isNot('plan'));

    await toggle('先出计划');
    await until(() => record()['permissionMode'] == 'plan', '进计划');
    expect(record()['planReturn'], before);
    await until(
      () => find.textContaining('批准后按「').evaluate().isNotEmpty,
      '开关下面写批准后按哪档',
    );

    // 计划中点档位：只换批准后回到的那档，还在计划中
    await tester.tap(find.text('每步问我'));
    await until(() => record()['planReturn'] == 'ask', '换批准后的档');
    expect(record()['permissionMode'], 'plan');

    // 关掉：回到那档
    await toggle('先出计划');
    await until(() => record()['permissionMode'] == 'ask', '关掉回到那档');
    expect(record()['planReturn'], isNull);

    watch.dispose();
    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
