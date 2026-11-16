// 工具（docs/mobile-app.md §8.4，照网页版 apps/mobile/src/data/tools.ts、workspace.ts、account.ts）：
// Git、文件、产物、任务、加项目、账号。经电脑网关调和电脑工具面板同一套操作，第一个参数是项目，只在项目所在的机器上跑。
// 数据仍是 JSON，用 extension type 按 TS 的类型读字段。
import 'dart:async';

import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../connection/connections.dart';
import '../connection/desktop_link.dart';
import '../i18n/i18n.dart';
import '../protocol/json.dart';
import 'tasks.dart';

enum ToolId { git, files, artifacts, tasks }

String toolName(ToolId t) => switch (t) {
  ToolId.git => 'Git',
  ToolId.files => L('文件', 'Files'),
  ToolId.artifacts => L('产物', 'Artifacts'),
  ToolId.tasks => L('任务', 'Tasks'),
};

int _int(Object? v) => v is num ? v.toInt() : 0;
int? _intOrNull(Object? v) => v is num ? v.toInt() : null;

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

/// 改动所在的区，顺序就是页面上的分组顺序
enum GitArea { conflicted, staged, unstaged, untracked }

String gitAreaTitle(GitArea a) => switch (a) {
  GitArea.conflicted => L('冲突', 'Conflicts'),
  GitArea.staged => L('已暂存', 'Staged'),
  GitArea.unstaged => L('没暂存', 'Unstaged'),
  GitArea.untracked => L('未跟踪', 'Untracked'),
};

extension type GitFileChange(Json json) implements Json {
  String get path => str(json['path']) ?? '';
  String? get origPath => str(json['origPath']);

  /// M A D R C T U ?
  String get code => str(json['code']) ?? 'M';
  bool get submodule => json['submodule'] == true;

  /// 增删行数；二进制和旧电脑没有
  int? get insertions => _intOrNull(json['insertions']);
  int? get deletions => _intOrNull(json['deletions']);
}

extension type GitStatus(Json json) implements Json {
  bool get repo => json['repo'] == true;
  bool get missing => json['missing'] == true;
  String? get branch => str(json['branch']);
  bool get detached => json['detached'] == true;
  bool get initial => json['initial'] == true;
  String? get upstream => str(json['upstream']);
  int get ahead => _int(json['ahead']);
  int get behind => _int(json['behind']);
  List<String> get remotes => [
    for (final r in (json['remotes'] as List?) ?? const []) '$r',
  ];
  List<GitFileChange> files(GitArea a) => [
    for (final f in objList(json[a.name])) GitFileChange(f),
  ];
  bool get truncated => json['truncated'] == true;
  String? get operation => str(json['operation']);
  int get busySessions => _int(json['busySessions']);
}

/// 所有改动的文件数
int gitChangeCount(GitStatus s) =>
    GitArea.values.fold(0, (n, a) => n + s.files(a).length);

/// 推送到哪：上游，其次 origin，再其次第一个远端
String? gitRemote(GitStatus s) =>
    s.upstream ??
    (s.remotes.contains('origin')
        ? 'origin'
        : (s.remotes.isEmpty ? null : s.remotes.first));

/// 能推送：不是分离 HEAD、有提交、有远端，并且领先上游或还没有上游
bool gitCanPush(GitStatus s) =>
    !s.detached &&
    !s.initial &&
    s.remotes.isNotEmpty &&
    (s.ahead > 0 || s.upstream == null);

/// 提交会带上的文件：有暂存的只提交暂存的，否则没暂存 + 未跟踪（去重）
List<GitFileChange> gitCommitFiles(GitStatus s) {
  final staged = s.files(GitArea.staged);
  if (staged.isNotEmpty) return staged;
  final seen = <String>{};
  return [
    for (final f in [
      ...s.files(GitArea.unstaged),
      ...s.files(GitArea.untracked),
    ])
      if (seen.add(f.path)) f,
  ];
}

/// 写操作返回的状态不带增删行数：同一区里没变的文件沿用上一份的，换了区的等随后的刷新补上
GitStatus gitKeepCounts(GitStatus next, GitStatus? prev) {
  if (prev == null) return next;
  List<Json> carry(GitArea a) {
    final old = {for (final f in prev.files(a)) f.path: f};
    return [
      for (final f in next.files(a))
        if (old[f.path]?.insertions case final ins?)
          {...f, 'insertions': ins, 'deletions': old[f.path]!.deletions}
        else
          f,
    ];
  }

  return GitStatus({
    ...next,
    'staged': carry(GitArea.staged),
    'unstaged': carry(GitArea.unstaged),
  });
}

