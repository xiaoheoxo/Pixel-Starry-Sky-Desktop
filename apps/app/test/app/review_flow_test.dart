// C4：审查卡（docs/mobile-app.md §15.5）。轮次 key 的规则同电脑 changeBlocks.ts；演示电脑走一遍：
// s3 第一轮审过 → 改动卡片下出审查卡 → 忽略一条 → 修另一条（电脑拼的话进了对话）→ 条目变「已发去修」。
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
import 'package:pixelsky_app/data/reviews.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/protocol/json.dart';
import 'package:pixelsky_app/platform/notifier.dart';

Item _i(String kind, String id, [Json extra = const {}]) =>
    Item({'kind': kind, 'id': id, ...extra});

void main() {
  test('轮次 key：开头那条用户消息；指导和断线重连的「继续」不算；之前的是 start', () {
    expect(turnKeyOf([_i('user', 'u1'), _i('file_change', 'f')]), 'u1');
    expect(
      turnKeyOf([
        _i('user', 'g', {'mode': 'guidance'}),
        _i('user', 'r', {'reconnect': true}),
        _i('user', 'u2'),
      ]),
      'u2',
    );
    expect(turnKeyOf([_i('file_change', 'f')]), 'start');
  });

  testWidgets('审查卡：忽略一条、修一条', (tester) async {
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
    await until(() => find.text('AI 审查').evaluate().isNotEmpty, '审查卡');
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('全部修复（2）'), findsOneWidget);
    expect(find.text('packages/link/src/log.ts:7 · 已修'), findsOneWidget);
    await tester.tap(find.text('忽略').last);
    await until(() => find.text('全部修复（2）').evaluate().isEmpty, '忽略了');
    expect(find.text('重试次数写死，建议放进配置'), findsNothing);
    await tester.tap(find.text('修这条'));
    await until(
      () => find
          .text('packages/link/src/noise.ts:42 · 已发去修')
          .evaluate()
          .isNotEmpty,
      '发去修了',
    );
    expect(find.textContaining('审查发现这些问题'), findsWidgets);
    await tester.pump(const Duration(seconds: 5));

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
