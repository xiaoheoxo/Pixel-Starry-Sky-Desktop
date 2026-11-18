// App 内检查更新（docs/mobile-app.md §16.1）：latest.json 校验、比版本号、跳过、下载核对后才安装
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/data/app_update.dart';
import 'package:pixelsky_app/demo/demo_update.dart';

Map<String, Object?> _manifest({
  Object? build = 3,
  String file = 'pixelsky-0.2.1.apk',
  String? sha,
}) => {
  'version': '0.2.1',
  'build': build,
  'file': file,
  'size': 100,
  'sha256': sha ?? DemoUpdatePlatform.sha,
  'notes': 'n',
};

class _Fake extends DemoUpdatePlatform {
  _Fake(this.manifest, {this.hash}) : super(step: Duration.zero);
  Object? manifest;
  final String? hash;
  @override
  Future<Object?> fetchManifest() async => manifest;
  @override
  Future<String> download(
    String url,
    String path,
    void Function(int got) onProgress,
  ) async {
    onProgress(50);
    onProgress(100);
    return hash ?? DemoUpdatePlatform.sha;
  }
}

void main() {
  test('latest.json：地址只拼在正式站下载目录下，缺字段、文件名带路径、sha256 不对都不认', () {
    final r = AppRelease.parse(_manifest())!;
    expect(r.url, 'https://pixelstarrysky.xyz/download/app/pixelsky-0.2.1.apk');
    expect(r.build, 3);
    expect(AppRelease.parse(_manifest(file: '../evil.apk')), isNull);
    expect(AppRelease.parse(_manifest(file: 'https://x.com/a.apk')), isNull);
    expect(AppRelease.parse(_manifest(build: '3')), isNull);
    expect(AppRelease.parse(_manifest(sha: 'abc')), isNull);
    expect(AppRelease.parse('nope'), isNull);
  });

  test('只提示比自己新、没跳过的版本；跳过记下来', () async {
    int? saved;
    final u = AppUpdater(
      platform: _Fake(_manifest()),
      currentBuild: 2,
      onSkip: (b) async => saved = b,
    );
    await u.check();
    expect(u.available?.version, '0.2.1');
    await u.skip();
    expect(u.available, isNull);
    expect(saved, 3);
    await u.check();
    expect(u.available, isNull);

    final same = AppUpdater(platform: _Fake(_manifest()), currentBuild: 3);
    await same.check();
    expect(same.available, isNull);

    // 没网、坏数据：不提示、不抛
    final bad = AppUpdater(platform: _Fake('{'), currentBuild: 1);
    await bad.check();
    expect(bad.available, isNull);
  });

  test('下载核对：sha256 对上才调起安装，对不上不装、写原因', () async {
    final ok = _Fake(_manifest());
    final u = AppUpdater(platform: ok, currentBuild: 2);
    await u.check();
    await u.downloadAndInstall();
    expect(u.step, UpdateStep.ready);
    expect(u.progress, 1);
    expect(ok.installs, 1);

    final wrong = _Fake(_manifest(), hash: '0' * 64);
    final v = AppUpdater(platform: wrong, currentBuild: 2);
    await v.check();
    await v.downloadAndInstall();
    expect(v.step, UpdateStep.failed);
    expect(v.error, 'sha256');
    expect(wrong.installs, 0);
  });
}
