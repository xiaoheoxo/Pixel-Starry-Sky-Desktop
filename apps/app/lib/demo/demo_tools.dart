// 演示电脑的工具（docs/mobile-app.md §8.4）：Git、文件、产物、任务、加项目、账号的假数据。
// 写操作真的改这里的状态（暂存、提交、加待办…），再发 projectTools:changed 让开着的工具页刷新。
import '../link/link.dart';
import '../protocol/json.dart';

/// 不是工具的调用
const notTool = Object();

class DemoTools {
  DemoTools({required this.changed, required this.projectAdded});

  /// 工具数据变了（电脑会推 projectTools:changed）
  final void Function() changed;

  /// 加了项目（电脑会推新的项目列表）
  final void Function(Json project) projectAdded;

  int _now() => DateTime.now().millisecondsSinceEpoch;

  // Git：p1 有改动，p2 是干净的
  final _git = <String, Json>{
    'p1': {
      'staged': <Json>[],
      'unstaged': <Json>[
        _f('apps/app/lib/connection/desktop_link.dart', 'M', 18, 4),
        _f('apps/app/test/connection/desktop_link_test.dart', 'M', 42, 0),
        _f('docs/mobile-app.md', 'M', 6, 1),
      ],
      'untracked': <Json>[_f('apps/app/lib/connection/probe.dart', '?', 37, 0)],
      'ahead': 1,
    },
    'p2': {
      'staged': <Json>[],
      'unstaged': <Json>[],
      'untracked': <Json>[],
      'ahead': 0,
    },
  };

  static Json _f(String path, String code, int ins, int del) => {
    'path': path,
    'origPath': null,
    'code': code,
    'submodule': false,
    'insertions': ins,
    'deletions': del,
  };

  Json _status(String projectId) {
    final g = _git[projectId] ?? _git['p2']!;
    return {
      'repo': true,
      'missing': false,
      'branch': projectId == 'p1' ? 'fix/reconnect' : 'main',
      'detached': false,
      'initial': false,
      'upstream': projectId == 'p1' ? 'origin/fix/reconnect' : 'origin/main',
      'ahead': g['ahead'],
      'behind': 0,
      'remotes': ['origin'],
      'staged': g['staged'],
      'unstaged': g['unstaged'],
      'untracked': g['untracked'],
      'conflicted': <Json>[],
      'truncated': false,
      'operation': null,
      'busySessions': 0,
    };
  }

  /// 把这些路径从一个区挪到另一个区（暂存时未跟踪的变成新增）
  void _move(String projectId, Object? paths, {required bool stage}) {
    final g = _git[projectId]!;
    final from = stage ? ['unstaged', 'untracked'] : ['staged'];
    final to = stage ? 'staged' : 'unstaged';
    final all = paths == 'all';
    final wanted = all ? null : {for (final p in (paths as List)) '$p'};
    for (final area in from) {
      final keep = <Json>[];
      for (final f in objList(g[area])) {
        if (all || wanted!.contains(f['path'])) {
          final code = f['code'] == '?' ? 'A' : f['code'];
          (g[to] as List<Json>).add({
            ...f,
            'code': !stage && code == 'A' ? '?' : code,
          });
        } else {
          keep.add(f);
        }
      }
      g[area] = keep;
    }
  }

  Json _ok(String projectId) => {'ok': true, 'status': _status(projectId)};

  // 任务
  final _tasks = <Json>[
    {
      'id': 't1',
      'projectId': 'p1',
      'title': '回到前台时探一下连接',
      'note': '',
      'status': 'in_progress',
      'priority': 'high',
      'due': '',
      'createdAt': 1,
      'updatedAt': 3,
    },
    {
      'id': 't2',
      'projectId': 'p1',
      'title': '给重连补测试',
      'note': '覆盖心跳超时和看门狗两种情况',
      'status': 'pending',
      'priority': 'normal',
      'due': '',
      'createdAt': 2,
      'updatedAt': 2,
    },
    {
      'id': 't3',
      'projectId': 'p1',
      'title': '整理断线日志格式',
      'note': '',
      'status': 'completed',
      'priority': 'low',
      'due': '',
      'createdAt': 0,
      'updatedAt': 1,
      'completedAt': 1,
    },
  ];
  int _taskSeq = 3;

