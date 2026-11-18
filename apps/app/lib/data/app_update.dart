// App 内检查更新（docs/mobile-app.md §16.1，D333）：启动时和每 12 小时读一次正式站的 latest.json，
// 版本号数字（pubspec 的 +N）比自己大就提示；App 里下载、边下边算 sha256，对上了调起系统安装。
// 只认 https://pixelstarrysky.xyz/download/app/ 下的文件；APK 签名对不上系统本来就装不上。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../app/log.dart';
import '../app/version.dart';
import '../protocol/json.dart';
import '../connection/route.dart';

const appUpdateBase = 'https://pixelstarrysky.xyz/download/app/';
const appUpdateManifest = '${appUpdateBase}latest.json';

/// latest.json 里的一个版本
class AppRelease {
  const AppRelease({
    required this.version,
    required this.build,
    required this.url,
    required this.size,
    required this.sha256,
    required this.notes,
  });
  final String version;
  final int build;
  final String url;
  final int size;
  final String sha256;
  final String notes;

  /// 不对的（缺字段、地址不在正式站的下载目录、sha256 不是 64 位十六进制）返回 null
  static AppRelease? parse(Object? raw) {
    final j = objOrNull(raw);
    if (j == null) return null;
    final version = str(j['version']);
    final build = j['build'];
    final file = str(j['file']);
    final size = j['size'];
    final sha = str(j['sha256'])?.toLowerCase();
    if (version == null ||
        build is! int ||
        build <= 0 ||
        file == null ||
        !RegExp(r'^[A-Za-z0-9._-]+\.apk$').hasMatch(file) ||
        size is! int ||
        size <= 0 ||
        sha == null ||
        !RegExp(r'^[0-9a-f]{64}$').hasMatch(sha)) {
      return null;
    }
    return AppRelease(
      version: version,
      build: build,
      url: '$appUpdateBase$file',
      size: size,
      sha256: sha,
      notes: str(j['notes']) ?? '',
    );
  }
}

/// 网络和安装（测试、演示换成假的）
abstract interface class UpdatePlatform {
  Future<Object?> fetchManifest();

  /// 下载到 path，每收到一块报一次已下载的字节数；返回文件的 sha256（十六进制）
  Future<String> download(
    String url,
    String path,
    void Function(int got) onProgress,
  );

  /// 放安装包的目录（安卓：App 的缓存目录，FileProvider 认它）
  Future<String> cacheDir();

  /// 调起系统安装；还没允许「安装未知应用」时返回 false（已经跳到系统设置）
  Future<bool> install(String path);
}

class IoUpdatePlatform implements UpdatePlatform {
  const IoUpdatePlatform();
  static const _channel = MethodChannel('pixelsky/update');

  @override
  // 正式站的地址按线路（CDN → 直连 → IP，docs/mobile-app.md §20）试；换档后路径不变，APK 照旧核 sha256
  Future<Object?> fetchManifest() =>
      routedHttp(Uri.parse(appUpdateManifest), (client, url) async {
        final req = await client.getUrl(url).timeout(tierTimeout);
        final res = await req.close().timeout(const Duration(seconds: 20));
        if (res.statusCode >= 500) {
          throw RetryOtherTier('HTTP ${res.statusCode}');
        }
        if (res.statusCode != 200) {
          throw HttpException('HTTP ${res.statusCode}');
        }
        final text = await res.transform(const Utf8Decoder()).join();
        return jsonDecode(text);
      });

  @override
  Future<String> download(
    String url,
    String path,
    void Function(int got) onProgress,
  ) async {
    final file = File(path);
    await file.parent.create(recursive: true);
    // 换一档时从头下（文件、哈希都重来）
    return routedHttp(Uri.parse(url), (client, url) async {
      final sink = Sha256().toSync().newHashSink();
      final out = file.openWrite();
      try {
        final req = await client.getUrl(url).timeout(tierTimeout);
        final res = await req.close().timeout(const Duration(seconds: 20));
        if (res.statusCode >= 500) {
          throw RetryOtherTier('HTTP ${res.statusCode}');
        }
        if (res.statusCode != 200) {
          throw HttpException('HTTP ${res.statusCode}');
        }
        var got = 0;
        onProgress(0);
        // 一分钟没收到数据算断了（不然卡在「正在下载」，按钮一直灰着）
        await for (final chunk in res.timeout(const Duration(minutes: 1))) {
          sink.add(chunk);
          out.add(chunk);
          got += chunk.length;
          onProgress(got);
        }
      } finally {
        await out.close();
      }
      sink.close();
      final hash = await sink.hash();
      return [for (final b in hash.bytes) b.toRadixString(16).padLeft(2, '0')]
          .join();
    });
  }

  @override
  Future<String> cacheDir() async =>
      await _channel.invokeMethod<String>('cacheDir') ??
      Directory.systemTemp.path;

  @override
  Future<bool> install(String path) async =>
      await _channel.invokeMethod<bool>('install', {'path': path}) ?? false;
}

enum UpdateStep { idle, downloading, ready, failed }

class AppUpdater extends ChangeNotifier {
  AppUpdater({
    required this.platform,
    this.currentBuild = appBuild,
    this.skipped,
    this.onSkip,
    this.every = const Duration(hours: 12),
  });

  final UpdatePlatform platform;
  final int currentBuild;

  /// 「这版不再提醒」记下的版本号数字
  int? skipped;
  final Future<void> Function(int build)? onSkip;
  final Duration every;
  Timer? _timer;

  /// 有比自己新、没被跳过的版本
  AppRelease? available;
  UpdateStep step = UpdateStep.idle;

  /// 下载进度 0–1
  double progress = 0;
  String? error;
  String? _file;

  /// 启动时查一次，之后每 12 小时一次（只在安卓上做：iOS 还没有能装的版本）
  void start() {
    unawaited(check());
    _timer ??= Timer.periodic(every, (_) => check());
  }

  Future<void> check() async {
    try {
      final r = AppRelease.parse(await platform.fetchManifest());
      final next = r != null && r.build > currentBuild && r.build != skipped
          ? r
          : null;
      if (next?.build != available?.build) {
        available = next;
        step = UpdateStep.idle;
        progress = 0;
        error = null;
        notifyListeners();
      }
    } catch (e) {
      // 没网、正式站没有：下次再查，不打扰（只记一行日志）
      appLog.info('更新', '检查更新失败：$e');
    }
  }

  Future<void> skip() async {
    final r = available;
    if (r == null) return;
    skipped = r.build;
    available = null;
    notifyListeners();
    await onSkip?.call(r.build);
  }

  /// 下载、核对，然后调起安装；已经下好了就直接安装
  Future<void> downloadAndInstall() async {
    final r = available;
    if (r == null || step == UpdateStep.downloading) return;
    if (step != UpdateStep.ready || _file == null) {
      step = UpdateStep.downloading;
      progress = 0;
      error = null;
      notifyListeners();
      try {
        // 固定文件名：每次覆盖，缓存里不攒旧包；也不把清单里的字符串拼进路径
        final path = '${await platform.cacheDir()}/update/pixelsky-update.apk';
        final hash = await platform.download(r.url, path, (got) {
          progress = (got / r.size).clamp(0, 1).toDouble();
          notifyListeners();
        });
        if (hash != r.sha256) throw const FormatException('sha256');
        _file = path;
        step = UpdateStep.ready;
        notifyListeners();
      } catch (e) {
        step = UpdateStep.failed;
        error = e is FormatException ? 'sha256' : '$e';
        appLog.error('更新', '下载 ${r.version} 失败：$error');
        notifyListeners();
        return;
      }
    }
    await platform.install(_file!);
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
