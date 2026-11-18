// 一张图的字节 → 控件：普通图片用 Image.memory，SVG（回复里引用的 .svg，§16.3）用 flutter_svg 画。
// flutter_svg 不执行脚本、不加载外部资源，画不出来时和普通图片一样走 onError。
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_svg/flutter_svg.dart';
import 'package:material_ui/material_ui.dart';

/// 字节是不是 SVG 文本（看开头，跳过 BOM、空白、XML 声明和注释）
bool looksLikeSvg(Uint8List data) {
  final head = utf8
      .decode(
        data.length > 1024 ? data.sublist(0, 1024) : data,
        allowMalformed: true,
      )
      .replaceFirst('﻿', '')
      .trimLeft();
  if (!head.startsWith('<')) return false;
  return RegExp(r'<svg[\s>]', caseSensitive: false).hasMatch(head);
}

Widget bytesImage(
  Uint8List data, {
  BoxFit fit = BoxFit.contain,
  int? cacheWidth,
  required Widget Function() onError,
}) {
  if (looksLikeSvg(data)) {
    return SvgPicture.memory(
      data,
      fit: fit,
      errorBuilder: (_, _, _) => onError(),
    );
  }
  return Image.memory(
    data,
    fit: fit,
    cacheWidth: cacheWidth,
    errorBuilder: (_, _, _) => onError(),
  );
}
