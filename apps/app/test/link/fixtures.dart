// 读 test/fixtures/ 下 TS 导出的共用样例（scripts/export-app-fixtures.mjs 生成，不手改）
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/link/link.dart';

/// flutter test 的工作目录是 apps/app
Map<String, dynamic> fixture(String name) =>
    jsonDecode(File('test/fixtures/$name').readAsStringSync())
        as Map<String, dynamic>;

/// 样例里的一组用例
List<Map<String, dynamic>> cases(Map<String, dynamic> f, String key) =>
    (f[key] as List).cast<Map<String, dynamic>>();

Uint8List hex(String h) => Uint8List.fromList([
  for (var i = 0; i < h.length; i += 2)
    int.parse(h.substring(i, i + 2), radix: 16),
]);

Matcher throwsLink(String code) =>
    throwsA(isA<LinkException>().having((e) => e.message, 'message', code));

/// 让出一轮事件循环（同 TS 测试里的 setTimeout 0）
Future<void> settle() => Future<void>.delayed(Duration.zero);
