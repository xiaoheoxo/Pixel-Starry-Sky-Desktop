// E1：账号与充值（docs/mobile-app.md §15.13）。演示电脑走一遍：抽屉 → 账号与充值 → 选 200（送 5%）→
// 用支付宝付 → 确认 → 付款页「等待付款」→ 3 秒后「已到账」。
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
  testWidgets('充值：选金额、确认、付款、到账', (tester) async {
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
    await tester.tap(find.byTooltip('菜单'));
    await until(() => find.text('账号与充值').evaluate().isNotEmpty, '抽屉里有账号与充值');
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('账号与充值'));
    await until(() => find.text('\$96.25').evaluate().isNotEmpty, '余额');
    await until(() => find.textContaining('¥200').evaluate().isNotEmpty, '商品');
    await tester.pump(const Duration(seconds: 1));
    // 额度那一节在余额下面（§17），充值的选项要往下翻
    await tester.ensureVisible(find.text('¥200 · 送 5%'));
    await tester.pump();
    await tester.tap(find.text('¥200 · 送 5%'));
    await tester.pump();
    await tester.ensureVisible(find.text('用支付宝付 ¥200'));
    await tester.pump();
    expect(find.textContaining('含赠送'), findsOneWidget);
    await tester.tap(find.text('用支付宝付 ¥200'));
    await until(() => find.text('确认付款').evaluate().isNotEmpty, '确认框');
    await tester.tap(find.text('付款'));
    await until(() => find.text('等待付款').evaluate().isNotEmpty, '付款页');
    await until(() => find.text('已到账').evaluate().isNotEmpty, '到账');
    expect(find.textContaining('到账 \$'), findsOneWidget);
    await tester.tap(find.text('完成'));
    await tester.pump(const Duration(seconds: 1));
    await tester.drag(find.byType(ListView).first, const Offset(0, 2000));
    await until(() => find.text('\$125.65').evaluate().isNotEmpty, '余额更新');

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
