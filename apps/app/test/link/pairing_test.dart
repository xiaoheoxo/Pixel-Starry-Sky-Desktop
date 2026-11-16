import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/link/link.dart';

import 'fixtures.dart';

PairingOffer offerFrom(Map<String, dynamic> o) => PairingOffer(
  v: o['v'],
  relay: o['relay'],
  desktop: o['desktop'],
  key: o['key'],
  secret: o['secret'],
  name: o['name'],
  expires: o['expires'],
  code: o['code'],
);

/// 只比 App 认的字段（TS 的 decodeOffer 原样返回对象，多出的字段也带着；Dart 丢掉）
const offerKeys = [
  'v',
  'relay',
  'desktop',
  'key',
  'secret',
  'name',
  'expires',
  'code',
];

void main() {
  final f = fixture('link_pairing.json');
  final offer = offerFrom(f['offer']);
  final phoneKey = hex((f['keys'] as Map)['phone']);

  test('constants match TS', () {
    final c = f['constants'] as Map<String, dynamic>;
    expect(linkVersion, c['link_version']);
    expect(utf8.decode(prologue), (c['prologue'] as Map)['text']);
    expect(toHex(prologue), (c['prologue'] as Map)['hex']);
    expect(bridgeProtocol, c['bridge_protocol']);
    final bp = c['bridge_protocols'] as Map<String, dynamic>;
    expect(bridgeProtocols(bp['token']), bp['protocols']);
    expect(PairStatus.values.map((s) => s.wire), c['pair_statuses']);
    expect(fromBase64Url(newPairingSecret()).length, c['pairing_secret_bytes']);
  });

  test('encodes the QR text like TS', () {
    for (final c in cases(f, 'encode')) {
      expect(
        encodeOffer(offerFrom(c['offer']), c['web']),
        c['text'],
        reason: '${c['web']}',
      );
    }
  });

  test('decodes and rejects QR text like TS', () {
    for (final c in cases(f, 'decode')) {
      final text = c['text'] as String;
      if (c.containsKey('error')) {
        expect(
          () => decodeOffer(text),
          throwsLink(c['error']),
          reason: c['name'],
        );
        continue;
      }
      final got = decodeOffer(text).toJson();
      final want = c['offer'] as Map<String, dynamic>;
      for (final k in offerKeys) {
        expect(got[k], want[k], reason: '${c['name']} $k');
      }
    }
  });

  test('builds the same pairing requests as TS', () {
    for (final c in cases(f, 'pair_requests')) {
      final r = pairRequest(offer, phoneKey, c['name']);
      expect(r.toJson(), c['request'], reason: jsonEncode(c['name']));
    }
  });

  test('accepts and rejects the same pairing requests as TS', () {
    for (final c in cases(f, 'verify')) {
      final got = verifyPairRequest(
        c['raw'],
        c['secret'],
        hex(c['desktop_public']),
      );
      final want = c['result'] as Map<String, dynamic>?;
      if (want == null) {
        expect(got, isNull, reason: c['name']);
      } else {
        expect(got, isNotNull, reason: c['name']);
        expect(toHex(got!.publicKey), want['public_key'], reason: c['name']);
        expect(got.name, want['name'], reason: c['name']);
      }
    }
  });

  test('fingerprints and cloud API address match TS', () {
    for (final c in cases(f, 'fingerprints')) {
      expect(fingerprint(hex(c['public_key'])), c['fingerprint']);
    }
    for (final c in cases(f, 'bridge_api_base')) {
      final relay = c['relay'] as String;
      if (c.containsKey('error')) {
        expect(
          () => bridgeApiBase(relay),
          throwsLink(c['error']),
          reason: relay,
        );
      } else {
        expect(bridgeApiBase(relay), c['base'], reason: relay);
      }
    }
  });

  test('a Dart request verifies with the QR secret only', () {
    final desk = generateKeypair(), phone = generateKeypair();
    final o = PairingOffer(
      relay: 'wss://auth.example/v1/bridge/ws',
      desktop: 'd-1',
      key: toBase64Url(desk.publicKey),
      secret: newPairingSecret(),
      name: '我的电脑',
      expires: 1800000000000,
    );
    expect(decodeOffer(encodeOffer(o)).toJson(), o.toJson());
    final request = pairRequest(o, phone.publicKey, ' 小米 14\u0007 ');
    expect(request.name, '小米 14');
    // 经 JSON 发出去再读回来，同真实的配对帧
    final raw = jsonDecode(jsonEncode(request.toJson()));
    final ok = verifyPairRequest(raw, o.secret, desk.publicKey);
    expect(ok?.name, '小米 14');
    expect(ok?.publicKey, phone.publicKey);
    expect(verifyPairRequest(raw, newPairingSecret(), desk.publicKey), isNull);
    expect(
      verifyPairRequest(raw, o.secret, generateKeypair().publicKey),
      isNull,
    );
  });

  test('parses pair statuses and ignores unknown ones', () {
    expect(PairStatus.parse('handshake_failed'), PairStatus.handshakeFailed);
    expect(PairStatus.parse('accepted'), PairStatus.accepted);
    expect(PairStatus.parse('nope'), isNull);
    expect(PairStatus.parse(null), isNull);
  });
}
