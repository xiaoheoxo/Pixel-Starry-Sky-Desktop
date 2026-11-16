// A3：提醒规则（同电脑 push.ts）、逐个处理（同网页版 triage.ts）、列表缓存（同网页版 listCache.ts）、后台提醒的攒批。
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/app/background.dart';
import 'package:pixelsky_app/app/settings.dart';
import 'package:pixelsky_app/data/list_cache.dart';
import 'package:pixelsky_app/data/notify.dart';
import 'package:pixelsky_app/data/tasks.dart';
import 'package:pixelsky_app/platform/notifier.dart';

SessionSummary s(
  String id,
  String state, {
  String? outcome,
  num updatedAt = 0,
  bool archived = false,
}) => SessionSummary({
  'record': {
    'id': id,
    'projectId': 'p',
    'title': 'secret title $id',
    'updatedAt': updatedAt,
    'lastOutcome': ?outcome,
    if (archived) 'archivedAt': 1,
    'engineSessionId': 'big',
    'imported': {'lots': 'of data'},
  },
  'state': state,
});

class FakeNotifier implements Notifier {
  final shown = <(NotifyPayload, String)>[];
  final alive = <String?>[];
  @override
  Stream<NotifyTarget> get taps => const Stream.empty();
  @override
  Future<NotifyTarget?> launchTarget() async => null;
  @override
  Future<bool> requestPermission() async => true;
  @override
  Future<bool> enabled() async => true;
  @override
  Future<void> show(NotifyPayload payload, String device) async =>
      shown.add((payload, device));
  @override
  Future<void> keepAlive(String? text) async => alive.add(text);
}

