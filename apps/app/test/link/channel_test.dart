import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/link/link.dart';

import 'fixtures.dart';

HandshakeResult keys(String send, String receive) => HandshakeResult(
  send: CipherState(hex(send)),
  receive: CipherState(hex(receive)),
  hash: Uint8List(32),
  remoteStatic: Uint8List(32),
);

/// 一个收消息的通道：记下收到的值和错误
({SecureChannel channel, List<Object?> values, List<Object> errors}) receiver(
  HandshakeResult k, {
  Codec? codec = deflateRawCodec,
}) {
  final values = <Object?>[], errors = <Object>[];
  final channel = SecureChannel(
    k,
    output: (_) {},
    onMessage: values.add,
    onError: errors.add,
    codec: codec,
  );
  return (channel: channel, values: values, errors: errors);
}

/// 一轮事件循环交一帧（同 TS 导出样例时的喂法，也同 WebSocket 一条消息一个事件）
Future<void> feed(SecureChannel channel, Iterable<String> frames) async {
  for (final f in frames) {
    final d = decodeFrame(hex(f));
    expect(d.type, FrameType.data);
    channel.receive(d.body);
    await settle();
  }
}

String errorCode(Object e) => e is LinkException ? e.message : '$e';

/// 记下通道交给解压的上限：16 MB 是两端共用的协议上限，要和样例里 TS 用的一致
class RecordingCodec implements Codec {
  final seen = <int>{};

  @override
  Uint8List deflate(Uint8List bytes) => deflateRawCodec.deflate(bytes);

  @override
  Uint8List inflate(Uint8List bytes, int maxBytes) {
    seen.add(maxBytes);
    return deflateRawCodec.inflate(bytes, maxBytes);
  }
}

