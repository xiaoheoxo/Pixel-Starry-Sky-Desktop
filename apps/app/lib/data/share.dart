// 从别的 App 分享进来的内容（第三批 D2，docs/mobile-app.md §15.8）：文字、链接拼成一段放进输入框，
// 图片按路径交给输入框的待发图片（照常压缩、超过上限的不加）。不自动发。
import 'tasks.dart';

class SharedContent {
  const SharedContent({this.text = '', this.imagePaths = const []});
  final String text;
  final List<String> imagePaths;

  bool get isEmpty => text.isEmpty && imagePaths.isEmpty;
}

/// 分享过来的一批（type：text / url / image / video / file）合成一份；视频和别的文件不收
SharedContent sharedContent(List<({String type, String path})> items) {
  final texts = <String>[];
  final images = <String>[];
  for (final i in items) {
    final v = i.path.trim();
    if (v.isEmpty) continue;
    switch (i.type) {
      case 'text' || 'url':
        if (!texts.contains(v)) texts.add(v);
      case 'image':
        images.add(v);
    }
  }
  return SharedContent(text: texts.join('\n'), imagePaths: images);
}

/// 「发到哪个对话」列出的会话：等你处理的在前，其余按置顶、时间，最多 8 个
List<SessionSummary> shareCandidates(List<SessionSummary> sessions) {
  final list = sessionList(sessions, 8);
  return [...list.waiting, ...list.rest].take(8).toList();
}
