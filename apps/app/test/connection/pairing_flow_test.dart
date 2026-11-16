// 配对链接解析、中转节点、换令牌、配对记录存取（用例照网页版 offer.test.ts、nodes.test.ts）
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/connection/connections.dart';
import 'package:pixelsky_app/connection/nodes.dart';
import 'package:pixelsky_app/connection/offer.dart';
import 'package:pixelsky_app/connection/pair.dart';
import 'package:pixelsky_app/connection/pairing.dart';
import 'package:pixelsky_app/connection/storage.dart';
import 'package:pixelsky_app/link/link.dart';

import 'fake_desktop.dart';

final _now = DateTime.fromMillisecondsSinceEpoch(1_800_000_000_000);
final _key = toBase64Url(generateKeypair().publicKey);

PairingOffer make({String? code = 'code-1', num? expires, String? relay}) =>
    PairingOffer(
      relay: relay ?? 'wss://auth.example/relay',
      desktop: 'desk-1',
      key: _key,
      secret: 'B' * 22,
      name: '我的电脑',
      expires: expires ?? _now.millisecondsSinceEpoch + 5 * 60000,
      code: code,
    );
const web = 'https://auth.example/m/';

Matcher throwsOffer(OfferError e) =>
    throwsA(isA<OfferException>().having((x) => x.error, 'error', e));

class FakeApi implements BridgeApi {
  FakeApi({this.nodes, this.status = 200, this.body});
  final Object? nodes;
  final int status;
  final Object? body;
  final gets = <Uri>[];
  final posts = <(Uri, Object)>[];

  @override
  Future<Object?> getJson(Uri url) async {
    gets.add(url);
    if (nodes is Exception) throw nodes as Exception;
    return nodes;
  }

  @override
  Future<({int status, Object? body})> postJson(Uri url, Object body) async {
    posts.add((url, body));
    return (
      status: status,
      body:
          this.body ??
          {'deviceId': 'ph1', 'token': 'tok', 'desktopId': 'desk-1'},
    );
  }
}

