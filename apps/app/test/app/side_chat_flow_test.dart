// C2：旁聊（docs/mobile-app.md §15.3）。演示电脑走真的连接和会话菜单：
// 菜单里点旁聊 → 问一句 → 等回答出现在面板里。记录由会话页持有（SideChat），关掉面板不丢。
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
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/platform/notifier.dart';

void main() {
  testWidgets('会话菜单里的旁聊：问一句等到回答', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 2.75;
    addTearDown(tester.view.reset);

    final demo = DemoDesktop();
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

    await until(() => find.text(L10n.title3).evaluate().isNotEmpty, '连上并拿到列表');
    await tester.tap(find.text(L10n.title3).first);
    await until(
      () => find.byIcon(Icons.auto_awesome).evaluate().isNotEmpty,
      '打开 s3',
    );
    // 点标题胶囊打开会话菜单（列表页还在下面，取最上面那页的）
    await tester.tap(find.text(L10n.title3).last);
    await until(() => find.text('旁聊').evaluate().isNotEmpty, '菜单里有旁聊');
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('旁聊'));
    await until(() => find.text('不打断这一轮').evaluate().isNotEmpty, '打开旁聊面板');
    await tester.pump(const Duration(seconds: 1));
    await tester.enterText(find.byType(TextField).last, '它现在在改什么？');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await until(() => find.text('它现在在改什么？').evaluate().isNotEmpty, '问题出现在面板里');
    await until(
      () => find
          .textContaining('src/router/index.ts', findRichText: true)
          .evaluate()
          .isNotEmpty,
      '等到回答',
    );

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
