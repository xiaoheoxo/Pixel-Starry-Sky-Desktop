// Noise_KK_25519_ChaChaPoly_SHA256（https://noiseprotocol.org/noise.html），照 packages/link/src/noise.ts：
// 配对之后双方都知道对方的长期公钥。手机是发起方，电脑是响应方。
// 用官方测试向量和 TS 导出的样例核对（test/link/noise_test.dart），改动这里之后测试必须仍然全过。
//
// 加密库用 cryptography 包里的纯 Dart 实现（Dart* 类）：都有同步接口，收发和 TS 一样同步加解密，
// 计数和到达顺序一一对应；安卓、iOS 都能跑，不依赖平台插件。
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

import 'bytes.dart';

class Keypair {
  const Keypair({required this.privateKey, required this.publicKey});

  final Uint8List privateKey;
  final Uint8List publicKey;
}

final _random = Random.secure();

Keypair generateKeypair() => keypairFrom(
  Uint8List.fromList(List.generate(keyLength, (_) => _random.nextInt(256))),
);

/// 私钥原样保留（不先截位），算的时候按 RFC 7748 截位，同 noble 的 x25519
Keypair keypairFrom(Uint8List privateKey) =>
    Keypair(privateKey: privateKey, publicKey: x25519(privateKey, _basepoint));

const _protocol = 'Noise_KK_25519_ChaChaPoly_SHA256';
const keyLength = 32;
const _tagLength = 16;
final _empty = Uint8List(0);
final _basepoint = Uint8List(32)..[0] = 9;

const _x25519 = DartX25519();
const _aead = DartChacha20.poly1305Aead();
const _sha256 = DartSha256();
const _hmac = DartHmac(_sha256);

// RFC 7748：u 去掉最高位、按模 p 看。noble 在计算前拒绝这几个低阶点，这里一样拒绝（结果全 0 也拒绝）
final _p = (BigInt.one << 255) - BigInt.from(19);
final _lowOrder = {
  BigInt.zero,
  BigInt.one,
  _p - BigInt.one,
  BigInt.parse(
    '325606250916557431795983626356110631294008115727848805560023387167927233504',
  ),
  BigInt.parse(
    '39382357235489614581723060781553021112529911719440698176882885853963445705823',
  ),
};

bool _isLowOrder(Uint8List u) {
  var n = BigInt.zero;
  for (var i = 31; i >= 0; i--) {
    n = (n << 8) | BigInt.from(i == 31 ? u[i] & 0x7f : u[i]);
  }
  return _lowOrder.contains(n % _p);
}

/// X25519(scalar, u)。低阶点、长度不对都报 LINK_HANDSHAKE_FAILED（同 noise.ts 的 dh）；只在本库和测试里用
Uint8List x25519(Uint8List scalar, Uint8List u) {
  if (scalar.length != keyLength || u.length != keyLength || _isLowOrder(u)) {
    throw const LinkException('LINK_HANDSHAKE_FAILED');
  }
  final type = KeyPairType.x25519;
  final secret = _x25519.sharedSecretSync(
    // 算共享密钥用不到自己的公钥，这里随便给一个
    keyPairData: SimpleKeyPairData(
      scalar,
      publicKey: SimplePublicKey(_basepoint, type: type),
      type: type,
    ),
    remotePublicKey: SimplePublicKey(u, type: type),
  );
  final out = Uint8List.fromList((secret as SecretKeyData).bytes);
  if (out.every((b) => b == 0)) {
    throw const LinkException('LINK_HANDSHAKE_FAILED');
  }
  return out;
}

/// SHA-256 和 HMAC-SHA256：配对校验码、指纹也用（pairing.dart）
Uint8List sha256(List<int> data) =>
    Uint8List.fromList(_sha256.hashSync(data).bytes);

Uint8List hmacSha256(List<int> key, List<int> data) => Uint8List.fromList(
  _hmac
      .calculateMacSync(data, secretKeyData: SecretKeyData(key), nonce: _empty)
      .bytes,
);

/// Noise 的 nonce：4 字节 0 + 8 字节小端计数
Uint8List _nonce(int n) {
  final b = Uint8List(12);
  for (var i = 0; i < 8; i++) {
    b[4 + i] = (n >> (8 * i)) & 0xff;
  }
  return b;
}