void main() {
  group('提醒规则（同电脑 push.ts）', () {
    test('刚连上（没有上一份）不提醒', () {
      expect(notifyPayload(notifyChanges(null, [s('a', 'waiting')])), isNull);
    });

    test('变成等你处理、跑完、出错；上一份里没有的会话不算等你处理；归档的不算', () {
      final prev = [
        s('a', 'running'),
        s('b', 'running'),
        s('c', 'running'),
        s('d', 'running'),
      ];
      final next = [
        s('a', 'waiting'),
        s('b', 'idle', outcome: 'completed'),
        s('c', 'idle', outcome: 'failed'),
        s('d', 'waiting', archived: true),
        s('new', 'waiting'),
      ];
      final c = notifyChanges(prev, next);
      expect(c[NotifyKind.waiting], {'a'});
      expect(c[NotifyKind.completed], {'b'});
      expect(c[NotifyKind.failed], {'c'});
    });

    test('合成一条：最要紧的那种；只涉及一个会话才带 id；最多 99', () {
      final c = emptyNotify()
        ..[NotifyKind.completed]!.addAll({'x', 'y'})
        ..[NotifyKind.failed]!.add('z');
      final p = notifyPayload(c)!;
      expect(p.kind, NotifyKind.failed);
      expect(p.count, 1);
      expect(p.session, 'z');
      final many = emptyNotify()
        ..[NotifyKind.waiting]!.addAll([for (var i = 0; i < 120; i++) '$i']);
      expect(notifyPayload(many)!.count, 99);
      expect(notifyPayload(many)!.session, isNull);
    });

    test('文字不带标题，同网页版 sw.js', () {
      expect(notifyText(NotifyKind.waiting, 2), '有 2 个任务等你处理');
      expect(notifyText(NotifyKind.failed, 1), '1 个任务出错了');
      expect(notifyText(NotifyKind.completed, 3), '3 个任务完成');
    });

    test('通知里带的目标：编码再解析一致；不合规的 id 丢掉', () {
      const t = NotifyTarget(
        device: 'dev-1',
        session: 'ssh-a~b',
        waiting: true,
      );
      final back = NotifyTarget.decode(t.encode())!;
      expect(
        [back.device, back.session, back.waiting],
        ['dev-1', 'ssh-a~b', true],
      );
      expect(NotifyTarget.decode('{"device":"a b"}'), isNull);
      expect(NotifyTarget.decode('not json'), isNull);
      expect(
        NotifyTarget.decode('{"device":"d","session":"../x"}')!.session,
        isNull,
      );
    });
  });

  group('逐个处理（同网页版 triage.ts）', () {
    final sessions = [
      s('a', 'waiting', updatedAt: 3),
      s('b', 'waiting', updatedAt: 2),
      s('c', 'waiting', updatedAt: 1),
      s('d', 'idle', updatedAt: 9),
      s('e', 'waiting', updatedAt: 8, archived: true),
    ];

    test('打开时记下等你的会话，新的在前；没有就是 null', () {
      expect(Triage.start(sessions)!.ids, ['a', 'b', 'c']);
      expect(Triage.start([s('d', 'idle')]), isNull);
    });

    test('下一个跳过电脑上已经处理掉的；都过完了是 null', () {
      final t = Triage.start(sessions)!;
      final later = [s('a', 'idle'), s('b', 'idle'), s('c', 'waiting')];
      expect(t.next('a', later), 'c');
      expect(t.next('c', later), isNull);
      expect(t.position('b'), (index: 2, total: 3));
      expect(t.position('zzz'), isNull);
    });
  });

  group('列表缓存（同网页版 listCache.ts）', () {
    test('存了再读一样；只存列表字段；坏数据返回 null', () async {
      final store = MemoryCacheStore();
      final cache = ListCache(store);
      cache.save('dev', (
        sessions: [s('a', 'idle', updatedAt: 5)],
        projects: [
          Project({'id': 'p', 'name': 'P', 'path': '/p', 'addedAt': 1}),
        ],
      ));
      await Future<void>.delayed(Duration.zero);
      final back = (await cache.load('dev'))!;
      expect(back.sessions.single.id, 'a');
      expect(back.sessions.single.record.containsKey('imported'), false);
      expect(back.sessions.single.record['engineSessionId'], 'big');
      expect(back.projects.single.name, 'P');
      store.data['pixelsky.lists.bad'] = '{oops';
      expect(await cache.load('bad'), isNull);
      expect(await cache.load('none'), isNull);
    });

    test('最多 200 条，最近有动静的优先', () {
      final many = [
        for (var i = 0; i < 250; i++) s('$i', 'idle', updatedAt: i),
      ];
      final trimmed = trimSessions(many);
      expect(trimmed.length, maxCached);
      expect((trimmed.first['record'] as Map)['id'], '249');
    });

    test('写入节流：间隔内的多次合成最后一次；忘掉的电脑删掉', () {
      fakeAsync((async) {
        final store = MemoryCacheStore();
        final cache = ListCache(store);
        cache.save('dev', (sessions: [s('1', 'idle')], projects: const []));
        async.flushMicrotasks();
        cache.save('dev', (sessions: [s('2', 'idle')], projects: const []));
        cache.save('dev', (sessions: [s('3', 'idle')], projects: const []));
        async.flushMicrotasks();
        expect(store.data['pixelsky.lists.dev'], contains('"1"'));
        async.elapse(const Duration(seconds: 1));
        expect(store.data['pixelsky.lists.dev'], contains('"3"'));
        cache.pruneExcept({});
        async.flushMicrotasks();
        expect(store.data, isEmpty);
      });
    });
  });

  group('后台提醒', () {
    test('前台不提醒；后台攒 2 秒合成一条；回前台取消攒着的', () {
      fakeAsync((async) {
        final n = FakeNotifier();
        final w = BackgroundWatcher(
          notifier: n,
          settings: AppSettings(persist: false),
        );
        w.update('dev', [s('a', 'running'), s('b', 'running')]);
        w.update('dev', [s('a', 'waiting'), s('b', 'running')]);
        async.elapse(const Duration(seconds: 3));
        expect(n.shown, isEmpty, reason: '在前台');

        w.setForeground(false, keepAliveText: '已连上');
        expect(n.alive, ['已连上']);
        w.update('dev', [
          s('a', 'idle', outcome: 'completed'),
          s('b', 'waiting'),
        ]);
        w.update('dev', [
          s('a', 'idle', outcome: 'completed'),
          s('b', 'idle', outcome: 'failed'),
        ]);
        async.elapse(const Duration(seconds: 2));
        expect(n.shown.length, 1);
        expect(n.shown.single.$1.kind, NotifyKind.waiting);
        expect(n.shown.single.$1.session, 'b');

        w.update('dev', [s('a', 'running'), s('b', 'idle', outcome: 'failed')]);
        w.update('dev', [s('a', 'waiting'), s('b', 'idle', outcome: 'failed')]);
        w.setForeground(true);
        async.elapse(const Duration(seconds: 3));
        expect(n.shown.length, 1, reason: '回到前台，攒着的不提醒');
        expect(n.alive, ['已连上', null]);
      });
    });

    test('缓存读出来的列表只记下不比较；关掉保持连接时不起服务', () {
      fakeAsync((async) {
        final n = FakeNotifier();
        final settings = AppSettings(persist: false)..keepAlive = false;
        final w = BackgroundWatcher(notifier: n, settings: settings);
        w.setForeground(false, keepAliveText: '已连上');
        expect(n.alive, isEmpty);
        w.update('dev', [s('a', 'running')], fromDesktop: false);
        w.update('dev', [s('a', 'waiting')]);
        async.elapse(const Duration(seconds: 2));
        expect(n.shown.length, 1);
      });
    });
  });
}
