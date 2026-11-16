// 配对过的电脑存在系统钥匙串 / Keystore（docs/mobile-app.md §1：网页版存 localStorage，会被 Safari 清掉）。
// 存的是整个列表的 JSON；当前看的电脑 id 不敏感，也放在这里，少一种存储。
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'pairing.dart';

abstract interface class PairingStore {
  Future<List<Pairing>> load();
  Future<void> save(List<Pairing> list);
  Future<String?> activeDevice();
  Future<void> setActiveDevice(String? id);
}

class SecurePairingStore implements PairingStore {
  SecurePairingStore([FlutterSecureStorage? storage])
    : _storage = storage ?? const FlutterSecureStorage(iOptions: _ios);

  /// iOS 钥匙串：首次解锁后可读（后台重连要用），只在这台手机（不进 iCloud 钥匙串、换机迁移不带过去）。
  /// 安卓默认就用 Keystore 加密；AndroidManifest 关了自动备份，配对密钥不会恢复到别的手机上
  static const _ios = IOSOptions(
    accessibility: KeychainAccessibility.first_unlock_this_device,
    synchronizable: false,
  );

  final FlutterSecureStorage _storage;
  static const _key = 'pixelsky.pairings';
  static const _active = 'pixelsky.active';

  @override
  Future<List<Pairing>> load() async {
    try {
      final raw = await _storage.read(key: _key);
      final list = raw == null ? null : jsonDecode(raw);
      return list is List
          ? [for (final p in list.map(Pairing.fromJson)) ?p]
          : const [];
    } catch (_) {
      // 读不出来（系统钥匙串出错、内容坏了）：当成没有配对，用户重新扫码
      return const [];
    }
  }

  @override
  Future<void> save(List<Pairing> list) => _storage.write(
    key: _key,
    value: jsonEncode([for (final p in list) p.toJson()]),
  );

  @override
  Future<String?> activeDevice() => _storage.read(key: _active);

  @override
  Future<void> setActiveDevice(String? id) => id == null
      ? _storage.delete(key: _active)
      : _storage.write(key: _active, value: id);
}

/// 测试和演示模式用：只在内存里
class MemoryPairingStore implements PairingStore {
  MemoryPairingStore([List<Pairing> initial = const []])
    : _list = List.of(initial);
  List<Pairing> _list;
  String? _active;

  @override
  Future<List<Pairing>> load() async => List.of(_list);
  @override
  Future<void> save(List<Pairing> list) async => _list = List.of(list);
  @override
  Future<String?> activeDevice() async => _active;
  @override
  Future<void> setActiveDevice(String? id) async => _active = id;
}