Uint8List _encrypt(SecretKeyData key, int n, List<int> ad, List<int> plain) {
  final box = _aead.encryptSync(
    plain,
    secretKey: key,
    nonce: _nonce(n),
    aad: ad,
  );
  return concat([box.cipherText, box.mac.bytes]);
}

/// 解不开（标签不对）抛错，由调用方换成各自的错误码
Uint8List _decrypt(SecretKeyData key, int n, List<int> ad, Uint8List data) {
  final split = data.length - _tagLength;
  final box = SecretBox(
    Uint8List.sublistView(data, 0, split),
    nonce: _nonce(n),
    mac: Mac(Uint8List.sublistView(data, split)),
  );
  return Uint8List.fromList(_aead.decryptSync(box, secretKey: key, aad: ad));
}

(Uint8List, Uint8List) _hkdf2(Uint8List ck, List<int> ikm) {
  final temp = hmacSha256(ck, ikm);
  final out1 = hmacSha256(temp, const [1]);
  return (
    out1,
    hmacSha256(
      temp,
      concat([
        out1,
        const [2],
      ]),
    ),
  );
}

/// 握手之后一个方向的密钥。计数只在成功时前进；失败一次调用方就该断开（不再信任这条连接）
class CipherState {
  CipherState(Uint8List key) : _key = SecretKeyData(key);

  final SecretKeyData _key;
  int _n = 0;

  Uint8List seal(Uint8List plaintext, [Uint8List? ad]) =>
      _encrypt(_key, _n++, ad ?? _empty, plaintext);

  Uint8List open(Uint8List ciphertext, [Uint8List? ad]) {
    if (ciphertext.length < _tagLength) {
      throw const LinkException('LINK_DECRYPT_FAILED');
    }
    final Uint8List plaintext;
    try {
      plaintext = _decrypt(_key, _n, ad ?? _empty, ciphertext);
    } catch (_) {
      throw const LinkException('LINK_DECRYPT_FAILED');
    }
    _n++;
    return plaintext;
  }
}

class HandshakeResult {
  const HandshakeResult({
    required this.send,
    required this.receive,
    required this.hash,
    required this.remoteStatic,
  });

  final CipherState send;
  final CipherState receive;

  /// 握手哈希：两端相同，可用于以后的通道绑定
  final Uint8List hash;

  /// 对方的长期公钥（KK 里双方本来就知道，这里原样返回方便核对）
  final Uint8List remoteStatic;
}

class _SymmetricState {
  _SymmetricState(Uint8List prologue) {
    // 协议名正好 32 字节（= HASHLEN），直接作为初始 h
    h = toUtf8(_protocol);
    ck = h;
    mixHash(prologue);
  }

  late Uint8List h;
  late Uint8List ck;
  SecretKeyData? _k;
  int _n = 0;

  void mixHash(List<int> data) => h = sha256(concat([h, data]));

  void mixKey(List<int> ikm) {
    final (ck2, k) = _hkdf2(ck, ikm);
    ck = ck2;
    _k = SecretKeyData(k);
    _n = 0;
  }

  Uint8List encryptAndHash(Uint8List plaintext) {
    final k = _k;
    final out = k == null ? plaintext : _encrypt(k, _n++, h, plaintext);
    mixHash(out);
    return out;
  }

  Uint8List decryptAndHash(Uint8List ciphertext) {
    var out = ciphertext;
    final k = _k;
    if (k != null) {
      try {
        out = _decrypt(k, _n, h, ciphertext);
      } catch (_) {
        throw const LinkException('LINK_HANDSHAKE_FAILED');
      }
      _n++;
    }
    mixHash(ciphertext);
    return out;
  }

  (CipherState, CipherState) split() {
    final (k1, k2) = _hkdf2(ck, _empty);
    return (CipherState(k1), CipherState(k2));
  }
}

void _checkKey(Uint8List key) {
  if (key.length != keyLength) {
    throw const LinkException('LINK_HANDSHAKE_FAILED');
  }
}

/// 发起方：fresh → started（发了第一条）→ done；响应方：fresh → started（读了第一条）→ done
enum _State { fresh, started, done }

