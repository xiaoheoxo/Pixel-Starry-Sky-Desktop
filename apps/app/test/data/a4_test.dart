// A4：工具页和账号的规则（照网页版 workspace.test.ts、account.test.ts，加上 Git、任务分组）。
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/tasks.dart';
import 'package:pixelsky_app/data/tools.dart';

Project project(String id) =>
    Project({'id': id, 'name': id, 'path': 'C:/$id', 'addedAt': 1});

SessionSummary session(
  String id,
  String projectId,
  num updatedAt, {
  String state = 'idle',
  num? archivedAt,
}) => SessionSummary({
  'record': {
    'id': id,
    'projectId': projectId,
    'title': id,
    'updatedAt': updatedAt,
    'archivedAt': archivedAt,
  },
  'state': state,
});

Map<String, Object?> file(String path, String code, [int? ins, int? del]) => {
  'path': path,
  'origPath': null,
  'code': code,
  'submodule': false,
  'insertions': ?ins,
  'deletions': ?del,
};

GitStatus status({
  List<Map<String, Object?>> staged = const [],
  List<Map<String, Object?>> unstaged = const [],
  List<Map<String, Object?>> untracked = const [],
  String? upstream = 'origin/main',
  int ahead = 0,
  List<String> remotes = const ['origin'],
  bool detached = false,
  bool initial = false,
}) => GitStatus({
  'repo': true,
  'branch': 'main',
  'detached': detached,
  'initial': initial,
  'upstream': upstream,
  'ahead': ahead,
  'behind': 0,
  'remotes': remotes,
  'staged': staged,
  'unstaged': unstaged,
  'untracked': untracked,
  'conflicted': const <Object?>[],
});

void main() {
  group('当前项目（同网页版 workspace.test.ts）', () {
    final projects = [project('web'), project('app'), project('empty')];
    final sessions = [
      session('old', 'web', 1),
      session('new', 'web', 5),
      session('asks', 'web', 2, state: 'waiting'),
      session('runs', 'app', 3, state: 'running'),
      session('gone', 'app', 9, archivedAt: 8),
    ];
    test('正在看的会话 > 上次选的 > 最近有动静的 > 第一个', () {
      expect(currentProject(projects, sessions, 'runs', 'web')?.id, 'app');
      expect(currentProject(projects, sessions, null, 'empty')?.id, 'empty');
      expect(currentProject(projects, sessions, null, 'deleted')?.id, 'web');
      expect(currentProject(projects, const [], null, null)?.id, 'web');
      expect(currentProject(const [], const [], null, null), isNull);
    });
  });

  group('余额文字（同网页版 account.test.ts）', () {
    test('USD 带 \$，其他币种后缀币种代码；千位逗号', () {
      expect(formatBalance(12.345, 'usd'), '\$12.35');
      expect(formatBalance(12.3, 'CNY'), '12.30 CNY');
      expect(formatBalance(1234567.5), '\$1,234,567.50');
    });
    test('拿不到显示破折号，不足 0.01 显示 <，负数保留负号但 -0.001 不显示', () {
      expect(formatBalance(null), '—');
      expect(formatBalance(double.nan), '—');
      expect(formatBalance(0.004), '<\$0.01');
      expect(formatBalance(0.004, 'CNY'), '<0.01 CNY');
      expect(formatBalance(-2), '-\$2.00');
      expect(formatBalance(-0.001), '\$0.00');
    });
  });

  group('Git', () {
    test('提交的文件：有暂存只提交暂存的；否则没暂存 + 未跟踪去重', () {
      final a = status(staged: [file('a', 'M')], unstaged: [file('b', 'M')]);
      expect(gitCommitFiles(a).map((f) => f.path), ['a']);
      final b = status(
        unstaged: [file('b', 'M'), file('c', 'D')],
        untracked: [file('b', '?'), file('d', '?')],
      );
      expect(gitCommitFiles(b).map((f) => f.path), ['b', 'c', 'd']);
      expect(gitChangeCount(b), 4);
    });

    test('写操作回来的状态沿用同一区的增删行数，换了区的不带', () {
      final prev = status(
        staged: [file('a', 'M', 3, 1)],
        unstaged: [file('b', 'M', 5, 0)],
      );
      final next = status(staged: [file('a', 'M'), file('b', 'M')]);
      final kept = gitKeepCounts(next, prev).files(GitArea.staged);
      expect([kept[0].insertions, kept[0].deletions], [3, 1]);
      expect(kept[1].insertions, isNull);
    });

    test('能不能推送、推到哪', () {
      expect(gitCanPush(status(ahead: 2)), isTrue);
      expect(gitCanPush(status()), isFalse);
      expect(gitCanPush(status(upstream: null)), isTrue);
      expect(gitCanPush(status(upstream: null, remotes: const [])), isFalse);
      expect(gitCanPush(status(ahead: 1, detached: true)), isFalse);
      expect(
        gitRemote(status(upstream: null, remotes: ['up', 'origin'])),
        'origin',
      );
      expect(gitRemote(status(upstream: null, remotes: ['up'])), 'up');
    });

    test('失败说明：认识的种类只给说明；hook 和不认识的接上输出最后 6 行', () {
      expect(
        gitFailureText({'kind': 'auth', 'detail': 'fatal: denied'}),
        isNot(contains('fatal')),
      );
      final hook = gitFailureText({
        'kind': 'hook',
        'detail': [for (var i = 1; i <= 8; i++) 'line$i'].join('\n'),
      });
      expect(hook, contains('line8'));
      expect(hook, isNot(contains('line2')));
      expect(gitFailureText({'kind': 'weird', 'detail': ''}), '操作失败');
    });
  });

  group('任务', () {
    ManualTask t(String id, String status, {num updated = 0, num? done}) =>
        ManualTask({
          'id': id,
          'title': id,
          'note': '',
          'status': status,
          'updatedAt': updated,
          'completedAt': done,
        });

    test('按待验收、进行中、待办、已完成分组；已完成新的在前；空组不出现', () {
      final groups = taskGroups([
        t('a', 'pending'),
        t('b', 'completed', done: 1),
        t('c', 'in_progress'),
        t('d', 'completed', updated: 5),
      ]);
      expect(groups.map((g) => g.status), [
        'in_progress',
        'pending',
        'completed',
      ]);
      expect(groups.last.tasks.map((x) => x.id), ['d', 'b']);
    });

    test('交给 AI：有说明时标题空一行接说明', () {
      expect(taskPrompt(ManualTask({'title': '写测试', 'note': ' '})), '写测试');
      expect(
        taskPrompt(ManualTask({'title': '写测试', 'note': '覆盖边界'})),
        '写测试\n\n覆盖边界',
      );
    });
  });

  test('文件：文件夹在前、同类保持原顺序；大小；路径最后一段', () {
    final sorted = sortEntries([
      FileEntry({'name': 'b.ts', 'kind': 'file'}),
      FileEntry({'name': 'src', 'kind': 'directory'}),
      FileEntry({'name': 'a.ts', 'kind': 'file'}),
    ]);
    expect(sorted.map((e) => e.name), ['src', 'b.ts', 'a.ts']);
    expect(fileSize(512), '512 B');
    expect(fileSize(1536), '1.5 KB');
    expect(fileSize(3 * 1024 * 1024), '3.0 MB');
    expect(baseName(r'C:\code\app\'), 'app');
    expect(baseName('/home/me/web'), 'web');
  });
}
