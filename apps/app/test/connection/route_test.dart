import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/connection/desktop_link.dart';
import 'package:pixelsky_app/connection/pairing.dart';
import 'package:pixelsky_app/connection/route.dart';
import 'package:pixelsky_app/connection/socket.dart';
import 'package:pixelsky_app/link/link.dart';

import 'desktop_link_test.dart' show pendingPairing;
import 'fake_desktop.dart';

const _ws426 = WebSocketException('not upgraded');

void main() {
  test('三档顺序从当前档起、绕回前面；只认正式站的两个域名', () {
    expect(tierOrder(RouteTier.cdn), [
      RouteTier.cdn,
      RouteTier.direct,
      RouteTier.ip,
    ]);
    expect(tierOrder(RouteTier.direct), [
      RouteTier.direct,
      RouteTier.ip,
      RouteTier.cdn,
    ]);
    expect(isOfficialHost('PixelStarrySky.xyz'), isTrue);
    expect(isOfficialHost('direct.pixelstarrysky.xyz'), isTrue);
    expect(isOfficialHost('relay-hk.pixelstarrysky.xyz'), isFalse);
    final u = Uri.parse('wss://pixelstarrysky.xyz/v1/bridge/ws?role=phone');
    expect(tierUrl(u, RouteTier.cdn).host, cdnHost);
    expect(
      tierUrl(u, RouteTier.ip).toString(),
      'wss://direct.pixelstarrysky.xyz/v1/bridge/ws?role=phone',
    );
  });

  test('实时连接：CDN 没升级（426）→ 换直连连上，记成当前档并存下；下次从直连开始', () async {
    final store = MemoryRouteStore();
    final route = RouteState(store: store);
    final tried = <RouteTier>[];
    final got = await route.run((t) async {
      tried.add(t);
      if (t == RouteTier.cdn) throw _ws426;
      return t;
    }, realtime: true);
    expect(got, RouteTier.direct);
    expect(tried, [RouteTier.cdn, RouteTier.direct]);
    expect(route.current, RouteTier.direct);
    expect(route.reason, contains('CDN'));
    expect(store.value, 'direct');
    final again = RouteState(store: store);
    await again.load();
    expect(again.current, RouteTier.direct);
  });

  test('三档都失败：抛最后一个错，当前档不变；不认的错不换档', () async {
    final route = RouteState(store: MemoryRouteStore());
    await expectLater(
      route.run<void>(
        (t) async => throw const SocketException('down'),
        realtime: true,
      ),
      throwsA(isA<SocketException>()),
    );
    expect(route.current, RouteTier.cdn);
    var calls = 0;
    await expectLater(
      route.run<void>((t) async {
        calls++;
        throw StateError('bug');
      }, realtime: true),
      throwsStateError,
    );
    expect(calls, 1);
  });

  test('HTTP 只往后换档：CDN 的普通请求通了，不代表实时连接能回到 CDN', () async {
    final route = RouteState(store: MemoryRouteStore())
      ..current = RouteTier.direct;
    route.succeeded(RouteTier.cdn, realtime: false);
    expect(route.current, RouteTier.direct);
    route.succeeded(RouteTier.ip, realtime: false);
    expect(route.current, RouteTier.ip);
    route.succeeded(RouteTier.cdn, realtime: true);
    expect(route.current, RouteTier.cdn);
  });

  test('后台试探：不在 CDN 时按顺序试靠前的档，通了就切回并通知；在 CDN 时不试', () async {
    final probed = <RouteTier>[];
    var cdnOk = false;
    final route = RouteState(
      store: MemoryRouteStore(),
      probe: (t) async {
        probed.add(t);
        return t == RouteTier.cdn ? cdnOk : true;
      },
    )..current = RouteTier.ip;
    final improved = <RouteTier>[];
    route.improved.listen(improved.add);
    await route.probeNow();
    expect(probed, [RouteTier.cdn, RouteTier.direct]);
    expect(route.current, RouteTier.direct);
    probed.clear();
    cdnOk = true;
    await route.probeNow();
    expect(probed, [RouteTier.cdn]);
    expect(route.current, RouteTier.cdn);
    probed.clear();
    await route.probeNow();
    expect(probed, isEmpty);
    await Future<void>.delayed(Duration.zero);
    expect(improved, [RouteTier.direct, RouteTier.cdn]);
    expect(route.reason, contains('恢复'));
  });

  test('IP 档：TCP 连到指定 IP，TLS 的 SNI 仍是直连域名', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final hello = Completer<List<int>>();
    server.listen((s) {
      final bytes = <int>[];
      s.listen((d) {
        bytes.addAll(d);
        if (!hello.isCompleted && bytes.length > 100) {
          hello.complete(bytes);
          s.destroy();
        }
      }, onError: (_) {});
    });
    final client = ipClient(ip: '127.0.0.1', port: server.port);
    final req = client
        .getUrl(Uri.parse('https://$directHost/healthz'))
        .then((r) => r.close());
    final clientHello = await hello.future.timeout(const Duration(seconds: 5));
    await expectLater(req, throwsA(anything));
    expect(String.fromCharCodes(clientHello), contains(directHost));
    client.close(force: true);
    await server.close();
  });

  test('地址换算：CDN 不通时直连、IP 两档都用直连域名', () async {
    final route = RouteState(store: MemoryRouteStore());
    final seen = <String>[];
    Future<RelaySocket> fake(Uri url, List<String> p) async {
      seen.add(url.host);
      throw _ws426;
    }

    await expectLater(
      route.run(
        (t) => fake(
          tierUrl(Uri.parse('wss://pixelstarrysky.xyz/v1/bridge/ws'), t),
          const [],
        ),
        realtime: true,
      ),
      throwsA(isA<WebSocketException>()),
    );
    expect(seen, [cdnHost, directHost, directHost]);
  });

  test('切回新线路：空闲时断开重连；有调用在等回复时等它回来', () {
    fakeAsync((async) {
      final d = FakeDesktop(secret: newPairingSecret());
      var connects = 0;
      final base = pendingPairing(d);
      final pairing = Pairing(
        deviceId: base.deviceId,
        token: base.token,
        desktopId: base.desktopId,
        desktopName: base.desktopName,
        origin: 'https://$cdnHost',
        desktopKey: base.desktopKey,
        fingerprint: base.fingerprint,
        phoneKey: base.phoneKey,
        pairedAt: 0,
        status: base.status,
        request: base.request,
      );
      final link = DesktopLink(
        pairing,
        LinkHooks(onState: (_) {}, onEvent: (_, _) {}, onPairing: (_) {}),
        connect: (u, p) {
          connects++;
          return d.accept(u, p);
        },
        random: Random(1),
      );
      link.start();
      async.elapse(Duration.zero);
      expect(link.state, LinkState.ready);
      expect(connects, 1);
      // 刚调用过（3 秒内）：先不换
      link.call('engine:sessions');
      link.rerouteWhenIdle();
      async.elapse(const Duration(seconds: 1));
      expect(connects, 1);
      async.elapse(const Duration(seconds: 6));
      expect(connects, 2);
      async.elapse(Duration.zero);
      expect(link.state, LinkState.ready);
      link.stop();
    });
  });
}
