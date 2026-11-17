// C5：手机看频道（docs/mobile-app.md §15.6，只读）。排序、新消息并进时间线；演示电脑走一遍：
// 抽屉 → 频道 → 列表 → 时间线（任务卡状态）→ 任务卡里打开会话。
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
import 'package:pixelsky_app/data/channels.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/platform/notifier.dart';

ChannelEntry _e(String id, num at, [String status = 'done']) =>
    ChannelEntry({'id': id, 'kind': 'task', 'at': at, 'status': status});

ChannelSummary _c(String id, num at, {bool archived = false}) =>
    ChannelSummary({'id': id, 'lastAt': at, 'archived': archived});

void main() {
  test('列表：最近的在前，归档的放最后', () {
    final list = sortChannels([
      _c('a', 1),
      _c('b', 3, archived: true),
      _c('c', 2),
    ]);
    expect([for (final c in list) c.id], ['c', 'a', 'b']);
  });

  test('新消息并进时间线：同 id 原地换掉，晚到的旧消息按时间插进去', () {
    var list = [_e('a', 1), _e('b', 3, 'running')];
    list = mergeEntry(list, _e('b', 3, 'done'));
    expect([for (final e in list) e.status], ['done', 'done']);
    list = mergeEntry(list, _e('c', 2));
    expect([for (final e in list) e.id], ['a', 'c', 'b']);
    list = mergeEntry(list, _e('d', 9));
    expect(list.last.id, 'd');
  });

  testWidgets('抽屉 → 频道 → 时间线 → 打开任务的会话', (tester) async {
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
    await until(() => find.text('频道').evaluate().isNotEmpty, '抽屉里有频道');
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('频道'));
    await until(() => find.text('前端重构').evaluate().isNotEmpty, '频道列表');
    expect(find.text('Codex：登录页已拆成三个组件，等你看'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('前端重构'));
    await until(() => find.text('任务 · 拆分登录页').evaluate().isNotEmpty, '时间线');
    expect(find.text('完成'), findsOneWidget);
    expect(find.text('等你确认'), findsOneWidget);
    expect(find.text('手机上只能看 · 发消息、批准任务请在电脑上'), findsWidgets);
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('打开会话 ›'));
    await until(() => find.text(L10n.title1).evaluate().isNotEmpty, '打开了会话');

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
