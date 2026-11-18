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
import 'package:pixelsky_app/data/team_inbox.dart';
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
    expect(find.text('手机上还不能发消息 · 请在电脑上'), findsWidgets);
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('打开会话 ›'));
    await until(() => find.text(L10n.title1).evaluate().isNotEmpty, '打开了会话');

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });

  test('团队频道按团队分组，本机的在前（§16.2）', () {
    final groups = channelGroups(
      [
        ChannelSummary({'id': 't', 'scope': 'team', 'teamId': 'T1'}),
        ChannelSummary({'id': 'l'}),
      ],
      {'T1': '星空小组'},
    );
    expect([for (final g in groups) g.title], ['本机频道', '星空小组']);
    expect(groups.last.channels.single.id, 't');
  });

  test('收件箱提醒：只提醒新来的、没读、没取消订阅的那三类；刚连上不算', () {
    InboxItem it(
      String key,
      String kind, {
      num at = 1,
      bool read = false,
      bool muted = false,
    }) => InboxItem({
      'teamId': 'T',
      'key': key,
      'kind': kind,
      'at': at,
      'read': read,
      'muted': muted,
    });
    final first = [it('a', 'mention')];
    expect(inboxAlerts(null, first, 0), isEmpty);
    final next = [
      it('a', 'mention'),
      it('b', 'approval'),
      it('c', 'done'),
      it('d', 'failed', read: true),
      it('e', 'mention', muted: true),
    ];
    expect([for (final i in inboxAlerts(first, next, 0)) i.key], ['b']);
    // 同一件事又有新动静（时间变了）再提醒
    expect(
      [
        for (final i in inboxAlerts(next, [it('a', 'mention', at: 5)], 0))
          i.key,
      ],
      ['a'],
    );
  });

  test('延后：明天 9 点、下周一 9 点（周一也排到下周一）', () {
    final monday = DateTime(2026, 11, 16, 15);
    expect(snoozeAt('tomorrow', monday), DateTime(2026, 11, 17, 9));
    expect(snoozeAt('week', monday), DateTime(2026, 11, 23, 9));
    expect(
      snoozeAt('week', DateTime(2026, 11, 22, 8)),
      DateTime(2026, 11, 23, 9),
    );
  });

  testWidgets('团队：频道分组 → 通知 → 同意队友派的活；时间线里失败写原因（§16.2）', (tester) async {
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

    await until(() => find.text(L10n.title3).evaluate().isNotEmpty, '连上');
    await tester.tap(find.byTooltip('菜单'));
    await until(() => find.text('频道').evaluate().isNotEmpty, '抽屉');
    await tester.pump(const Duration(seconds: 1));
    await tester.tap(find.text('频道'));
    await until(() => find.text('星空小组').evaluate().isNotEmpty, '团队分组');
    expect(find.text('本机频道'), findsOneWidget);
    await until(() => find.text('通知').evaluate().isNotEmpty, '收件箱入口');
    expect(find.text('2'), findsOneWidget); // 两条未读

    await tester.tap(find.text('通知'));
    await until(() => find.text('等你同意').evaluate().isNotEmpty, '收件箱');
    expect(find.text('@ 你'), findsOneWidget);
    await tester.tap(find.text('同意').first);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('1 条未读'), findsOneWidget);
    // 答过的那行不再出按钮，写结果
    expect(find.text('已同意'), findsOneWidget);

    // 点 @ 你那行：打开「后端」频道，卡片答过了；失败的写原因和次数
    await tester.tap(find.text('@Claude 接口限流加一下，登录接口每分钟 10 次').first);
    await tester.pump(const Duration(seconds: 1));
    await until(() => find.text('任务 · 登录接口加限流').evaluate().isNotEmpty, '团队时间线');
    expect(find.text('同意'), findsNothing);
    expect(find.textContaining('主人的电脑离线'), findsOneWidget);
    expect(find.text('跑过 2 次'), findsOneWidget);

    await tester.pumpWidget(const SizedBox());
    connections.dispose();
    lists.dispose();
    demo.dispose();
    await tester.pump(const Duration(seconds: 30));
  });
}
