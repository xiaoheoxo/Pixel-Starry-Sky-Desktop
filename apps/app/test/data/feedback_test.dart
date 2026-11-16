// 反馈（docs/mobile-app.md §8.5）：正文拼接、限额、状态文字、发给电脑的图片格式、未读数跟着电脑推送变
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/connection/connections.dart';
import 'package:pixelsky_app/connection/desktop_link.dart';
import 'package:pixelsky_app/connection/storage.dart';
import 'package:pixelsky_app/data/feedback.dart';
import 'package:pixelsky_app/data/tools.dart';
import 'package:pixelsky_app/demo/demo.dart';

void main() {
  test('正文：描述 + 复现步骤（填了才有）+ 手机小节', () {
    final phone = phoneInfoLine('1.0.0', 'Android 16', 'Google Pixel 9');
    expect(phone, '像素星空 App 1.0.0 · Android 16 · Google Pixel 9');
    expect(phoneInfoLine('1.0.0', 'ios', ''), '像素星空 App 1.0.0 · ios');
    expect(
      composeFeedbackBody(body: ' 卡住了 ', steps: ' 1. a\n2. b ', phone: phone),
      '卡住了\n\n## 复现步骤\n1. a\n2. b\n\n## 手机\n$phone\n（从手机 App 提交）',
    );
    expect(
      composeFeedbackBody(body: '建议', phone: phone),
      '建议\n\n## 手机\n$phone\n（从手机 App 提交）',
    );
  });

  test('限额：标题必填且不超 100 字，正文（含手机信息）不超 10000 字，截图最多 5 张', () {
    expect(feedbackLimitError(title: ' ', body: 'b', images: 0), '请填写标题');
    expect(
      feedbackLimitError(title: 'x' * 101, body: 'b', images: 0),
      contains('100'),
    );
    expect(feedbackLimitError(title: 't', body: ' ', images: 0), '请填写描述');
    expect(
      feedbackLimitError(title: 't', body: 'x' * 10001, images: 0),
      contains('10000'),
    );
    expect(feedbackLimitError(title: 't', body: 'b', images: 6), contains('5'));
    expect(feedbackLimitError(title: 't', body: 'b', images: 5), isNull);
    expect(replyLimitError(body: 'b', images: 0), isNull);
  });

  test('状态：已关闭 > 已回复 > 处理中 > 已看到 > 等待回复', () {
    FeedbackStatusKind k(Map<String, Object?> m) =>
        feedbackStatusKind(FeedbackSummary(m));
    expect(k({'status': 'closed', 'working': true}), FeedbackStatusKind.closed);
    expect(
      k({'status': 'replied', 'working': true}),
      FeedbackStatusKind.replied,
    );
    expect(
      k({'status': 'open', 'working': true, 'teamSeen': true}),
      FeedbackStatusKind.working,
    );
    expect(k({'status': 'open', 'teamSeen': true}), FeedbackStatusKind.seen);
    expect(k({'status': 'open'}), FeedbackStatusKind.waiting);
    expect(feedbackTypeText('bug'), '问题');
    expect(feedbackTypeText('weird'), '其他');
  });

  test('图片：手机压好的 → 电脑要的 name / mediaType / data', () {
    expect(
      feedbackImages([
        {
          'id': '1',
          'name': 'a.jpg',
          'mediaType': 'image/jpeg',
          'dataBase64': 'QUJD',
          'bytes': 3,
        },
      ]),
      [
        {'name': 'a.jpg', 'mediaType': 'image/jpeg', 'data': 'QUJD'},
      ],
    );
  });

  test('没登录的报错换成说明', () {
    expect(feedbackError(Exception('请先登录像素星空账号')), contains('电脑上还没有登录'));
  });

  test('未读数：连上时问一次，看了一条后跟着电脑推送变', () async {
    final demo = DemoDesktop();
    final connections = Connections(
      store: MemoryPairingStore([demo.pairing]),
      connect: demo.accept,
    );
    await connections.load();
    final device = demo.pairing.deviceId;
    final unread = FeedbackUnread(connections);
    Future<void> until(bool Function() ok) async {
      for (var i = 0; i < 150 && !ok(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    }

    await until(() => connections.state(device) == LinkState.ready);
    await until(() => unread.unread(device) == 1);
    expect(unread.unread(device), 1);
    final v = unread.version(device);
    await callTool(connections, device, 'feedback:get', ['f1']);
    await until(() => unread.unread(device) == 0);
    expect(unread.unread(device), 0);
    expect(unread.version(device), greaterThan(v));

    unread.dispose();
    connections.dispose();
    demo.dispose();
  });
}
