// 反馈里带的手机信息（docs/mobile-app.md §8.5）：App 版本、系统和版本、机型。拿不到的项省掉
import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';

import '../app/version.dart';
import '../data/feedback.dart';

Future<String> phoneInfo() async {
  var os = Platform.operatingSystem;
  var model = '';
  try {
    final info = DeviceInfoPlugin();
    if (Platform.isAndroid) {
      final a = await info.androidInfo;
      os = 'Android ${a.version.release}';
      model = '${a.manufacturer} ${a.model}'.trim();
    } else if (Platform.isIOS) {
      final i = await info.iosInfo;
      os = '${i.systemName} ${i.systemVersion}';
      model = i.utsname.machine;
    }
  } catch (_) {
    // 用平台名
  }
  return phoneInfoLine(appVersion, os, model);
}