void main() {
  final c = fixture('link_sessions.json')['channel'] as Map<String, dynamic>;
  final phone = c['phone'] as Map<String, dynamic>;
  final phoneSend = phone['send_key'] as String;
  final phoneReceive = phone['receive_key'] as String;
  HandshakeResult phoneKeys() => keys(phoneSend, phoneReceive);
  HandshakeResult desktopKeys() => keys(phoneReceive, phoneSend);

  group('frames sent by TS', () {
    for (final (name, k, key) in [
      ('to_phone', phoneKeys, phoneReceive),
      ('to_desktop', desktopKeys, phoneSend),
    ]) {
      test('$name decode to the same values', () async {
        final messages = cases(c, name);
        final codec = RecordingCodec();
        final r = receiver(k(), codec: codec);
        await feed(r.channel, messages.map((m) => m['frame'] as String));
        expect(r.errors, isEmpty);
        expect(r.values, messages.map((m) => m['value']).toList());
        expect(codec.seen.toList(), c['inflated_limit']);
        // 压缩与否和 TS 一致（超过 1 KB 才压缩，按字节算）
        final state = CipherState(hex(key));
        for (final m in messages) {
          final plain = state.open(decodeFrame(hex(m['frame'])).body);
          expect(
            plain[0] == 1,
            m['compressed'],
            reason: jsonEncode(m['value']),
          );
        }
      });
    }
  });

  group('frames sent by Dart', () {
    // 不压缩的帧和 TS 逐字节相同；压缩的帧字节可以不同（zlib 实现不同），只比解出来的值
    for (final (name, sender, peer, key) in [
      ('to_phone', desktopKeys, phoneKeys, phoneReceive),
      ('to_desktop', phoneKeys, desktopKeys, phoneSend),
    ]) {
      test('$name match TS', () async {
        final messages = cases(c, name);
        final frames = <Uint8List>[];
        final channel = SecureChannel(
          sender(),
          output: frames.add,
          onMessage: (_) {},
          onError: (e) => fail('$e'),
          codec: deflateRawCodec,
        );
        for (final m in messages) {
          await channel.send(m['value']);
        }
        expect(frames, hasLength(messages.length));
        final state = CipherState(hex(key));
        for (var i = 0; i < messages.length; i++) {
          final m = messages[i];
          final plain = state.open(decodeFrame(frames[i]).body);
          expect(
            plain[0] == 1,
            m['compressed'],
            reason: jsonEncode(m['value']),
          );
          // 压缩的交给 Node zlib（电脑端的解压）解：dart:io 解压很宽松，缺结尾块、截断的流它也收，
          // 只靠 Dart 自己往返查不出电脑端解不开的压缩数据
          if (plain[0] == 1) {
            final r = Process.runSync('node', [
              '-e',
              "process.stdout.write(require('zlib').inflateRawSync(Buffer.from(process.argv[1], 'hex')).toString('hex'))",
              toHex(plain.sublist(1)),
            ]);
            expect(r.exitCode, 0, reason: '${r.stderr}');
            expect(r.stdout, toHex(encodeJson(m['value'])));
          }
          if (m['compressed'] == false) {
            expect(toHex(frames[i]), m['frame']);
          }
        }
        final r = receiver(peer());
        await feed(r.channel, frames.map(toHex));
        expect(r.errors, isEmpty);
        expect(r.values, messages.map((m) => m['value']).toList());
      });
    }
  });

  test('bad frames break the channel once, like TS', () async {
    for (final f in cases(c, 'failures')) {
      final r = receiver(phoneKeys());
      await feed(r.channel, (f['frames'] as List).cast<String>());
      expect(r.values, f['values'], reason: f['name']);
      expect(r.errors.map(errorCode), [f['error']], reason: f['name']);
      expect(r.channel.closed, isTrue, reason: f['name']);
    }
  });

  group('Dart channel', () {
    ({
      SecureChannel phone,
      List<Object?> got,
      List<Object> errors,
      List<Uint8List> wire,
      SecureChannel desktop,
    })
    pair({Codec? codec = deflateRawCodec}) {
      final p = generateKeypair(), d = generateKeypair();
      final i = Initiator(local: p, remote: d.publicKey, prologue: prologue);
      final r = Responder(local: d, remote: p.publicKey, prologue: prologue);
      r.readMessage1(i.writeMessage1());
      final w2 = r.writeMessage2();
      final phoneKeys = i.readMessage2(w2.message).result;
      final got = <Object?>[], errors = <Object>[], wire = <Uint8List>[];
      final desktop = SecureChannel(
        w2.result,
        output: (_) {},
        onMessage: got.add,
        onError: errors.add,
        codec: codec,
      );
      final phone = SecureChannel(
        phoneKeys,
        output: (f) {
          wire.add(f);
          final d = decodeFrame(f);
          expect(d.type, FrameType.data);
          desktop.receive(d.body);
        },
        onMessage: (_) {},
        onError: (_) {},
        codec: codec,
      );
      return (
        phone: phone,
        got: got,
        errors: errors,
        wire: wire,
        desktop: desktop,
      );
    }

    test('keeps order across compressed and plain messages', () async {
      final p = pair();
      final big = {'text': '压缩 😀 ' * 2000};
      await Future.wait([
        p.phone.send({'n': 1}),
        p.phone.send(big),
        p.phone.send({'n': 3}),
      ]);
      await settle();
      expect(p.got, [
        {'n': 1},
        big,
        {'n': 3},
      ]);
      expect(p.errors, isEmpty);
      expect(() => utf8.decode(p.wire[1]), throwsFormatException);
    });

    test('breaks the channel on a replayed frame and reports once', () async {
      final p = pair();
      await p.phone.send({'n': 1});
      await settle();
      p.desktop.receive(decodeFrame(p.wire[0]).body);
      await settle();
      p.desktop.receive(decodeFrame(p.wire[0]).body);
      expect(p.errors.map(errorCode), ['LINK_DECRYPT_FAILED']);
      expect(p.desktop.closed, isTrue);
      await p.phone.send({'n': 2});
      await settle();
      expect(p.got, [
        {'n': 1},
      ]);
    });

    test('fails one oversized message without breaking the channel', () async {
      final p = pair(codec: null);
      await expectLater(
        p.phone.send({'text': 'y' * (2 * 1024 * 1024)}),
        throwsLink('LINK_FRAME_TOO_LARGE'),
      );
      await p.phone.send({'ok': true});
      await settle();
      expect(p.phone.closed, isFalse);
      expect(p.wire, hasLength(1));
      expect(p.got, [
        {'ok': true},
      ]);
    });

    test(
      'a failed output breaks the channel and later sends fail with it',
      () async {
        final k = phoneKeys();
        final errors = <Object>[];
        final channel = SecureChannel(
          k,
          output: (_) => throw const LinkException('SOCKET_CLOSED'),
          onMessage: (_) {},
          onError: errors.add,
        );
        await expectLater(channel.send({'n': 1}), throwsLink('SOCKET_CLOSED'));
        await settle();
        expect(channel.closed, isTrue);
        await expectLater(channel.send({'n': 2}), throwsLink('SOCKET_CLOSED'));
        expect(errors.map(errorCode), ['SOCKET_CLOSED']);
      },
    );

    test('rejects a compressed frame when there is no codec', () async {
      final frames = <Uint8List>[];
      final compressing = SecureChannel(
        desktopKeys(),
        output: frames.add,
        onMessage: (_) {},
        onError: (_) {},
        codec: deflateRawCodec,
      );
      await compressing.send({'t': 'x' * 2000});
      final r = receiver(phoneKeys(), codec: null);
      await feed(r.channel, frames.map(toHex));
      expect(r.errors.map(errorCode), ['LINK_BAD_FRAME']);
    });
  });

  group('DeflateRawCodec', () {
    test('round-trips and limits the inflated size', () {
      final data = Uint8List.fromList(utf8.encode('{"t":"${'内容' * 5000}"}'));
      final packed = deflateRawCodec.deflate(data);
      expect(packed.length, lessThan(data.length));
      expect(deflateRawCodec.inflate(packed, data.length), data);
      expect(
        () => deflateRawCodec.inflate(packed, data.length - 1),
        throwsLink('LINK_FRAME_TOO_LARGE'),
      );
    });

    test('allows exactly 16 MB and stops right after', () {
      const limit = 16 * 1024 * 1024;
      final packed = deflateRawCodec.deflate(Uint8List(limit + 1));
      expect(
        () => deflateRawCodec.inflate(packed, limit),
        throwsLink('LINK_FRAME_TOO_LARGE'),
      );
      expect(deflateRawCodec.inflate(packed, limit + 1).length, limit + 1);
    });

    test('reports corrupt data as LINK_BAD_FRAME', () {
      expect(
        () => deflateRawCodec.inflate(Uint8List.fromList([255, 255, 255]), 100),
        throwsLink('LINK_BAD_FRAME'),
      );
    });
  });
}