/// 发起方（手机）：writeMessage1 → 收到对方回复后 readMessage2
class Initiator {
  /// [local] 自己的长期密钥；[remote] 对方的长期公钥（配对时记下的）；
  /// [prologue] 双方必须一致的前缀，把协议版本绑进握手；[ephemeral] 只给测试固定临时密钥用
  Initiator({
    required Keypair local,
    required Uint8List remote,
    Uint8List? prologue,
    Keypair? ephemeral,
  }) : _local = local,
       _remote = remote,
       _ss = _SymmetricState(prologue ?? _empty) {
    _checkKey(remote);
    _ss
      ..mixHash(local.publicKey)
      ..mixHash(remote);
    _e = ephemeral ?? generateKeypair();
  }

  final Keypair _local;
  final Uint8List _remote;
  final _SymmetricState _ss;
  late final Keypair _e;
  _State _state = _State.fresh;

  // -> e, es, ss
  Uint8List writeMessage1([Uint8List? payload]) {
    if (_state != _State.fresh) {
      throw const LinkException('LINK_HANDSHAKE_FAILED');
    }
    _state = _State.started;
    _ss
      ..mixHash(_e.publicKey)
      ..mixKey(x25519(_e.privateKey, _remote))
      ..mixKey(x25519(_local.privateKey, _remote));
    return concat([_e.publicKey, _ss.encryptAndHash(payload ?? _empty)]);
  }

  // <- e, ee, se
  ({Uint8List payload, HandshakeResult result}) readMessage2(
    Uint8List message,
  ) {
    if (_state != _State.started || message.length < keyLength + _tagLength) {
      throw const LinkException('LINK_HANDSHAKE_FAILED');
    }
    _state = _State.done;
    final re = Uint8List.fromList(message.sublist(0, keyLength));
    _ss
      ..mixHash(re)
      ..mixKey(x25519(_e.privateKey, re))
      ..mixKey(x25519(_local.privateKey, re));
    final payload = _ss.decryptAndHash(
      Uint8List.fromList(message.sublist(keyLength)),
    );
    final (toResponder, toInitiator) = _ss.split();
    return (
      payload: payload,
      result: HandshakeResult(
        send: toResponder,
        receive: toInitiator,
        hash: _ss.h,
        remoteStatic: _remote,
      ),
    );
  }
}

/// 响应方（电脑）：readMessage1 → writeMessage2。App 里不用，留着做两端互通的测试
class Responder {
  Responder({
    required Keypair local,
    required Uint8List remote,
    Uint8List? prologue,
    Keypair? ephemeral,
  }) : _local = local,
       _remote = remote,
       _ss = _SymmetricState(prologue ?? _empty) {
    _checkKey(remote);
    _ss
      ..mixHash(remote)
      ..mixHash(local.publicKey);
    _e = ephemeral ?? generateKeypair();
  }

  final Keypair _local;
  final Uint8List _remote;
  final _SymmetricState _ss;
  late final Keypair _e;
  Uint8List? _re;
  _State _state = _State.fresh;

  Uint8List readMessage1(Uint8List message) {
    if (_state != _State.fresh || message.length < keyLength + _tagLength) {
      throw const LinkException('LINK_HANDSHAKE_FAILED');
    }
    // 先改状态、记下对方临时公钥，再算：同 TS，解不开之后的状态也一样
    _state = _State.started;
    final re = _re = Uint8List.fromList(message.sublist(0, keyLength));
    _ss
      ..mixHash(re)
      ..mixKey(x25519(_local.privateKey, re))
      ..mixKey(x25519(_local.privateKey, _remote));
    return _ss.decryptAndHash(Uint8List.fromList(message.sublist(keyLength)));
  }

  ({Uint8List message, HandshakeResult result}) writeMessage2([
    Uint8List? payload,
  ]) {
    final re = _re;
    if (_state != _State.started || re == null) {
      throw const LinkException('LINK_HANDSHAKE_FAILED');
    }
    _state = _State.done;
    _ss
      ..mixHash(_e.publicKey)
      ..mixKey(x25519(_e.privateKey, re))
      ..mixKey(x25519(_e.privateKey, _remote));
    final message = concat([
      _e.publicKey,
      _ss.encryptAndHash(payload ?? _empty),
    ]);
    final (toResponder, toInitiator) = _ss.split();
    return (
      message: message,
      result: HandshakeResult(
        send: toInitiator,
        receive: toResponder,
        hash: _ss.h,
        remoteStatic: _remote,
      ),
    );
  }
}
