// 发图（同网页版 apps/mobile/src/data/images.ts）：在手机上缩小、转 JPEG，整条消息放得进一帧
// （1 MB，加密前还要压缩，再留余量）。一条最多 5 张，加起来不超过 640 KB；先保清晰，放不下再降。
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';

import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'retry.dart';

/// 一条消息最多几张（和电脑一样）
const maxImages = 5;

/// 一条消息里所有图片加起来的字节上限：base64 后约 850 KB，单帧 1 MB 里还要放文字
const totalBudget = 640 * 1024;

/// 依次试的长边和 JPEG 质量
const _steps = [
  (2048, 85),
  (2048, 72),
  (1600, 72),
  (1280, 68),
  (1024, 62),
  (800, 60),
];

/// 长边缩到 maxEdge 以内（不放大），保持比例
({int width, int height}) fitSize(int width, int height, int maxEdge) {
  final longest = width > height ? width : height;
  final scale = longest <= 0 ? 1.0 : (maxEdge / longest).clamp(0.0, 1.0);
  return (
    width: (width * scale).round().clamp(1, 1 << 30),
    height: (height * scale).round().clamp(1, 1 << 30),
  );
}

/// 一共 count 张时每张最多多少字节
int budgetFor(int count) => totalBudget ~/ (count < 1 ? 1 : count);

/// 文件名换成 .jpg，太长的截掉
String jpegName(String name) {
  var base = name.replaceFirst(RegExp(r'\.[^./\\]*$'), '');
  if (base.length > 100) base = base.substring(0, 100);
  return '${base.isEmpty ? 'image' : base}.jpg';
}

class ImageTooLarge implements Exception {
  @override
  String toString() => L(
    '图片太大，压缩后还是发不了，少选几张试试',
    'Images are too large to send even after compression. Try selecting fewer.',
  );
}

/// 把一张图压成不超过 budget 字节的 JPEG（packages/protocol 的 ImageAttachment）
Future<Json> compressImage(XFile file, int budget) async {
  final bytes = await file.readAsBytes();
  int width, height;
  try {
    final codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    width = frame.image.width;
    height = frame.image.height;
    frame.image.dispose();
  } catch (_) {
    throw Exception(
      L(
        '「${file.name}」打不开，换一张试试',
        'Couldn\'t open “${file.name}”. Try another one.',
      ),
    );
  }
  for (final (edge, quality) in _steps) {
    final size = fitSize(width, height, edge);
    final out = await FlutterImageCompress.compressWithList(
      bytes,
      minWidth: size.width,
      minHeight: size.height,
      quality: quality,
      format: CompressFormat.jpeg,
    );
    if (out.length > budget) continue;
    return {
      'id': uuid(),
      'name': jpegName(file.name),
      'mediaType': 'image/jpeg',
      'bytes': out.length,
      'width': size.width,
      'height': size.height,
      'dataBase64': base64Encode(out),
    };
  }
  throw ImageTooLarge();
}

/// 输入框里待发的图片：选了就压缩，压完放进来
class PendingImages extends ChangeNotifier {
  PendingImages({this.compress = compressImage});
  final Future<Json> Function(XFile file, int budget) compress;

  final List<Json> images = [];
  bool busy = false;
  String? error;

  Future<void> add(List<XFile> files) async {
    error = null;
    final room = maxImages - images.length;
    if (room <= 0) {
      error = L('一条消息最多 $maxImages 张图片', 'Up to $maxImages images per message');
      notifyListeners();
      return;
    }
    final chosen = files.take(room).toList();
    if (files.length > room) {
      error = L(
        '一条消息最多 $maxImages 张图片，多出来的没有加',
        'Up to $maxImages images per message. The extra ones weren\'t added.',
      );
    }
    if (chosen.isEmpty) return;
    busy = true;
    notifyListeners();
    try {
      // 已有的图按当时的预算压过了；新加的按加上之后的总张数分预算
      final used = images.fold<int>(0, (n, i) => n + (i['bytes'] as int));
      final a = budgetFor(images.length + chosen.length);
      final b = (totalBudget - used) ~/ chosen.length;
      final each = a < b ? a : b;
      if (each < 40 * 1024) {
        throw Exception(
          L('图片放不下了，先删掉几张再加', 'No room for more images. Remove some first.'),
        );
      }
      for (final f in chosen) {
        images.add(await compress(f, each));
      }
    } catch (e) {
      error = '$e'.replaceFirst('Exception: ', '');
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  void remove(String id) {
    images.removeWhere((i) => i['id'] == id);
    notifyListeners();
  }

  /// 编辑重发：回退带回来的图片放回待发列表（网关已按手机发图的上限筛过）；返回放进来的 id
  List<String> restore(List<Json> list) {
    final added = <String>[];
    for (final i in list) {
      final id = str(i['id']);
      if (id == null || str(i['dataBase64']) == null) continue;
      final full = images.length >= maxImages;
      if (full || images.any((x) => x['id'] == id)) continue;
      images.add(i);
      added.add(id);
    }
    error = null;
    notifyListeners();
    return added;
  }

  /// 发出去之后去掉这几张（发送中新加的留着）
  void discard(List<String> ids) {
    images.removeWhere((i) => ids.contains(i['id']));
    error = null;
    notifyListeners();
  }
}

/// 图片的字节（缩略图用）
Uint8List imageBytes(Json image) =>
    base64Decode(str(image['dataBase64']) ?? '');
