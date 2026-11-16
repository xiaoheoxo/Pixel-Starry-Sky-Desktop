// 会话列表和项目列表的本机缓存（照网页版 apps/mobile/src/data/listCache.ts）：每台电脑最近一次的列表存在本机，
// 下次打开先显示它，连上电脑取到新的再替换。只存列表要用的字段（不存对话内容），各最多 200 条，写入 1 秒节流。
import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../protocol/json.dart';
import 'tasks.dart';

const maxCached = 200;
const _prefix = 'pixelsky.lists.';
const _version = 1;

/// 缓存用到的存储（本机是 shared_preferences，测试里换成内存的）
abstract interface class CacheStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> remove(String key);
  Future<Set<String>> keys();
}

class PrefsCacheStore implements CacheStore {
  final _prefs = SharedPreferencesAsync();
  @override
  Future<String?> read(String key) => _prefs.getString(key);
  @override
  Future<void> write(String key, String value) => _prefs.setString(key, value);
  @override
  Future<void> remove(String key) => _prefs.remove(key);
  @override
  Future<Set<String>> keys() => _prefs.getKeys();
}

class MemoryCacheStore implements CacheStore {
  final data = <String, String>{};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async => data[key] = value;
  @override
  Future<void> remove(String key) async => data.remove(key);
  @override
  Future<Set<String>> keys() async => data.keys.toSet();
}

/// 会话记录里列表和输入框要用的字段；引擎会话、导入、分叉这类大块内容不存
const _recordKeys = [
  'id',
  'projectId',
  'cwd',
  'engine',
  'engineSessionId',
  'title',
  'titleEdited',
  'createdAt',
  'updatedAt',
  'lastOutcome',
  'lastError',
  'lastReply',
  'archivedAt',
  'pinnedAt',
  'bottomedAt',
  'platform',
  'provider',
  'model',
  'effort',
  'permissionMode',
  'ultracode',
  'fast',
  'thinkingSummaries',
];

Json slimSession(SessionSummary s) => {
  'record': {
    for (final k in _recordKeys)
      if (s.record.containsKey(k)) k: s.record[k],
  },
  'state': s.state,
  if (s.json['background'] != null) 'background': s.json['background'],
  if (s.json['queue'] != null) 'queue': s.json['queue'],
};

/// 最近有动静的会话留 200 条
List<Json> trimSessions(List<SessionSummary> sessions) {
  final sorted = [...sessions]
    ..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return [for (final s in sorted.take(maxCached)) slimSession(s)];
}

/// 项目留 200 个（最近添加的优先）
List<Json> trimProjects(List<Project> projects) {
  num added(Project p) => (p.json['addedAt'] as num?) ?? 0;
  final sorted = [...projects]..sort((a, b) => added(b).compareTo(added(a)));
  return [for (final p in sorted.take(maxCached)) p.json];
}

typedef CachedLists = ({List<SessionSummary> sessions, List<Project> projects});

/// 每台电脑一份；写入按电脑节流（间隔内的多次改动合并成最后一次）
class ListCache {
  ListCache(this._store, {this.interval = const Duration(seconds: 1)});
  final CacheStore _store;
  final Duration interval;
  final _pending = <String, ({CachedLists lists, Timer timer})>{};
  final _last = <String, DateTime>{};

  /// 读缓存；没有、坏了、版本不对都返回 null
  Future<CachedLists?> load(String deviceId) async {
    try {
      final raw = await _store.read(_prefix + deviceId);
      if (raw == null) return null;
      final data = jsonDecode(raw);
      if (data is! Map || data['v'] != _version) return null;
      final sessions = [
        for (final s in objList(data['sessions']))
          if (s['state'] is String &&
              obj(s['record'])['id'] is String &&
              obj(s['record'])['projectId'] is String)
            SessionSummary(s),
      ];
      final projects = [
        for (final p in objList(data['projects']))
          if (p['id'] is String && p['name'] is String && p['path'] is String)
            Project(p),
      ];
      return (sessions: sessions, projects: projects);
    } catch (_) {
      return null;
    }
  }

  /// 存一份（节流）：距上次写入不到 interval 就先放着，到点写最后那一份
  void save(String deviceId, CachedLists lists) {
    final pending = _pending[deviceId];
    if (pending != null) {
      _pending[deviceId] = (lists: lists, timer: pending.timer);
      return;
    }
    final last = _last[deviceId];
    final wait = last == null
        ? Duration.zero
        : interval - DateTime.now().difference(last);
    if (wait <= Duration.zero) {
      _write(deviceId, lists);
      return;
    }
    _pending[deviceId] = (
      lists: lists,
      timer: Timer(wait, () => flush(deviceId)),
    );
  }

  /// 马上写掉等着的（切到后台前调用）；不传电脑就全部
  Future<void> flush([String? deviceId]) async {
    for (final id in deviceId != null ? [deviceId] : [..._pending.keys]) {
      final p = _pending.remove(id);
      if (p == null) continue;
      p.timer.cancel();
      await _write(id, p.lists);
    }
  }

  /// 删掉一台电脑的缓存（忘掉电脑时）
  Future<void> drop(String deviceId) async {
    _pending.remove(deviceId)?.timer.cancel();
    _last.remove(deviceId);
    try {
      await _store.remove(_prefix + deviceId);
    } catch (_) {}
  }

  /// 删掉不在 keep 里的电脑的缓存
  Future<void> pruneExcept(Set<String> keep) async {
    try {
      for (final key in await _store.keys()) {
        if (key.startsWith(_prefix) &&
            !keep.contains(key.substring(_prefix.length))) {
          await drop(key.substring(_prefix.length));
        }
      }
    } catch (_) {}
  }

  Future<void> _write(String deviceId, CachedLists lists) async {
    _last[deviceId] = DateTime.now();
    try {
      await _store.write(
        _prefix + deviceId,
        jsonEncode({
          'v': _version,
          'savedAt': DateTime.now().millisecondsSinceEpoch,
          'sessions': trimSessions(lists.sessions),
          'projects': trimProjects(lists.projects),
        }),
      );
    } catch (_) {
      // 存储满了或不可用：下次打开就没有缓存，不影响使用
    }
  }
}