void main() {
  group('findOffer', () {
    test('网页链接和 pixelsky:// 链接', () {
      expect(
        findOffer(encodeOffer(make(), web), now: _now).desktopName,
        '我的电脑',
      );
      expect(findOffer(encodeOffer(make()), now: _now).raw.desktop, 'desk-1');
    });
    test('链接夹在文字、换行、标点中间', () {
      final link = encodeOffer(make(), web);
      expect(
        findOffer('快来连我：\n  $link。\n（5 分钟内有效）', now: _now).raw.code,
        'code-1',
      );
      expect(findOffer('<$link>,', now: _now).raw.code, 'code-1');
    });
    test('百分号编码的链接', () {
      expect(
        findOffer(
          Uri.encodeComponent(encodeOffer(make(), web)),
          now: _now,
        ).raw.code,
        'code-1',
      );
    });
    test('聊天软件折了行的链接补回去', () {
      final link = encodeOffer(make(), web);
      final cut = link.length - 40;
      expect(
        findOffer(
          '${link.substring(0, cut)}\n${link.substring(cut)}',
          now: _now,
        ).raw.code,
        'code-1',
      );
    });
    test('粘了几个链接时取能用的', () {
      final good = encodeOffer(make(), web);
      final old = encodeOffer(make(expires: 1, code: 'old'), web);
      expect(findOffer('$old  $good', now: _now).raw.code, 'code-1');
      expect(
        findOffer('https://x.example/m/#pair=abc  $good', now: _now).raw.code,
        'code-1',
      );
    });
    test('说清哪里不对', () {
      expect(() => findOffer('你好 world'), throwsOffer(OfferError.notFound));
      expect(() => findOffer(''), throwsOffer(OfferError.notFound));
      expect(
        () => findOffer('https://x.example/m/#pair=abc'),
        throwsOffer(OfferError.invalid),
      );
      expect(
        () => findOffer('https://x.example/m/#pair='),
        throwsOffer(OfferError.incomplete),
      );
      expect(
        () => findOffer(encodeOffer(make(expires: 1), web), now: _now),
        throwsOffer(OfferError.expired),
      );
    });
    test('主站：网页链接取来源，pixelsky:// 取中转对应的地址', () {
      expect(
        findOffer(encodeOffer(make(), web), now: _now).origin,
        'https://auth.example',
      );
      expect(
        findOffer(encodeOffer(make()), now: _now).origin,
        'https://auth.example',
      );
    });
  });

  group('中转节点', () {
    const origin = 'https://cloud.example.test';
    final nodes = {
      'nodes': [
        {
          'name': '优质 1',
          'url': 'wss://p1.example.test/v1/bridge/ws',
          'premium': true,
        },
        {'name': '只写主机', 'url': 'wss://p2.example.test', 'premium': 'yes'},
        {'name': '坏的', 'url': 'https://p3.example.test'},
        {'name': '带密码', 'url': 'wss://u:p@p4.example.test'},
        'junk',
      ],
    };
    test('parseNodes：只留 ws / wss，只写主机的补上路径', () {
      final list = parseNodes(nodes);
      expect(
        [for (final n in list) (n.name, n.url, n.premium)],
        [
          ('优质 1', 'wss://p1.example.test/v1/bridge/ws', true),
          ('只写主机', 'wss://p2.example.test/v1/bridge/ws', false),
        ],
      );
      expect(parseNodes(null), isEmpty);
      expect(parseNodes({'nodes': 'x'}), isEmpty);
      expect(
        wsUrl('wss://a.test/v1/bridge/ws?role=desktop'),
        'wss://a.test/v1/bridge/ws',
      );
      expect(wsUrl('javascript:alert(1)'), isNull);
    });
    test('matchNode 按来源比', () {
      final list = parseNodes(nodes);
      expect(
        matchNode('wss://p2.example.test/other', list),
        'wss://p2.example.test/v1/bridge/ws',
      );
      expect(matchNode('wss://evil.test/v1/bridge/ws', list), isNull);
      expect(
        matchNode('wss://p1.example.test:8443/v1/bridge/ws', list),
        isNull,
      );
      expect(matchNode('ws://p1.example.test/v1/bridge/ws', list), isNull);
      expect(matchNode(null, list), isNull);
    });
    test('pickNode', () async {
      final api = FakeApi(nodes: nodes);
      expect(
        await pickNode(
          'wss://p1.example.test/v1/bridge/ws',
          origin,
          api.getJson,
        ),
        'wss://p1.example.test/v1/bridge/ws',
      );
      expect(api.gets.single.toString(), '$origin/v1/bridge/nodes');
      expect(
        await pickNode('wss://evil.test/v1/bridge/ws', origin, api.getJson),
        isNull,
      );
      final broken = FakeApi(nodes: Exception('offline'));
      expect(
        await pickNode(
          'wss://p1.example.test/v1/bridge/ws',
          origin,
          broken.getJson,
        ),
        isNull,
      );
      final same = FakeApi(nodes: nodes);
      expect(
        await pickNode(
          'wss://cloud.example.test/v1/bridge/ws',
          origin,
          same.getJson,
        ),
        isNull,
      );
      expect(await pickNode(null, origin, same.getJson), isNull);
      expect(same.gets, isEmpty);
    });
  });

  group('换令牌', () {
    test('总在主站兑换；节点在主站列表里就记下来，实时连接走节点', () async {
      final offer = findOffer(
        encodeOffer(make(relay: 'wss://p1.example.test/v1/bridge/ws'), web),
        now: _now,
      );
      final api = FakeApi(
        nodes: {
          'nodes': [
            {'name': 'p1', 'url': 'wss://p1.example.test/v1/bridge/ws'},
          ],
        },
      );
      final p = await pairWithOffer(offer, '我的手机', api, now: _now);
      expect(
        api.posts.single.$1.toString(),
        'https://auth.example/v1/bridge/pair',
      );
      expect(api.posts.single.$2, {'code': 'code-1', 'name': '我的手机'});
      expect(p.origin, 'https://auth.example');
      expect(p.node, 'wss://p1.example.test/v1/bridge/ws');
      expect(
        p.relayUrl.toString(),
        'wss://p1.example.test/v1/bridge/ws?role=phone',
      );
      expect(p.status, PairingStatus.pending);
      expect(p.request?.name, '我的手机');
    });
    test('没跟随节点：连主站的 /v1/bridge/ws', () async {
      final offer = findOffer(encodeOffer(make(), web), now: _now);
      final p = await pairWithOffer(offer, '手机', FakeApi(), now: _now);
      expect(p.node, isNull);
      expect(
        p.relayUrl.toString(),
        'wss://auth.example/v1/bridge/ws?role=phone',
      );
    });
    test('错误码', () async {
      final offer = findOffer(encodeOffer(make(), web), now: _now);
      Future<PairError> fail(FakeApi api) async {
        try {
          await pairWithOffer(offer, '手机', api, now: _now);
        } on PairException catch (e) {
          return e.error;
        }
        throw StateError('没有失败');
      }

      expect(
        await fail(FakeApi(status: 400, body: {'error': 'invalid_code'})),
        PairError.invalidCode,
      );
      expect(
        await fail(FakeApi(status: 409, body: {'error': 'too_many_devices'})),
        PairError.tooManyDevices,
      );
      expect(await fail(FakeApi(status: 500, body: {})), PairError.failed);
      final noCode = findOffer(encodeOffer(make(code: null), web), now: _now);
      expect(
        () => pairWithOffer(noCode, '手机', FakeApi()),
        throwsA(
          isA<PairException>().having(
            (e) => e.error,
            'error',
            PairError.notCloud,
          ),
        ),
      );
    });
  });

  group('配对记录', () {
    test('JSON 往返；缺关键字段的丢掉', () {
      final p = Pairing(
        deviceId: 'ph',
        token: 't',
        desktopId: 'd',
        desktopName: 'n',
        origin: 'https://o',
        node: 'wss://n/v1/bridge/ws',
        desktopKey: 'k',
        fingerprint: 'f',
        phoneKey: 'pk',
        pairedAt: 1,
        status: PairingStatus.pending,
        request: const PairRequest(key: 'a', name: 'b', mac: 'c'),
      );
      final back = Pairing.fromJson(p.toJson())!;
      expect(back.toJson(), p.toJson());
      expect(Pairing.fromJson({'deviceId': 'x'}), isNull);
      expect(Pairing.fromJson('x'), isNull);
    });

    test('Connections：同一台电脑重新配对时换掉旧记录；忘掉后当前电脑换成剩下的', () async {
      final d = FakeDesktop(secret: newPairingSecret(), online: false);
      final store = MemoryPairingStore();
      final c = Connections(store: store, connect: d.accept);
      await c.load();
      Pairing p(String id, String desktop) => Pairing(
        deviceId: id,
        token: 't',
        desktopId: desktop,
        desktopName: desktop,
        origin: 'https://o',
        desktopKey: _key,
        fingerprint: '',
        phoneKey: toBase64Url(generateKeypair().privateKey),
        pairedAt: 0,
        status: PairingStatus.paired,
      );
      await c.add(p('a', 'd1'));
      await c.add(p('b', 'd2'));
      await c.add(p('c', 'd1'));
      expect([for (final x in c.pairings) x.deviceId], ['b', 'c']);
      expect(c.active?.deviceId, 'c');
      await c.forget('c');
      expect(c.active?.deviceId, 'b');
      expect([for (final x in await store.load()) x.deviceId], ['b']);
      c.dispose();
    });
  });
}
