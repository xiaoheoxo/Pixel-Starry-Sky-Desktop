// D1：通知上直接「允许 / 拒绝」（docs/mobile-app.md §15.7）：哪些审批能放按钮、通知里带的 id、
// 后台提醒带上审批、开了锁时按钮先打开 App；按钮点了以后先查还在不在等再答复（演示电脑走真的连接）。
import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/app/background.dart';
import 'package:pixelsky_app/app/settings.dart';
import 'package:pixelsky_app/connection/connections.dart';
import 'package:pixelsky_app/connection/storage.dart';
import 'package:pixelsky_app/data/notify.dart';
import 'package:pixelsky_app/data/quick_answer.dart';
import 'package:pixelsky_app/demo/demo.dart';
import 'package:pixelsky_app/i18n/i18n.dart';

import 'a3_test.dart' show FakeNotifier, s;

void main() {
  group('哪些审批能在通知上处理', () {
    const cmd = {
      'requestId': 'req1',
      'kind': 'command',
      'title': '运行命令',
      'command': 'pnpm test\n--watch',
    };

    test('只有一条、普通权限审批才行；命令只取第一行', () {
      final a = quickApproval([cmd], sessionTitle: '修登录')!;
      expect(a.requestId, 'req1');
      expect(a.text, '运行命令 · pnpm test');
      expect(a.sessionTitle, '修登录');
      expect(quickApproval([cmd, cmd]), isNull, reason: '几条在等');
      expect(quickApproval([]), isNull);
      for (final kind in ['question', 'plan']) {
        expect(
          quickApproval([
            {...cmd, 'kind': kind},
          ]),
          isNull,
          reason: kind,
        );
      }
      expect(
        quickApproval([
          {...cmd, 'kind': 'file_change'},
        ]),
        isNotNull,
      );
      expect(
        quickApproval([
          {...cmd, 'canAllow': false},
        ]),
        isNull,
      );
      expect(
        quickApproval([
          {...cmd, 'canDeny': false},
        ]),
        isNull,
      );
      expect(
        quickApproval([
          {...cmd, 'formSchema': {}},
        ]),
        isNull,
        reason: '要填表',
      );
      expect(
        quickApproval([
          {...cmd, 'requestId': 'a b'},
        ]),
        isNull,
        reason: 'id 不合规',
      );
    });

    test('通知里带的审批 id 原样带回；不合规的丢掉', () {
      const t = NotifyTarget(
        device: 'd',
        session: 's',
        waiting: true,
        request: 'req1',
      );
      final back = NotifyTarget.decode(t.encode())!;
      expect(back.request, 'req1');
      expect(back.session, 's');
      expect(
        NotifyTarget.decode('{"device":"d","request":"x y"}')!.request,
        isNull,
      );
    });
  });

  group('后台提醒带上审批', () {
    test('一个会话在等时查一下，带上审批；开了锁时按钮先打开 App', () {
      fakeAsync((async) {
        final n = FakeNotifier();
        final settings = AppSettings(persist: false)..lock = true;
        final asked = <String>[];
        final w = BackgroundWatcher(
          notifier: n,
          settings: settings,
          approvalFor: (device, session) async {
            asked.add('$device/$session');
            return const QuickApproval(requestId: 'req1', title: '运行命令');
          },
        );
        w.setForeground(false);
        w.update('dev', [s('a', 'running')]);
        w.update('dev', [s('a', 'waiting')]);
        async.elapse(const Duration(seconds: 3));
        expect(asked, ['dev/a']);
        expect(n.shown.single.$1.approval?.requestId, 'req1');
        expect(n.unlockFirst.single, isTrue);

        // 几个会话在等、跑完的提醒：不查
        w.update('dev', [s('a', 'running'), s('b', 'running')]);
        w.update('dev', [s('a', 'waiting'), s('b', 'waiting')]);
        async.elapse(const Duration(seconds: 3));
        expect(asked.length, 1);
        expect(n.shown.last.$1.approval, isNull);
        expect(n.shown.last.$1.count, 2);
      });
    });

    test('查的时候回到前台了就不弹', () {
      fakeAsync((async) {
        final n = FakeNotifier();
        late BackgroundWatcher w;
        w = BackgroundWatcher(
          notifier: n,
          settings: AppSettings(persist: false),
          approvalFor: (device, session) async {
            w.setForeground(true);
            return null;
          },
        );
        w.setForeground(false);
        w.update('dev', [s('a', 'running')]);
        w.update('dev', [s('a', 'waiting')]);
        async.elapse(const Duration(seconds: 3));
        expect(n.shown, isEmpty);
      });
    });
  });

  group('点了按钮以后', () {
    test('还在等就答复，电脑上处理过的写明已经处理过了', () async {
      language.value = AppLanguage.zh;
      final demo = DemoDesktop();
      final connections = Connections(
        store: MemoryPairingStore([demo.pairing]),
        connect: demo.accept,
      );
      await connections.load();
      final device = demo.pairing.deviceId;
      for (var i = 0; i < 50 && connections.state(device) == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
      final target = NotifyTarget(
        device: device,
        session: 's2',
        waiting: true,
        request: 'req1',
      );
      final first = await answerFromNotice(connections, (
        target: target,
        allow: true,
      ), sessionTitle: '给设置页加搜索');
      expect(first, '已允许 · 给设置页加搜索');
      final again = await answerFromNotice(connections, (
        target: target,
        allow: false,
      ));
      expect(again, handledText);

      final gone = await answerFromNotice(connections, (
        target: const NotifyTarget(device: 'nope', session: 's2', request: 'r'),
        allow: true,
      ));
      expect(gone, handledText, reason: '忘掉的电脑');
      connections.dispose();
      demo.dispose();
    });
  });
}
