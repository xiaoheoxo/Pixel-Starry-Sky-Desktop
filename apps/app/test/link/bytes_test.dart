import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/link/link.dart';

import 'fixtures.dart';

void main() {
  final f = fixture('link_bytes.json');

  test('base64url matches TS for every length', () {
    for (final c in cases(f, 'base64url')) {
      expect(toBase64Url(hex(c['hex'])), c['text']);
      expect(toHex(fromBase64Url(c['text'])), c['hex']);
    }
  });

  test('base64url decoding accepts and rejects the same text as TS', () {
    for (final c in cases(f, 'base64url_decode')) {
      final text = c['text'] as String;
      if (c.containsKey('error')) {
        expect(() => fromBase64Url(text), throwsLink(c['error']), reason: text);
      } else {
        expect(toHex(fromBase64Url(text)), c['hex'], reason: text);
      }
    }
  });

  test('utf8 decodes strictly and drops one leading BOM like TextDecoder', () {
    for (final c in cases(f, 'utf8_decode')) {
      final bytes = hex(c['hex']);
      if (c['invalid'] == true) {
        expect(() => fromUtf8(bytes), throwsFormatException, reason: c['hex']);
      } else {
        expect(fromUtf8(bytes), c['text'], reason: c['hex']);
      }
    }
  });

  test('utf8 encodes lone surrogates as U+FFFD like TextEncoder', () {
    for (final c in cases(f, 'utf8_encode')) {
      expect(toHex(toUtf8(c['text'])), c['hex']);
    }
  });

  test('equalBytes compares length and content', () {
    expect(equalBytes([1, 2, 3], [1, 2, 3]), isTrue);
    expect(equalBytes([1, 2, 3], [1, 2, 4]), isFalse);
    expect(equalBytes([1, 2], [1, 2, 3]), isFalse);
    expect(equalBytes([], []), isTrue);
    expect(
      toHex(
        concat([
          [],
          [1],
          [2, 255],
        ]),
      ),
      '0102ff',
    );
  });
}
