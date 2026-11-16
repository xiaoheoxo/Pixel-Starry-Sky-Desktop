// 本机的设置（docs/mobile-app.md §8.2、§8.4）：后台保持连接、面容 / 指纹锁、外观、语言、每台电脑上次选的项目。
// 存在 shared_preferences；persist: false 时只放内存（演示模式、测试）。
import 'package:material_ui/material_ui.dart' show ThemeMode, Locale;
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../i18n/i18n.dart';

/// 外观：跟随系统 / 浅色 / 深色
enum Appearance { system, light, dark }

/// 语言：跟随系统 / 中文 / English
enum LanguageChoice { system, zh, en }

ThemeMode themeModeFor(Appearance a) => switch (a) {
  Appearance.system => ThemeMode.system,
  Appearance.light => ThemeMode.light,
  Appearance.dark => ThemeMode.dark,
};

/// 实际用的语言：选了就用选的，跟随系统时系统是中文就中文、其余英文
AppLanguage resolveLanguage(LanguageChoice choice, Locale system) =>
    switch (choice) {
      LanguageChoice.zh => AppLanguage.zh,
      LanguageChoice.en => AppLanguage.en,
      LanguageChoice.system => languageFor(system),
    };

class AppSettings extends ChangeNotifier {
  AppSettings({SharedPreferencesAsync? prefs, bool persist = true})
    : _prefs = persist ? (prefs ?? SharedPreferencesAsync()) : null;

  final SharedPreferencesAsync? _prefs;
  static const _keepAliveKey = 'pixelsky.keepAlive';
  static const _lockKey = 'pixelsky.lock';
  static const _appearanceKey = 'pixelsky.appearance';
  static const _languageKey = 'pixelsky.language';
  static const _projectKey = 'pixelsky.project.';

  /// 切到后台时保持和电脑的连接（安卓前台服务），默认开
  bool keepAlive = true;

  /// 打开 App 时先验证面容 / 指纹，默认关
  bool lock = false;

  Appearance appearance = Appearance.system;
  LanguageChoice language = LanguageChoice.system;

  /// 每台电脑上次在工具里选的项目
  final _projects = <String, String>{};

  T _parse<T extends Enum>(List<T> values, String? name, T fallback) {
    for (final v in values) {
      if (v.name == name) return v;
    }
    return fallback;
  }

  Future<void> load() async {
    final p = _prefs;
    if (p == null) return;
    try {
      keepAlive = await p.getBool(_keepAliveKey) ?? true;
      lock = await p.getBool(_lockKey) ?? false;
      appearance = _parse(
        Appearance.values,
        await p.getString(_appearanceKey),
        Appearance.system,
      );
      language = _parse(
        LanguageChoice.values,
        await p.getString(_languageKey),
        LanguageChoice.system,
      );
      final all = await p.getAll();
      for (final e in all.entries) {
        if (e.key.startsWith(_projectKey) && e.value is String) {
          _projects[e.key.substring(_projectKey.length)] = e.value as String;
        }
      }
    } catch (_) {}
    notifyListeners();
  }

  Future<void> setKeepAlive(bool v) async {
    keepAlive = v;
    notifyListeners();
    await _prefs?.setBool(_keepAliveKey, v);
  }

  Future<void> setLock(bool v) async {
    lock = v;
    notifyListeners();
    await _prefs?.setBool(_lockKey, v);
  }

  Future<void> setAppearance(Appearance v) async {
    appearance = v;
    notifyListeners();
    await _prefs?.setString(_appearanceKey, v.name);
  }

  Future<void> setLanguage(LanguageChoice v) async {
    language = v;
    notifyListeners();
    await _prefs?.setString(_languageKey, v.name);
  }

  String? projectFor(String deviceId) => _projects[deviceId];

  Future<void> setProjectFor(String deviceId, String projectId) async {
    if (_projects[deviceId] == projectId) return;
    _projects[deviceId] = projectId;
    await _prefs?.setString('$_projectKey$deviceId', projectId);
  }

  /// 忘掉电脑时一起删掉
  Future<void> forgetDevice(String deviceId) async {
    _projects.remove(deviceId);
    await _prefs?.remove('$_projectKey$deviceId');
  }
}
