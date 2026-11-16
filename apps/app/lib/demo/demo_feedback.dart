// 演示电脑的反馈（docs/mobile-app.md §8.5，同电脑演示 docs/ui/feedback.md §2.7）：3 条示例——
// 一条已回复且未读、一条带截图、一条已关闭。提交、补充、关闭、已读只改内存，改完推 feedback:changed。
import '../link/link.dart';
import '../protocol/json.dart';
import 'demo_tools.dart' show notTool;

class DemoFeedback {
  DemoFeedback({required this.changed});

  /// 未读数变了（电脑会推 feedback:changed）
  final void Function(int unread) changed;

  int _now() => DateTime.now().millisecondsSinceEpoch;
  late final int _t0 = _now();
  int _seq = 3;
  int _msgSeq = 10;

  // 64×40 的示意图（顶上一条深绿、下面浅灰）：截图附件的样子
  static const _png =
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAVUlEQVR4nO3PQQ3AMBDAsAIrkoEYzn7KaSD2sE6KFADx2u8zusUPAuiDAPoggD74Czj3jC6ALoAugC6ALoAugC6ALoAugC6ALoAugC6ALoAugG484AMa6PEtOOYX7wAAAABJRU5ErkJggg==';

  late final _threads = <Json>[
    {
      'id': 'f1',
      'type': 'bug',
      'title': '切到后台再回来一直显示「正在连接」',
      'status': 'replied',
      'createdAt': _t0 - 26 * 3600000,
      'updatedAt': _t0 - 3 * 3600000,
      'unread': true,
      'preview': '已经找到原因，下个版本会在回到前台时先探一下连接。',
      'previewAuthor': 'team',
      'teamSeen': true,
      'working': false,
    },
    {
      'id': 'f2',
      'type': 'feature',
      'title': '手机上也能看 Git 提交历史',
      'status': 'open',
      'createdAt': _t0 - 50 * 3600000,
      'updatedAt': _t0 - 50 * 3600000,
      'unread': false,
      'preview': '现在只能看改动，想在手机上翻一下最近的提交。',
      'previewAuthor': 'user',
      'teamSeen': true,
      'working': true,
    },
    {
      'id': 'f3',
      'type': 'other',
      'title': '发票开具',
      'status': 'closed',
      'createdAt': _t0 - 9 * 86400000,
      'updatedAt': _t0 - 8 * 86400000,
      'unread': false,
      'preview': '已经发到你的邮箱了。',
      'previewAuthor': 'team',
      'teamSeen': true,
      'working': false,
      'closedBy': 'team',
    },
  ];

  late final _messages = <String, List<Json>>{
    'f1': [
      _msg(
        1,
        'user',
        '手机切到后台几分钟再回来，顶上一直是「正在连接」，要手动下拉才好。',
        _t0 - 26 * 3600000,
        logs: true,
      ),
      _msg(2, 'team', '已经找到原因，下个版本会在回到前台时先探一下连接。谢谢反馈！', _t0 - 3 * 3600000),
    ],
    'f2': [
      _msg(
        3,
        'user',
        '现在只能看改动，想在手机上翻一下最近的提交。',
        _t0 - 50 * 3600000,
        image: true,
      ),
    ],
    'f3': [
      _msg(4, 'user', '想开一张上个月的发票。', _t0 - 9 * 86400000),
      _msg(5, 'team', '已经发到你的邮箱了。', _t0 - 8 * 86400000 - 60000),
      {..._msg(6, 'team', '', _t0 - 8 * 86400000), 'kind': 'closed'},
    ],
  };

  Json _msg(
    int id,
    String author,
    String body,
    int at, {
    bool logs = false,
    bool image = false,
  }) => {
    'id': id,
    'author': author,
    'kind': 'message',
    'body': body,
    'createdAt': at,
    'diagnostics': logs ? {'appVersion': '0.6.9'} : null,
    'error': null,
    'attachments': [
      if (logs)
        {
          'id': 100 + id,
          'kind': 'log',
          'name': 'logs.txt',
          'mediaType': 'text/plain',
          'size': 800,
          'rawSize': 4200,
          'available': true,
        },
      if (image)
        {
          'id': 200 + id,
          'kind': 'image',
          'name': 'screenshot.png',
          'mediaType': 'image/png',
          'size': 70,
          'rawSize': 70,
          'available': true,
        },
    ],
  };

  int get _unread => _threads.where((t) => t['unread'] == true).length;

  Json _thread(String id) {
    for (final t in _threads) {
      if (t['id'] == id) return t;
    }
    throw const LinkException('反馈编号不对');
  }

  Json _detail(String id) => {
    'thread': {
      ..._thread(id),
      'closedBy': _thread(id)['closedBy'],
      'closedAt': null,
    },
    'messages': _messages[id] ?? const <Json>[],
  };

