// 手机和电脑之间的加密连接（照 packages/link/src/index.ts，docs/mobile-remote.md §8.5.2）
export 'bytes.dart';
export 'channel.dart';
export 'frame.dart';
export 'noise.dart' hide hmacSha256, sha256, x25519;
export 'pairing.dart';
export 'rpc.dart';
