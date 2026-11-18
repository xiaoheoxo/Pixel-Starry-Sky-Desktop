// 演示模式的 App 内更新（docs/mobile-app.md §16.1）：给一个比自己新的假版本，下载一秒走完，不真的安装
import 'dart:async';

import '../app/version.dart';
import '../data/app_update.dart';

class DemoUpdatePlatform implements UpdatePlatform {
  DemoUpdatePlatform({this.step = const Duration(milliseconds: 100)});
  final Duration step;

  static const sha =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  /// 安装被调过几次（测试看）
  int installs = 0;

  @override
  Future<Object?> fetchManifest() async => {
    'version': '0.2.1',
    'build': appBuild + 1,
    'file': 'pixelsky-0.2.1.apk',
    'size': 31457280,
    'sha256': sha,
    'notes': '手机上能看团队频道、收件箱，直接同意队友派的活；回复里的 SVG 图能显示了。',
  };

  @override
  Future<String> download(
    String url,
    String path,
    void Function(int got) onProgress,
  ) async {
    for (var i = 1; i <= 10; i++) {
      await Future<void>.delayed(step);
      onProgress(31457280 * i ~/ 10);
    }
    return sha;
  }

  @override
  Future<String> cacheDir() async => '/demo';

  @override
  Future<bool> install(String path) async {
    installs++;
    return true;
  }
}