  static const _files = <String, List<Json>>{
    '': [
      {'name': 'apps', 'path': 'apps', 'kind': 'directory'},
      {'name': 'docs', 'path': 'docs', 'kind': 'directory'},
      {'name': 'README.md', 'path': 'README.md', 'kind': 'file', 'size': 2310},
      {
        'name': 'package.json',
        'path': 'package.json',
        'kind': 'file',
        'size': 1288,
      },
    ],
    'apps': [
      {'name': 'app', 'path': 'apps/app', 'kind': 'directory'},
      {'name': 'desktop', 'path': 'apps/desktop', 'kind': 'directory'},
    ],
    'apps/app': [
      {'name': 'lib', 'path': 'apps/app/lib', 'kind': 'directory'},
      {
        'name': 'pubspec.yaml',
        'path': 'apps/app/pubspec.yaml',
        'kind': 'file',
        'size': 1630,
      },
    ],
    'apps/app/lib': [
      {
        'name': 'main.dart',
        'path': 'apps/app/lib/main.dart',
        'kind': 'file',
        'size': 2140,
        'status': 'M',
      },
    ],
    'docs': [
      {
        'name': 'mobile-app.md',
        'path': 'docs/mobile-app.md',
        'kind': 'file',
        'size': 48200,
        'status': 'M',
      },
    ],
  };

  static const _main = '''import 'package:material_ui/material_ui.dart';

import 'app/app.dart';

/// 像素星空手机 App 入口
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PixelSkyApp());
}
''';

  static const _diff = '''@@ -40,6 +40,14 @@ class DesktopLink {
   void wake() {
-    if (_state == LinkState.ready) return;
+    // 回到前台：连着也探一下，系统挂起时 WebSocket 可能已经断了
+    if (_state == LinkState.ready) {
+      _probe();
+      return;
+    }
     _retryNow();
   }''';

