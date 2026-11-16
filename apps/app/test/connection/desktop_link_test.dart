import 'dart:async';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/connection/desktop_link.dart';
import 'package:pixelsky_app/connection/pairing.dart';
import 'package:pixelsky_app/link/link.dart';

import 'fake_desktop.dart';

/// 扫码后的配对记录（pending，带配对请求）
Pairing pendingPairing(FakeDesktop d) {
  final phone = generateKeypair();
  final offer = PairingOffer(
    relay: 'wss://relay.example/v1/bridge/ws',
    desktop: 'd1',
    key: toBase64Url(d.key.publicKey),
    secret: d.secret,
    name: '测试电脑',
    expires: 9e15,
    code: 'c',
  );
  return Pairing(
    deviceId: 'ph1',
    token: 't',
    desktopId: 'd1',
    desktopName: '测试电脑',
    origin: 'https://main.example',
    desktopKey: offer.key,
    fingerprint: '',
    phoneKey: toBase64Url(phone.privateKey),
    pairedAt: 0,
    status: PairingStatus.pending,
    request: pairRequest(offer, phone.publicKey, '我的手机'),
  );
}

class Harness {
  Harness(this.desktop, Pairing pairing) {
    link = DesktopLink(
      pairing,
      LinkHooks(
        onState: states.add,
        onEvent: (c, d) => events.add('$c:$d'),
        onPairing: saved.add,
      ),
      connect: desktop.accept,
      random: Random(1),
    );
  }
  final FakeDesktop desktop;
  late final DesktopLink link;
  final states = <LinkState>[];
  final events = <String>[];
  final saved = <Pairing>[];
}

void main() {
  test('扫码 → 等确认 → 允许 → 握手 → ready，配对记录改成已配对', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret())..autoAccept = false;
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.flushMicrotasks();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.waitingConfirm);
      d.accept1(d.socket!);
      async.flushMicrotasks();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.ready);
      expect(h.link.hello?.name, '测试电脑');
      expect(h.saved.single.status, PairingStatus.paired);
      expect(h.saved.single.request, isNull);
      expect(h.states, [
        LinkState.waitingConfirm,
        LinkState.handshaking,
        LinkState.ready,
      ]);
    });
  });

  test('调用、事件（含批量拆开）', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.ready);
      Object? result;
      h.link.call('engine:sessions').then((v) => result = v);
      async.elapse(Duration.zero);
      expect(result, [
        {'id': 's1'},
      ]);
      d.event('engine:event', {
        'kind': 'batch',
        'events': ['a', 'b'],
      });
      d.event('projectTools:changed', 'tools');
      async.elapse(Duration.zero);
      expect(h.events, [
        'engine:event:a',
        'engine:event:b',
        'projectTools:changed:tools',
      ]);
    });
  });

  test('电脑上点拒绝：配对记录标成已移除，不再重连', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret())..reject = true;
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.removed);
      expect(h.saved.single.status, PairingStatus.removed);
      async.elapse(const Duration(minutes: 5));
      expect(d.sockets, hasLength(1));
    });
  });

  test('中转 4001：移除；4010：被顶掉，点重新连接才连', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      d.socket!.drop(closeReplaced);
      async.elapse(const Duration(minutes: 1));
      expect(h.link.state, LinkState.replaced);
      expect(d.sockets, hasLength(1));
      h.link.reconnect();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.ready);
      d.socket!.drop(closeUnauthorized);
      async.elapse(const Duration(minutes: 1));
      expect(h.link.state, LinkState.removed);
      expect(h.saved.last.status, PairingStatus.removed);
    });
  });

  test('断线后按退避重连，连上后计数清零', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      d.socket!.drop(1006);
      async.flushMicrotasks();
      expect(h.link.state, LinkState.offline);
      expect(h.link.retries, 1);
      expect(h.link.retryAt, isNotNull);
      async.elapse(const Duration(seconds: 2));
      expect(h.link.state, LinkState.ready);
      expect(h.link.retries, 0);
      expect(d.sockets, hasLength(2));
    });
  });

  test('电脑下线 / 上线：重新握手', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      d.goOffline();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.desktopOffline);
      expect(h.link.call('x'), throwsA(isA<LinkNotReady>()));
      d.goOnline();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.ready);
      expect(d.handshakes, 2);
    });
  });

  test('电脑不认识这部手机：unrecognized，一分钟后再试', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      d.known.clear();
      d.goOnline();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.unrecognized);
      expect(d.handshakes, 2);
      async.elapse(const Duration(seconds: 61));
      expect(d.handshakes, 3);
    });
  });

  test('版本不一致：incompatible，不再重试', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret())..helloVersion = 2;
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.incompatible);
      async.elapse(const Duration(minutes: 2));
      expect(h.link.state, LinkState.incompatible);
    });
  });

  test('电脑不回握手：10 秒后断开重连', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      d.silentHandshake = true;
      d.goOnline();
      async.elapse(Duration.zero);
      expect(h.link.state, LinkState.handshaking);
      async.elapse(const Duration(seconds: 10));
      expect(h.link.state, LinkState.offline);
      d.silentHandshake = false;
      async.elapse(const Duration(seconds: 2));
      expect(h.link.state, LinkState.ready);
    });
  });

  test('电脑悄悄丢了加密会话：调用超时后探 hello，失败就重新握手', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      d.forgetSession();
      Object? error;
      h.link.call('engine:sessions').catchError((Object e) => error = e);
      async.elapse(const Duration(seconds: 20));
      expect('$error', contains('RPC_TIMEOUT'));
      expect(d.handshakes, 1);
      async.elapse(const Duration(seconds: 10));
      expect(d.handshakes, 2);
      expect(h.link.state, LinkState.ready);
    });
  });

  test('收到过心跳后 60 秒什么都没收到：当成断线', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      d.tick();
      async.elapse(const Duration(seconds: 50));
      expect(h.link.state, LinkState.ready);
      expect(d.sockets, hasLength(1));
      // 看门狗每 15 秒看一次：75 秒时发现超过 60 秒没消息，断开后 1 秒左右重连上
      async.elapse(const Duration(seconds: 30));
      expect(d.sockets, hasLength(2));
      expect(d.sockets.first.closed, isTrue);
      expect(h.states, contains(LinkState.offline));
      expect(h.link.state, LinkState.ready);
    });
  });

  test('stop 之后不再重连', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      final h = Harness(d, pendingPairing(d));
      h.link.start();
      async.elapse(Duration.zero);
      h.link.stop();
      async.elapse(const Duration(minutes: 5));
      expect(d.sockets, hasLength(1));
      expect(d.sockets.single.closed, isTrue);
    });
  });

  test('unbatch', () {
    expect(
      unbatch({
        'kind': 'batch',
        'events': [1, 2],
      }),
      [1, 2],
    );
    expect(unbatch({'kind': 'x'}), [
      {'kind': 'x'},
    ]);
    expect(unbatch(null), [null]);
  });

  test('Hello.parse', () {
    final h = Hello.parse({'version': 1, 'name': 'n', 'access': 'act'});
    expect((h.version, h.access, h.tools), (1, 'act', false));
    expect(Hello.parse(null).access, 'view');
    unawaited(Future<void>.value());
  });
}
