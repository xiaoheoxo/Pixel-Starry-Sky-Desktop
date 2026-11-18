// 会话列表的分组、状态、标题、时间（照网页版 apps/mobile/src/data/tasks.ts）。纯函数。
import '../i18n/i18n.dart';
import '../protocol/constants.dart';
import '../protocol/json.dart';

/// 会话列表里的一条（packages/protocol 的 SessionSummary）
extension type SessionSummary(Json json) implements Json {
  Json get record => obj(json['record']);
  String get id => record['id'] as String? ?? '';
  String get state => str(json['state']) ?? 'idle';
  String get title => str(record['title']) ?? '';
  String get projectId => str(record['projectId']) ?? '';
  String get engine => str(record['engine']) ?? 'claude';
  num get updatedAt => record['updatedAt'] as num? ?? 0;
  bool get archived => record['archivedAt'] != null;
  bool get pinned => record['pinnedAt'] != null;
  String? get lastOutcome => str(record['lastOutcome']);
  String? get lastReply => str(record['lastReply']);

  /// 说完了但后台还在跑的子智能体 / 编排有几个（§17）
  int get background => (json['background'] as num?)?.toInt() ?? 0;

  /// 在忙：这一轮在跑，或者后台子智能体还在跑
  bool get busy => state == 'running' || state == 'starting' || background > 0;
}

List<SessionSummary> summariesOf(Object? raw) => [
  for (final m in objList(raw)) SessionSummary(m),
];

/// 项目（ProjectRecord）
extension type Project(Json json) implements Json {
  String get id => str(json['id']) ?? '';
  String get name => str(json['name']) ?? '';
  String get path => str(json['path']) ?? '';
}

List<Project> projectsOf(Object? raw) => [
  for (final m in objList(raw)) Project(m),
];

int _byTime(SessionSummary a, SessionSummary b) =>
    b.updatedAt.compareTo(a.updatedAt);

/// 「最近」一次显示几条，点「显示更多」再加这么多
const recentStep = 50;

/// 首页和抽屉的会话列表：「等你处理」置顶，其余里置顶的在前，再按时间排
({List<SessionSummary> waiting, List<SessionSummary> rest, int more})
sessionList(List<SessionSummary> sessions, [int limit = recentStep]) {
  final live = sessions.where((s) => !s.archived);
  final rest = live.where((s) => s.state != 'waiting').toList()
    ..sort((a, b) {
      final p = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      return p != 0 ? p : _byTime(a, b);
    });
  return (
    waiting: live.where((s) => s.state == 'waiting').toList()..sort(_byTime),
    rest: rest.take(limit).toList(),
    more: rest.length > limit ? rest.length - limit : 0,
  );
}

enum Tone { danger, online, warn }

/// 一行会话不是空闲时的状态；空闲时 null，第二行显示最后一句回复
({Tone tone, String text, bool pulse})? sessionStatus(SessionSummary s) {
  return switch (s.state) {
    'waiting' => (
      tone: Tone.danger,
      text: L('等你处理', 'Needs you'),
      pulse: false,
    ),
    'starting' => (
      tone: Tone.online,
      text: L('正在启动…', 'Starting…'),
      pulse: true,
    ),
    'running' => (
      tone: Tone.online,
      text: L('正在回复…', 'Replying…'),
      pulse: true,
    ),
    // 一轮说完了但后台子智能体还在跑：还没做完（§17）
    _ when s.background > 0 => (
      tone: Tone.online,
      text: L(
        '后台 ${s.background} 个子智能体在跑',
        '${s.background} subagent${s.background == 1 ? '' : 's'} running in background',
      ),
      pulse: true,
    ),
    _ when s.lastOutcome == 'failed' => (
      tone: Tone.warn,
      text: L('出错了', 'Error'),
      pulse: false,
    ),
    _ => null,
  };
}

