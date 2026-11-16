import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/ui/markdown.dart';

void main() {
  group('splitBlocks：按空行拆块', () {
    test('普通段落按空行拆，连续空行不产生空块', () {
      expect(splitBlocks('第一段\n\n第二段\n\n\n第三段'), ['第一段', '第二段', '第三段']);
      expect(splitBlocks(''), isEmpty);
      expect(splitBlocks('\n\n'), isEmpty);
    });

    test('代码块里的空行不拆，围栏前后照常拆', () {
      const text = '看这段：\n\n```dart\nfinal a = 1;\n\nfinal b = 2;\n```\n\n完了';
      expect(splitBlocks(text), [
        '看这段：',
        '```dart\nfinal a = 1;\n\nfinal b = 2;\n```',
        '完了',
      ]);
    });

    test('~~~ 围栏和缩进的围栏也认；里面的 ``` 不算结束', () {
      expect(splitBlocks('~~~\na\n\n```\nb\n~~~\n\nc'), [
        '~~~\na\n\n```\nb\n~~~',
        'c',
      ]);
      expect(splitBlocks('  ```\nx\n\ny\n  ```'), ['  ```\nx\n\ny\n  ```']);
    });

    test('流式中代码块还没收尾：后面的空行都不拆（这一块整块放最后）', () {
      expect(splitBlocks('前面\n\n```\n半截\n\n还在写'), ['前面', '```\n半截\n\n还在写']);
    });

    test('表格、列表在同一块（中间没有空行）', () {
      const table = '| a | b |\n|---|---|\n| 1 | 2 |';
      expect(splitBlocks('标题\n\n$table\n\n- x\n- y'), [
        '标题',
        table,
        '- x\n- y',
      ]);
    });

    test('「```js 带语言名」的开头行不会被当成结束', () {
      expect(splitBlocks('```js\nconst a\n\n```js\n```'), [
        '```js\nconst a\n\n```js\n```',
      ]);
    });
  });
}
