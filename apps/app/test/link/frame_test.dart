import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/link/link.dart';

import 'fixtures.dart';

void main() {
  final f = fixture('link_frames.json');

  test('constants and frame types match TS', () {
    final c = f['constants'] as Map<String, dynamic>;
    expect(maxFrame, c['max_frame']);
    expect(maxPayload, c['max_payload']);
    final types = c['types'] as Map<String, dynamic>;
    expect(types.values.toList(), FrameType.values.map((t) => t.value));
    // TS 的名字是 Handshake1、PairResult，Dart 是 handshake1、pairResult
    expect(
      types.keys.map((k) => k[0].toLowerCase() + k.substring(1)),
      FrameType.values.map((t) => t.name),
    );
  });

  test('encodes every frame type like TS', () {
    for (final c in cases(f, 'encode')) {
      final type = FrameType.values.firstWhere((t) => t.value == c['type']);
      expect(toHex(encodeFrame(type, hex(c['body']))), c['frame']);
    }
    for (final c in cases(f, 'encode_large')) {
      final body = Uint8List(c['length'] as int)..fillRange(0, c['length'], 7);
      if (c.containsKey('error')) {
        expect(() => encodeFrame(FrameType.data, body), throwsLink(c['error']));
      } else {
        final frame = encodeFrame(FrameType.data, body);
        expect(frame.length, body.length + 1);
        expect(frame[0], FrameType.data.value);
      }
    }
  });

  test('decodes and rejects frames like TS', () {
    for (final c in cases(f, 'decode')) {
      final frame = hex(c['frame']);
      if (c.containsKey('error')) {
        expect(
          () => decodeFrame(frame),
          throwsLink(c['error']),
          reason: c['frame'],
        );
      } else {
        final d = decodeFrame(frame);
        expect(d.type.value, c['type']);
        expect(toHex(d.body), c['body']);
      }
    }
    for (final c in cases(f, 'decode_large')) {
      final n = c['length'] as int;
      final frame = Uint8List(n)
        ..fillRange(0, n, 7)
        ..[0] = FrameType.data.value;
      if (c.containsKey('error')) {
        expect(() => decodeFrame(frame), throwsLink(c['error']));
      } else {
        expect(decodeFrame(frame).body.length, n - 1);
      }
    }
  });

  test('decodeJson accepts and rejects the same bytes as TS', () {
    for (final c in cases(f, 'json_decode')) {
      final bytes = hex(c['hex']);
      final shown = utf8.decode(bytes, allowMalformed: true);
      if (c.containsKey('error')) {
        expect(() => decodeJson(bytes), throwsLink(c['error']), reason: shown);
      } else {
        expect(decodeJson(bytes), c['value'], reason: shown);
      }
    }
  });

  test('encodeJson writes the same bytes as JSON.stringify', () {
    for (final c in cases(f, 'json_encode')) {
      expect(toHex(encodeJson(c['value'])), c['hex'], reason: '${c['value']}');
    }
  });
}