String gitCodeText(String code) => switch (code) {
  'M' => L('修改', 'Modified'),
  'A' => L('新增', 'Added'),
  'D' => L('删除', 'Deleted'),
  'R' => L('改名', 'Renamed'),
  'C' => L('复制', 'Copied'),
  'T' => L('类型', 'Type changed'),
  'U' => L('冲突', 'Conflict'),
  _ => L('未跟踪', 'Untracked'),
};

Map<String, String> _gitFailures() => {
  'diverged': L(
    '本地和远端已分叉，请到电脑上处理。',
    'Local and remote have diverged. Resolve it on your computer.',
  ),
  'rejected': L(
    '远端有本地还没拉取的提交：请先在电脑上拉取，再推送。',
    "The remote has commits you haven't pulled. Pull on your computer first, then push.",
  ),
  'conflict': L(
    '有没解决的冲突，请到电脑上处理。',
    'There are unresolved conflicts. Resolve them on your computer.',
  ),
  'auth': L(
    '远端拒绝了访问：请在电脑的终端里登录或配置凭据后重试。',
    'The remote denied access. Sign in or set up credentials in a terminal on your computer, then retry.',
  ),
  'network': L(
    '连不上远端，检查电脑的网络或代理后重试。',
    "Can't reach the remote. Check the computer's network or proxy, then retry.",
  ),
  'timeout': L(
    '远端没有及时响应，已结束这次操作。',
    "The remote didn't respond in time. The operation was stopped.",
  ),
  'locked': L(
    '另一个 git 进程正在使用这个仓库，等它结束后重试。',
    'Another git process is using this repository. Retry after it finishes.',
  ),
  'hook': L(
    '仓库的 git hook 拒绝了这次操作。',
    'A git hook in the repository rejected this operation.',
  ),
  'noUpstream': L(
    '当前分支还没有上游分支：推送时会发布到远端。',
    'This branch has no upstream yet. Pushing will publish it to the remote.',
  ),
  'noRemote': L('这个仓库没有配置远端。', 'This repository has no remote configured.'),
  'identity': L(
    '电脑上没有设置提交用户名和邮箱（git config user.name / user.email）。',
    'No commit name and email are set on the computer (git config user.name / user.email).',
  ),
  'nothing': L(
    '没有可以提交的内容：先暂存文件，或选「提交全部改动」。',
    'Nothing to commit. Stage files first, or choose “Commit all changes”.',
  ),
  'busy': L(
    'AI 正在这个工作区运行，等它这一轮结束再试。',
    'AI is running in this workspace. Try again after this turn ends.',
  ),
  'missing': L('电脑上没有找到 Git。', "Git wasn't found on the computer."),
  'notRepo': L('这个项目不是 Git 仓库。', "This project isn't a Git repository."),
};