/// 列表里显示的标题：没有标题时用「未命名会话」
String taskTitle(SessionSummary s) => jsTrim(s.title).isEmpty
    ? L('未命名会话', 'Untitled conversation')
    : jsTrim(s.title);

/// 会话所属项目的显示名：不用项目的会话写「对话」；项目已不在时空串
String projectNameOf(List<Project> projects, String? projectId) {
  for (final p in projects) {
    if (p.id == projectId) return p.name;
  }
  return projectId == chatProjectId ? L('对话', 'Chat') : '';
}

/// 「3 分钟前」这样的相对时间
String ago(num at, [DateTime? now]) {
  final ms = (now ?? DateTime.now()).millisecondsSinceEpoch - at;
  final s = (ms / 1000).round().clamp(0, 1 << 52);
  if (s < 60) return L('刚刚', 'Just now');
  if (s < 3600) {
    final n = s ~/ 60;
    return L('$n 分钟前', '$n min ago');
  }
  if (s < 86400) {
    final n = s ~/ 3600;
    return L('$n 小时前', n == 1 ? '1 hour ago' : '$n hours ago');
  }
  final n = s ~/ 86400;
  return L('$n 天前', n == 1 ? '1 day ago' : '$n days ago');
}

/// 按标题、项目名、引擎名筛（多个词都要有，不分大小写）
List<SessionSummary> filterTasks(
  List<SessionSummary> sessions,
  String query,
  String Function(SessionSummary s) projectName,
) {
  final terms = query
      .toLowerCase()
      .split(RegExp(r'\s+'))
      .where((t) => t.isNotEmpty)
      .toList();
  if (terms.isEmpty) return sessions;
  return [
    for (final s in sessions)
      if (() {
        final hay = [
          taskTitle(s),
          projectName(s),
          engines[s.engine]?.name ?? '',
        ].join(' ').toLowerCase();
        return terms.every(hay.contains);
      }())
        s,
  ];
}

/// 抽屉「项目」页的一组：project 为 null 是电脑上已经没有这个项目的「其他」
class ProjectGroup {
  const ProjectGroup(this.project, this.sessions, this.more, this.archived);
  final Project? project;
  final List<SessionSummary> sessions;
  final int more;
  final List<SessionSummary> archived;
}

/// 有会话的项目按最近一次活动排在前，没有会话的排在后面；不用项目的对话放在「对话」组，项目已不在的归到「其他」
List<ProjectGroup> projectGroups(
  List<SessionSummary> sessions,
  List<Project> projects,
  int Function(String projectId) limitOf,
) {
  final known = {for (final p in projects) p.id, chatProjectId};
  ({ProjectGroup group, num latest}) build(Project? project) {
    final mine = [
      for (final s in sessions)
        if (project != null
            ? s.projectId == project.id
            : !known.contains(s.projectId))
          s,
    ];
    final list = sessionList(mine, limitOf(project?.id ?? ''));
    num latest = 0;
    for (final s in mine) {
      if (!s.archived && s.updatedAt > latest) latest = s.updatedAt;
    }
    final archived = [
      for (final s in mine)
        if (s.archived) s,
    ]..sort(_byTime);
    return (
      group: ProjectGroup(
        project,
        [...list.waiting, ...list.rest],
        list.more,
        archived,
      ),
      latest: latest,
    );
  }

  final built = [for (final p in projects) build(p)];
  final active = built.where((b) => b.latest > 0).toList()
    ..sort((a, b) => b.latest.compareTo(a.latest));
  final idle = built.where((b) => b.latest == 0);
  final chat = build(
    Project({'id': chatProjectId, 'name': L('对话', 'Chats'), 'path': ''}),
  ).group;
  final other = build(null).group;
  bool nonEmpty(ProjectGroup g) =>
      g.sessions.isNotEmpty || g.archived.isNotEmpty;
  return [
    for (final b in [...active, ...idle]) b.group,
    if (nonEmpty(chat)) chat,
    if (nonEmpty(other)) other,
  ];
}
