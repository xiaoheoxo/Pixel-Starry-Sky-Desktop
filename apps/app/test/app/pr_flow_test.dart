// C3：PR 条和详情（docs/mobile-app.md §15.4）。演示电脑的 s3 有一个检查没过的 PR：
// 会话页出 PR 条 → 点开详情 → 让 AI 修检查（电脑拼的话进了对话）→ 合并（选方式、确认）→ 变成已合并、能归档。
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
  testWidgets('PR 条 → 详情 → 让 AI 修 → 合并', (tester) async {
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
    await until(() => find.text('#128').evaluate().isNotEmpty, 'PR 条');
    expect(find.text('检查 3/5'), findsOneWidget);
    await tester.tap(find.text('#128'));
    await until(() => find.text('PR #128').evaluate().isNotEmpty, '详情页');
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('2 项检查没过'), findsOneWidget);
    expect(find.text('test (node 22)'), findsOneWidget);
    await tester.tap(find.text('让 AI 修检查'));
    await until(() => find.text('已发给 AI').evaluate().isNotEmpty, '发出去了');

    // 检查没过时合并按钮灰着；演示里把检查改成通过再合并
    expect(find.text('合并（检查全部通过、没有冲突后可用）'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    Navigator.of(tester.element(find.text('在浏览器打开'))).pop();
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 200));
    }
    expect(find.text('检查 3/5'), findsOneWidget);
    demo.setPr('s3', {'ci': 'pass', 'ciFailed': 0, 'checks': <Object?>[]});
    await until(() => find.text('检查 3/5').evaluate().isEmpty, '推过来新的');
    await tester.tap(find.text('#128'));
    await until(
      () => find.text('在浏览器打开').hitTestable().evaluate().isNotEmpty,
      '打开详情',
    );
    expect(find.text('检查全部通过'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('合并'));
    await until(() => find.text('合并 PR #128？').evaluate().isNotEmpty, '确认框');
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('压成一个提交（squash）'), findsOneWidget);
    await tester.tap(find.text('合并').last);
    await until(() => find.text('归档这个对话').evaluate().isNotEmpty, '已合并');
    expect(find.text('已合并'), findsWidgets);
    await tester.pump(const Duration(seconds: 5));

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
