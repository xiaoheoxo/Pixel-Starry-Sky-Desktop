// A3：点「有几个任务等你处理」的通知 → 逐个处理（docs/mobile-app.md §8.2）。
// 用演示电脑走真的连接、会话页和审批卡片；通知换成测试里能发「点了」的假通知。
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixelsky_app/app/app.dart';
import 'package:pixelsky_app/app/background.dart';
import 'package:pixelsky_app/app/scope.dart';
import 'package:pixelsky_app/app/settings.dart';
import 'package:pixelsky_app/connection/connections.dart';
import 'package:pixelsky_app/connection/pair.dart';
import 'package:pixelsky_app/connection/storage.dart';
import 'package:pixelsky_app/data/actions.dart';
import 'package:pixelsky_app/data/desktop_lists.dart';
import 'package:pixelsky_app/data/list_cache.dart';
import 'package:pixelsky_app/data/notify.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/platform/notifier.dart';

class TapNotifier extends NoopNotifier {
  final tapped = StreamController<NotifyTarget>.broadcast();
  @override
  Stream<NotifyTarget> get taps => tapped.stream;
}

void main() {
  testWidgets('点「等你处理」通知：逐个过一遍，答完一个自动去下一个，最后回概览', (tester) async {
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
    // 测试环境的系统语言是英文；这里按中文文字找控件
    final settings = AppSettings(persist: false)..language = LanguageChoice.zh;
    final notifier = TapNotifier();
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

    List<String> waiting() => waitingIds(lists.get(device).sessions);

    // 演示里 s2 本来就在等；让 s5 也停在审批上（消息带 approve）
    await until(() => waiting().isNotEmpty, '连上并拿到列表');
    expect(waiting(), ['s2']);
    unawaited(SessionActions(connections, device, 's5').send('please approve'));
    await until(() => waiting().length == 2, 's5 也在等');
    expect(waiting(), ['s5', 's2']);

    notifier.tapped.add(NotifyTarget(device: device, waiting: true));
    await until(() => find.text('1 / 2').evaluate().isNotEmpty, '打开第一个');
    expect(find.text('下一个'), findsOneWidget);
    expect(find.text('flutter test'), findsWidgets);

    // 在手机上允许 → 卡片收起，停一下自动去下一个
    await tester.tap(find.text('允许'));
    await until(() => find.text('2 / 2').evaluate().isNotEmpty, '自动去 s2');
    expect(find.text('完成'), findsOneWidget);

    await tester.tap(find.text('完成'));
    await until(() => find.text('都处理完了').evaluate().isNotEmpty, '回概览');

    // 收尾：断开演示连接，等它的计时器都停下
    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
