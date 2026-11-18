import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/app/version.dart';

void main() {
  test('appVersion、appBuild 和 pubspec.yaml 一致', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final m = RegExp(
      r'^version:\s*([^+\s]+)\+(\d+)',
      multiLine: true,
    ).firstMatch(pubspec);
    expect(m?.group(1), appVersion);
    expect(int.parse(m!.group(2)!), appBuild);
  });
}