/// Git 操作失败的说明：hook 和不认识的种类接上输出的最后 6 行
String gitFailureText(Json failure) {
  final failures = _gitFailures();
  final kind = str(failure['kind']) ?? '';
  final text = failures[kind] ?? L('操作失败', 'Operation failed');
  final detail = jsTrim(str(failure['detail']) ?? '')
      .split('\n')
      .reversed
      .take(6)
      .toList()
      .reversed
      .join('\n');
  final withDetail = kind == 'hook' || !failures.containsKey(kind);
  return withDetail && detail.isNotEmpty ? '$text\n$detail' : text;
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

extension type FileEntry(Json json) implements Json {
  String get name => str(json['name']) ?? '';
  String get path => str(json['path']) ?? '';
  bool get isDirectory => json['kind'] == 'directory';
  String? get status => str(json['status']);
  int? get size => _intOrNull(json['size']);
}

/// 文件夹在前、文件在后；同类保持电脑给的顺序
List<FileEntry> sortEntries(List<FileEntry> entries) => [
  ...entries.where((e) => e.isDirectory),
  ...entries.where((e) => !e.isDirectory),
];

/// 文件大小：1.2 KB
String fileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

/// 路径最后一段；斜杠、反斜杠都认
String baseName(String path) {
  final parts = path.replaceAll(RegExp(r'[\\/]+$'), '').split(RegExp(r'[\\/]'));
  return parts.isEmpty || parts.last.isEmpty ? path : parts.last;
}

// ---------------------------------------------------------------------------
// 产物
// ---------------------------------------------------------------------------

String deliveryText(String type) => switch (type) {
  'document' => L('文档', 'Document'),
  'image' => L('图片', 'Image'),
  'table' => L('表格', 'Spreadsheet'),
  'web' => L('网页', 'Web page'),
  'archive' => L('压缩包', 'Archive'),
  'media' => L('音视频', 'Media'),
  _ => L('文件', 'File'),
};

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

extension type ManualTask(Json json) implements Json {
  String get id => str(json['id']) ?? '';
  String get title => str(json['title']) ?? '';
  String get note => str(json['note']) ?? '';

  /// pending / in_progress / review / completed
  String get status => str(json['status']) ?? 'pending';
  num get updatedAt => (json['updatedAt'] as num?) ?? 0;
  num? get completedAt => json['completedAt'] as num?;
}

/// 待办分组：待验收、进行中、待办、已完成（已完成按完成时间新的在前）；空的组不出现
List<({String status, String title, List<ManualTask> tasks})> taskGroups(
  List<ManualTask> tasks,
) {
  final groups = [
    ('review', L('待验收', 'To review')),
    ('in_progress', L('进行中', 'In progress')),
    ('pending', L('待办', 'To do')),
    ('completed', L('已完成', 'Done')),
  ];
  return [
    for (final (status, title) in groups)
      if (tasks.where((t) => t.status == status).toList() case final list
          when list.isNotEmpty)
        (
          status: status,
          title: title,
          tasks: status == 'completed'
              ? (list..sort(
                  (a, b) => (b.completedAt ?? b.updatedAt).compareTo(
                    a.completedAt ?? a.updatedAt,
                  ),
                ))
              : list,
        ),
  ];
}

/// 交给 AI 时放进输入框的文字
String taskPrompt(ManualTask t) =>
    jsTrim(t.note).isEmpty ? t.title : '${t.title}\n\n${jsTrim(t.note)}';

// ---------------------------------------------------------------------------
// 当前项目（网页版 workspace.ts）
// ---------------------------------------------------------------------------

/// 工具作用的项目：正在看的会话的项目，其次上次选的，再其次最近有会话的，都没有时第一个项目
Project? currentProject(
  List<Project> projects,
  List<SessionSummary> sessions,
  String? openSession,
  String? remembered,
) {
  Project? has(String? id) {
    if (id == null) return null;
    for (final p in projects) {
      if (p.id == id) return p;
    }
    return null;
  }

  String? projectOf(String? sessionId) {
    for (final s in sessions) {
      if (s.id == sessionId) return s.projectId;
    }
    return null;
  }

  final fromSession = has(projectOf(openSession));
  if (fromSession != null) return fromSession;
  final chosen = has(remembered);
  if (chosen != null) return chosen;
  final live = sessions.where((s) => !s.archived).toList()
    ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return has(live.isEmpty ? null : live.first.projectId) ??
      (projects.isEmpty ? null : projects.first);
}

// ---------------------------------------------------------------------------
// 账号（网页版 account.ts）
// ---------------------------------------------------------------------------

/// USD 显示「$12.34」，其他币种「12.34 CNY」；大于 0 不足 0.01 显示「<$0.01」；拿不到显示「—」
String formatBalance(num? value, [String currency = 'USD']) {
  if (value == null || !value.isFinite) return '—';
  final code = currency.toUpperCase();
  final usd = code == 'USD';
  String wrap(String text) => usd ? '\$$text' : '$text $code';
  if (value > 0 && value < 0.01) return usd ? '<\$0.01' : '<0.01 $code';
  final abs = _grouped(value.abs());
  // 四舍五入后为 0 的负数不显示负号
  return value < 0 && abs != '0.00' ? '-${wrap(abs)}' : wrap(abs);
}

/// 电脑上登录的账号（网关的 account；不带邮箱）
extension type Account(Json json) implements Json {
  String get name => str(json['name']) ?? '';
  num? get balance => json['balance'] is num ? json['balance'] as num : null;
  String get currency => str(json['currency']) ?? 'USD';
  String? get plan => str(json['plan']);
}

/// 抽屉底部账号行的第二行：没有余额、有套餐时显示套餐名（同网页版）
String accountLine(Account a) => a.balance == null && a.plan != null
    ? a.plan!
    : L('余额 ', 'Balance ') + formatBalance(a.balance, a.currency);

/// 头像上的字：名字第一个字（大写）
String accountInitial(String name) =>
    name.isEmpty ? '?' : String.fromCharCode(name.runes.first).toUpperCase();

/// 两位小数、千位逗号（同 Intl.NumberFormat 的英文格式）
String _grouped(num v) {
  final fixed = v.toStringAsFixed(2);
  final dot = fixed.indexOf('.');
  final whole = fixed.substring(0, dot);
  final buf = StringBuffer();
  for (var i = 0; i < whole.length; i++) {
    if (i > 0 && (whole.length - i) % 3 == 0) buf.write(',');
    buf.write(whole[i]);
  }
  return '$buf${fixed.substring(dot)}';
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

/// 出错时给人看的话
String toolError(Object e) {
  final message = '$e'.replaceFirst(RegExp(r'^Exception: '), '');
  if (message.contains('MOBILE_UNSUPPORTED')) {
    return L(
      '电脑上的像素星空版本较旧，更新后才能在手机上用这个功能。',
      'The PixelSky app on your computer is out of date. Update it to use this on your phone.',
    );
  }
  if (message.contains('MOBILE_FORBIDDEN')) {
    return L(
      '这部手机是「只看」，在电脑上 设置 › 手机 里改成「可操作」才能做。',
      'This phone is “View only”. Change it to “Can act” in Settings › Phone on your computer to do this.',
    );
  }
  if (message.contains('MOBILE_TOO_LARGE')) {
    return L(
      '内容太大，请到电脑上看。',
      'Too large to show here. View it on your computer.',
    );
  }
  if (message.contains('MOBILE_BAD_ARGUMENT')) {
    return L('参数不对，刷新后再试。', 'Invalid request. Refresh and try again.');
  }
  if (e is LinkNotReady ||
      message.contains('MOBILE_DISCONNECTED') ||
      message.contains('LINK_')) {
    return L(
      '和电脑的连接断了，恢复后再试。',
      'Lost connection to the computer. Try again once it reconnects.',
    );
  }
  if (message.startsWith('RPC_TIMEOUT')) {
    return L('电脑没有回应，稍后再试。', "The computer didn't respond. Try again later.");
  }
  return message;
}

/// 调一次电脑上的工具（连上了才行）
Future<Object?> callTool(
  Connections connections,
  String deviceId,
  String method, [
  List<Object?> args = const [],
]) {
  final link = connections.link(deviceId);
  if (link == null || link.state != LinkState.ready) {
    return Future.error(const LinkNotReady());
  }
  return link.call(method, args);
}

/// 这部手机能做写操作（连上了，而且是「可操作」）
bool canActOn(Connections connections, String deviceId) {
  final link = connections.link(deviceId);
  return link?.state == LinkState.ready && link?.hello?.access == 'act';
}

/// 一份工具数据：连上 / 重连时、reload 时重取；watch 时电脑推 projectTools:changed 也重取（停 300 毫秒合并）
class ToolData extends ChangeNotifier {
  ToolData(
    this._connections,
    this.deviceId,
    this.method,
    this.args, {
    bool watch = false,
  }) {
    _connections.addListener(_onLink);
    if (watch) {
      _events = _connections.events.listen((e) {
        if (e.deviceId != deviceId || e.channel != 'projectTools:changed') {
          return;
        }
        _debounce?.cancel();
        _debounce = Timer(const Duration(milliseconds: 300), reload);
      });
    }
    _onLink();
  }

  final Connections _connections;
  final String deviceId;
  final String method;
  final List<Object?> args;

  Object? data;

  /// 取到过（data 为 null 也算：电脑说没有）
  bool loaded = false;
  String? error;
  bool loading = false;

  StreamSubscription<DesktopEvent>? _events;
  Timer? _debounce;
  LinkState? _state;
  int _request = 0;
  bool _disposed = false;

  void _onLink() {
    final state = _connections.link(deviceId)?.state;
    if (state == _state) return;
    _state = state;
    if (state == LinkState.ready) reload();
  }

  void reload() {
    if (_disposed || _connections.link(deviceId)?.state != LinkState.ready) {
      return;
    }
    final id = ++_request;
    loading = true;
    notifyListeners();
    callTool(_connections, deviceId, method, args).then(
      (r) {
        if (_disposed || id != _request) return;
        data = r;
        loaded = true;
        error = null;
        loading = false;
        notifyListeners();
      },
      onError: (Object e) {
        if (_disposed || id != _request) return;
        error = toolError(e);
        loading = false;
        notifyListeners();
      },
    );
  }

  /// 写操作直接带回了新数据（Git 的结果带最新状态）时用它，不用再取一次。
  /// 写之前发出、还没回来的那次重取作废：它带的是写之前的状态，回来会把新的盖掉
  void set(Object? next) {
    if (_disposed) return;
    _request++;
    data = next;
    loaded = true;
    error = null;
    loading = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _connections.removeListener(_onLink);
    _events?.cancel();
    _debounce?.cancel();
    super.dispose();
  }
}