  Object? handle(String method, List args) {
    final first = args.isEmpty ? null : args.first;
    final projectId = str(obj(first)['projectId']) ?? 'p1';
    switch (method) {
      case 'account':
        return {
          'name': '小黑',
          'balance': 96.25,
          'currency': 'USD',
          'plan': 'Pro',
          'updatedAt': _now(),
        };
      case 'projectTools:gitStatus':
        return _status(projectId);
      case 'projectTools:gitDiff':
        final o = obj(args.length > 1 ? args[1] : null);
        return {
          'path': o['path'],
          'binary': false,
          'tooLarge': false,
          'diff': _diff,
          'added': 5,
          'removed': 1,
          'cut': false,
        };
      case 'projectTools:gitStage' || 'projectTools:gitUnstage':
        _move(projectId, args[1], stage: method == 'projectTools:gitStage');
        changed();
        return _ok(projectId);
      case 'projectTools:gitCommit':
        final g = _git[projectId]!;
        final o = obj(args[1]);
        if (objList(g['staged']).isEmpty && o['all'] == true) {
          _move(projectId, 'all', stage: true);
        }
        g['staged'] = <Json>[];
        g['ahead'] = (o['push'] == true) ? 0 : (g['ahead'] as int) + 1;
        changed();
        return _ok(projectId);
      case 'projectTools:gitPush':
        _git[projectId]!['ahead'] = 0;
        changed();
        return _ok(projectId);
      case 'files:list':
        final path = str(args.length > 1 ? args[1] : null) ?? '';
        final entries = _files[path];
        if (entries == null) throw const LinkException('ENOENT');
        return {'entries': entries, 'truncated': false};
      case 'files:read':
        final path = str(args[1]) ?? '';
        if (path.endsWith('.dart')) {
          return {
            'kind': 'text',
            'path': path,
            'content': _main,
            'bytes': _main.length,
          };
        }
        if (path.endsWith('.md')) {
          const md = '# 像素星空\n\n给 Claude Code / Codex 做的 AI 编程桌面工作台。\n';
          return {
            'kind': 'text',
            'path': path,
            'content': md,
            'bytes': md.length,
          };
        }
        return {
          'kind': 'text',
          'path': path,
          'content': '{\n  "name": "pixelsky"\n}\n',
          'bytes': 24,
        };
      case 'engine:artifacts':
        final at = _now() - 40 * 60 * 1000;
        return {
          'requestId': 1,
          'turns': [
            {
              'sessionId': 's1',
              'title': '修复手机端断线重连',
              'engine': 'claude',
              'archived': false,
              'userItemId': 'u0',
              'prompt': '手机切到后台再回来，有时一直显示「正在连接」，帮我查一下原因并修好。',
              'at': at,
              'files': [
                {
                  'path': 'apps/app/lib/connection/desktop_link.dart',
                  'local': 'apps/app/lib/connection/desktop_link.dart',
                  'kind': 'update',
                  'added': 5,
                  'removed': 1,
                  'itemId': 'c-art1',
                },
                {
                  'path': 'apps/app/lib/connection/probe.dart',
                  'local': 'apps/app/lib/connection/probe.dart',
                  'kind': 'add',
                  'added': 37,
                  'removed': 0,
                  'itemId': 'c-art2',
                },
              ],
            },
          ],
          'delivered': [
            {
              'sessionId': 's3',
              'itemId': 'c-art3',
              'title': '解释一下 Noise 握手',
              'path': 'docs/noise.md',
              'local': 'docs/noise.md',
              'type': 'document',
              'at': at,
              'exists': true,
              'bytes': 4210,
            },
          ],
          'outsideCount': 0,
          'truncated': false,
          'partial': false,
        };
      case 'engine:artifactChange':
        return {
          'kind': 'file_change',
          'id': 'c-art',
          'changes': [
            {
              'path': 'apps/app/lib/connection/desktop_link.dart',
              'kind': 'update',
              'diff': _diff,
              'added': 5,
              'removed': 1,
            },
          ],
        };
      case 'projectTools:tasks':
        return {
          'tasks': [
            for (final t in _tasks)
              if (t['projectId'] == first) t,
          ],
          'plans': [
            if (first == 'p1')
              {
                'sessionId': 's1',
                'title': '修复手机端断线重连',
                'item': {
                  'kind': 'todo',
                  'id': 'todo1',
                  'steps': [
                    {'text': '找到看门狗没有触发的原因', 'status': 'completed'},
                    {'text': '回到前台时主动探一下连接', 'status': 'in_progress'},
                    {'text': '补测试', 'status': 'pending'},
                  ],
                },
              },
          ],
        };
      case 'projectTools:createTask':
        _tasks.add({
          'id': 't${++_taskSeq}',
          'projectId': first,
          'title': obj(args[1])['title'],
          'note': '',
          'status': 'pending',
          'priority': 'normal',
          'due': '',
          'createdAt': _now(),
          'updatedAt': _now(),
        });
        changed();
        return null;
      case 'projectTools:updateTask':
        for (final t in _tasks) {
          if (t['id'] == first) {
            final status = obj(args[1])['status'];
            t['status'] = status;
            t['updatedAt'] = _now();
            t['completedAt'] = status == 'completed' ? _now() : null;
          }
        }
        changed();
        return null;
      case 'directories':
        final path = str(first) ?? r'D:\work';
        final known = <String, List<String>>{
          r'D:\work': ['pixelsky', 'site', 'notes', 'playground'],
          r'D:\': ['work', 'dev'],
        };
        final i = path.lastIndexOf(r'\');
        return {
          'path': path,
          'parent': path == r'D:\'
              ? null
              : (i <= 2 ? r'D:\' : path.substring(0, i)),
          'directories': known[path] ?? const <String>[],
        };
      case 'addProject':
        final path = str(first) ?? '';
        final project = {
          'id': 'p${_now()}',
          'name': path.split(r'\').last,
          'path': path,
          'addedAt': _now(),
        };
        projectAdded(project);
        return project;
    }
    return notTool;
  }
}