  List<Json> get _sorted => [..._threads]
    ..sort((a, b) => (b['updatedAt'] as int).compareTo(a['updatedAt'] as int));

  /// 新反馈 / 补充带的附件
  List<Json> _attachments(Json input) => [
    if (input['logs'] != null)
      {
        'id': ++_msgSeq + 300,
        'kind': 'log',
        'name': 'logs.txt',
        'mediaType': 'text/plain',
        'size': 900,
        'rawSize': 5100,
        'available': true,
      },
    for (final _ in objList(input['images']))
      {
        'id': ++_msgSeq + 300,
        'kind': 'image',
        'name': 'screenshot.jpg',
        'mediaType': 'image/png',
        'size': 70,
        'rawSize': 70,
        'available': true,
      },
  ];

  Object? handle(String method, List args) {
    switch (method) {
      case 'feedback:state':
        return {
          'status': 'ready',
          'signedIn': true,
          'unreadCount': _unread,
          'threads': _sorted,
          'nextBefore': null,
          'error': null,
          'checkedAt': _now(),
        };
      case 'feedback:list':
        return {'threads': _sorted, 'unreadCount': _unread, 'nextBefore': null};
      case 'feedback:get':
        final id = str(args.isEmpty ? null : args[0]) ?? '';
        final t = _thread(id);
        if (t['unread'] == true) {
          t['unread'] = false;
          changed(_unread);
        }
        return _detail(id);
      case 'feedback:markAllRead':
        for (final t in _threads) {
          t['unread'] = false;
        }
        changed(0);
        return null;
      case 'feedback:preview':
        final w = objOrNull(args.isEmpty ? null : args[0]);
        return {
          'diagnosticsText': '像素星空 0.6.9（stable）\nWindows 11 x64\nClaude Code 2.1.3 · 就绪\nCodex 0.98.0 · 就绪',
          'logs': w == null
              ? null
              : {
                  'text': '# 最近日志（演示）\n10:02:11 INFO  mobile  手机已连接\n10:05:40 WARN  mobile  心跳超时，重连\n10:05:41 INFO  mobile  手机已连接\n',
                  'lines': 3,
                  'bytes': 132,
                  'truncated': false,
                  'since': w['since'],
                  'until': w['until'],
                },
        };
      case 'feedback:create':
        final input = obj(args.isEmpty ? null : args[0]);
        final id = 'f${++_seq}';
        final at = _now();
        _threads.add({
          'id': id,
          'type': str(input['type']) ?? 'other',
          'title': str(input['title']) ?? '',
          'status': 'open',
          'createdAt': at,
          'updatedAt': at,
          'unread': false,
          'preview': str(input['body']) ?? '',
          'previewAuthor': 'user',
          'teamSeen': false,
          'working': false,
        });
        _messages[id] = [
          {
            ..._msg(++_msgSeq, 'user', str(input['body']) ?? '', at),
            'diagnostics': input['diagnostics'] == true
                ? {'appVersion': '0.6.9'}
                : null,
            'attachments': _attachments(input),
          },
        ];
        return _detail(id);
      case 'feedback:reply':
        final id = str(args.isEmpty ? null : args[0]) ?? '';
        final input = obj(args.length > 1 ? args[1] : null);
        final t = _thread(id);
        final at = _now();
        final list = _messages.putIfAbsent(id, () => []);
        if (t['status'] == 'closed') {
          list.add({..._msg(++_msgSeq, 'user', '', at), 'kind': 'reopened'});
        }
        list.add({
          ..._msg(++_msgSeq, 'user', str(input['body']) ?? '', at),
          'attachments': _attachments(input),
        });
        t
          ..['status'] = 'open'
          ..['updatedAt'] = at
          ..['preview'] = str(input['body']) ?? ''
          ..['previewAuthor'] = 'user'
          ..['closedBy'] = null;
        return _detail(id);
      case 'feedback:close':
        final id = str(args.isEmpty ? null : args[0]) ?? '';
        final t = _thread(id);
        final at = _now();
        _messages.putIfAbsent(id, () => []).add({
          ..._msg(++_msgSeq, 'user', '', at),
          'kind': 'closed',
        });
        t
          ..['status'] = 'closed'
          ..['updatedAt'] = at
          ..['closedBy'] = 'user';
        return _detail(id);
      case 'feedback:attachment':
        final attachment = args.length > 1 ? args[1] : null;
        for (final list in _messages.values) {
          for (final m in list) {
            for (final a in objList(m['attachments'])) {
              if (a['id'] != attachment) continue;
              return a['kind'] == 'image'
                  ? {'kind': 'image', 'mediaType': 'image/png', 'data': _png}
                  : {
                      'kind': 'log',
                      'text': '# 最近日志（演示）\n10:05:40 WARN  mobile  心跳超时，重连\n',
                    };
            }
          }
        }
        throw const LinkException('附件编号不对');
    }
    return notTool;
  }
}
