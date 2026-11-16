// A0 互通探针（docs/mobile-app.md §8）：在命令行里走一遍手机这一侧的完整链路，确认 lib/link 能和电脑端说上话。
// 配对链接 → 用配对码换设备令牌 → 连中转 → 配对请求 → Noise 握手 → hello、engine:sessions、
// 大回复（压缩）和事件 → 发一条大消息（压缩）→ 关闭。每一步打印结果，任何一步不对退出码非 0。
// 只用 lib/link 和 dart:io，不依赖 Flutter。连接的做法照网页版 apps/mobile/src/connection/link.ts。
//
// 用法：dart run tool/link_probe.dart [--scenario <名字>] <配对链接>
// 名字见 _scenarios；反例里篡改帧要中转配合（本机模拟中转按场景改帧），手机这边只核对结果。
// 注意 ok 场景会对第一条会话调 engine:send（发一条测试消息），只对模拟电脑跑。
import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:pixelsky_app/link/link.dart';
import 'package:pixelsky_app/link/noise.dart' show sha256;

const _scenarios = {
  // 完整流程
  'ok': '完整流程',
  // 配对请求的校验码用错的配对密钥算：电脑不理
  'wrong-secret': '配对密钥错误',
  // 配对好以后用另一把长期密钥握手：电脑回 handshake_failed
  'wrong-key': '握手密钥错误',
  // 中转改坏一个发给手机的数据帧：手机的通道作废，重新握手后恢复
  'tamper-down': '篡改发给手机的帧',
  // 中转改坏一个发给电脑的数据帧：电脑的通道作废、不再回复，手机重新握手后恢复
  'tamper-up': '篡改发给电脑的帧',
};

const _phoneName = 'A0 探针（Dart）';

/// 同网页版 link.ts：握手 10 秒、hello 10 秒、其他调用 20 秒
const _handshakeTimeout = Duration(seconds: 10);
const _helloTimeout = Duration(seconds: 10);
const _callTimeout = Duration(seconds: 20);

/// 等电脑上的人点「允许」
const _confirmTimeout = Duration(seconds: 120);

class _Fail implements Exception {
  _Fail(this.message);

  final String message;
}

Never _fail(String message) => throw _Fail(message);

var _step = 0;

void _ok(String title, [String detail = '']) => stdout.writeln(
  '[${++_step}] $title：ok${detail.isEmpty ? '' : '  $detail'}',
);

void _info(String text) => stdout.writeln('    $text');

/// 按到达顺序排队，没有就等；超时返回 null
class _Inbox<T> {
  final _items = Queue<T>();
  Completer<T?>? _waiter;

  void add(T value) {
    final w = _waiter;
    if (w != null) {
      _waiter = null;
      w.complete(value);
    } else {
      _items.add(value);
    }
  }

  Future<T?> next(Duration timeout) {
    if (_items.isNotEmpty) return Future.value(_items.removeFirst());
    final w = _waiter = Completer<T?>();
    return w.future.timeout(
      timeout,
      onTimeout: () {
        if (identical(_waiter, w)) _waiter = null;
        return null;
      },
    );
  }
}

/// 数压缩、解压的次数：大帧真的走了压缩才算数
class _CountingCodec implements Codec {
  int deflated = 0;
  int inflated = 0;

  @override
  Uint8List deflate(Uint8List bytes) {
    final out = deflateRawCodec.deflate(bytes);
    deflated++;
    _info('压缩发出 ${bytes.length} → ${out.length} B');
    return out;
  }

  @override
  Uint8List inflate(Uint8List bytes, int maxBytes) {
    final out = deflateRawCodec.inflate(bytes, maxBytes);
    inflated++;
    _info('解压收到 ${bytes.length} → ${out.length} B');
    return out;
  }
}

/// 电脑把流式增量打包成一帧发来的样子（gateway.ts 的 flush）；同网页版 link.ts 的 unbatch
List<Object?> _unbatch(Object? data) =>
    data is Map && data['kind'] == 'batch' && data['events'] is List
    ? data['events'] as List
    : [data];

/// 一次握手之后的加密会话：通道 + RPC（同 link.ts 的 finish）
class _Session {
  _Session(HandshakeResult keys, void Function(Uint8List) output, this.codec) {
    // 同 link.ts：发送失败（太大）不往外抛，调用等到超时
    rpc = RpcCore((m) => unawaited(channel.send(m).catchError((Object _) {})));
    channel = SecureChannel(
      keys,
      output: output,
      onMessage: (v) => rpc.receive(v),
      onError: (e) {
        if (!error.isCompleted) error.complete(e);
        // 网页版这时重新握手（reset 关掉 rpc）：挂着的调用都失败
        rpc.close(e);
      },
      codec: codec,
    );
    rpc.onEvent = (channel, data) => frames.add((channel, data));
  }

  final _CountingCodec codec;
  late final RpcCore rpc;
  late final SecureChannel channel;
  final error = Completer<Object>();

  /// 每个事件帧（批量的还没拆开）
  final frames = _Inbox<(String, Object?)>();

  /// 通道作废之后又到的数据帧
  int ignored = 0;
}

class _Probe {
  _Probe(this.scenario);

  final String scenario;
  final _codec = _CountingCodec();

  /// dart:io 默认按 HTTP_PROXY / NO_PROXY 环境变量走代理；本机地址总是直连（NO_PROXY 没写时也不绕到代理上）。
  /// 换令牌和 WebSocket 共用这一个
  final _http = HttpClient()
    ..findProxy = (uri) => uri.host == '127.0.0.1' || uri.host == 'localhost'
        ? 'DIRECT'
        : HttpClient.findProxyFromEnvironment(uri);
  WebSocket? _ws;
  bool _closing = false;

  /// 连接关掉了（收到对方的关闭帧或断开）
  final _done = Completer<void>();
  int _ticks = 0;
  final _notices = _Inbox<String>();

  /// 明文的回应：Handshake2 的内容（Uint8List）或配对结果（Map），按到达顺序
  final _replies = _Inbox<Object>();
  _Session? _session;

  Future<void> run(String text) async {
    // 1. 配对链接：二维码现在是网页版链接 http(s)://…/m/#pair=…，App 也认 pixelsky://pair?d=…
    final PairingOffer offer;
    try {
      offer = decodeOffer(text);
    } on LinkException catch (e) {
      _fail('配对链接解析失败：${e.message}');
    }
    final left = offer.expires - DateTime.now().millisecondsSinceEpoch;
    if (left <= 0) _fail('配对链接已经过期');
    final code = offer.code ?? _fail('链接里没有云端配对码（不是经云端配对的二维码）');
    final desktopKey = fromBase64Url(offer.key);
    _ok(
      '解析配对链接',
      '电脑「${offer.name}」指纹 ${fingerprint(desktopKey)}，'
          '中转 ${offer.relay}，${(left / 1000).round()} 秒后过期',
    );

    // 2. 手机长期密钥（App 里存钥匙串 / Keystore）
    final phone = generateKeypair();
    _ok('生成手机长期密钥', '指纹 ${fingerprint(phone.publicKey)}');

    // 3. 用配对码换设备令牌：配对码在电脑申请它的主站进程里，所以去主站兑换（同网页版 connection/index.ts）。
    // 网页链接的来源就是主站；pixelsky:// 链接没有，退回中转地址对应的 https 地址
    final link = Uri.tryParse(text.trim());
    final web =
        link != null && (link.isScheme('http') || link.isScheme('https'));
    final base = web ? link.origin : bridgeApiBase(offer.relay);
    if (bridgeApiBase(offer.relay) != base) {
      // 优质节点：网页版只跟随主站 /v1/bridge/nodes 列出的节点（nodes.ts 的 pickNode），探针没做这一步
      _info('中转 ${offer.relay} 不在主站 $base 上，App 里要先核对主站的节点列表');
    }
    final device = await _redeem(base, code);
    if (device.desktopId != offer.desktop) {
      _fail('云端给的电脑 ID ${device.desktopId} 和链接里的 ${offer.desktop} 不一致');
    }
    _ok('用配对码换设备令牌', 'POST $base/v1/bridge/pair → 设备 ${device.deviceId}');

    // 4. 连中转：令牌放在子协议里，不带 Origin
    final url = Uri.parse(offer.relay);
    final wsUrl = url.replace(
      queryParameters: {...url.queryParameters, 'role': 'phone'},
    );
    final ws = await WebSocket.connect(
      wsUrl.toString(),
      protocols: bridgeProtocols(device.token),
      // 帧都是密文，压不小，不协商 permessage-deflate（dart:io 默认会提）
      compression: CompressionOptions.compressionOff,
      customClient: _http,
    );
    _ws = ws;
    if (ws.protocol != bridgeProtocol) {
      _fail('中转没有选中子协议 $bridgeProtocol（选的是 ${ws.protocol}）');
    }
    ws.listen(
      (data) => data is String
          ? _onText(data)
          : _onFrame(
              data is Uint8List ? data : Uint8List.fromList(data as List<int>),
            ),
      onDone: () {
        if (!_closing) _info('中转断开了（关闭码 ${ws.closeCode}）');
        _done.complete();
      },
    );
    _ok('连中转', '$wsUrl，子协议 ${ws.protocol}');

    // 5. 中转先发一条电脑在不在线
    final online = await _notices.next(_handshakeTimeout);
    if (online != 'desktop_online') {
      _fail('中转没说电脑在线（收到 ${online ?? '无'}）');
    }
    _ok('中转通知', 'desktop_online');

    if (scenario == 'wrong-secret') {
      await _wrongSecret(offer, phone);
      return _close();
    }

    // 6. 配对请求（明文）：等电脑核对校验码 → 用户在电脑上点「允许」
    final request = pairRequest(offer, phone.publicKey, _phoneName);
    _send(FrameType.pair, encodeJson(request.toJson()));
    final pending = await _pairResult(_handshakeTimeout);
    if (pending['status'] != 'pending') _fail('配对结果不是 pending：$pending');
    _ok('发配对请求', '电脑回 ${jsonEncode(pending)}，等电脑上确认');
    final accepted = await _pairResult(_confirmTimeout);
    if (accepted['status'] != 'accepted') _fail('配对结果不是 accepted：$accepted');
    _ok('电脑上确认', '电脑回 ${jsonEncode(accepted)}');

    if (scenario == 'wrong-key') await _wrongKey(desktopKey);

    // 7. 握手、hello
    var s = await _handshake(phone, desktopKey);
    await _hello(s);

    switch (scenario) {
      case 'tamper-down':
        await _tamperDown(s);
        s = await _handshake(phone, desktopKey, again: true);
        await _hello(s);
        await _sessions(s);
      case 'tamper-up':
        await _tamperUp(s);
        s = await _handshake(phone, desktopKey, again: true);
        await _hello(s);
        await _sessions(s);
      case 'wrong-key':
        await _sessions(s);
      default:
        final first = await _sessions(s);
        final seq = await _bigReply(s, first);
        await _events(s, seq);
        await _bigSend(s, first);
    }
    await _close();
  }

  Future<({String deviceId, String token, String desktopId})> _redeem(
    String base,
    String code,
  ) async {
    final req = await _http.postUrl(Uri.parse('$base/v1/bridge/pair'));
    req.headers.contentType = ContentType.json;
    req.add(utf8.encode(jsonEncode({'code': code, 'name': _phoneName})));
    final res = await req.close();
    final text = await utf8.decodeStream(res);
    Object? body;
    try {
      body = jsonDecode(text);
    } on FormatException {
      body = null;
    }
    if (res.statusCode != 200 ||
        body is! Map ||
        body['deviceId'] is! String ||
        body['token'] is! String ||
        body['desktopId'] is! String) {
      _fail('换设备令牌失败：HTTP ${res.statusCode} $text');
    }
    return (
      deviceId: body['deviceId'] as String,
      token: body['token'] as String,
      desktopId: body['desktopId'] as String,
    );
  }

  void _onText(String text) {
    // 中转每 20 秒一条心跳；App 用它判断连接死没死（link.ts 的 DEAD_AFTER）
    if (text == '{"type":"tick"}') {
      _ticks++;
      return;
    }
    try {
      final type = (jsonDecode(text) as Map)['type'];
      if (type is String) _notices.add(type);
    } catch (_) {
      _info('认不出的文本帧：$text');
    }
  }

  void _onFrame(Uint8List frame) {
    final ({FrameType type, Uint8List body}) f;
    try {
      f = decodeFrame(frame);
    } on LinkException {
      _info('收到坏帧（${frame.length} B），丢掉');
      return;
    }
    switch (f.type) {
      case FrameType.pairResult:
        try {
          final r = decodeJson(f.body);
          if (r is Map) _replies.add(r);
        } on LinkException {
          _info('配对结果不是 JSON，丢掉');
        }
      case FrameType.handshake2:
        _replies.add(Uint8List.fromList(f.body));
      case FrameType.data:
        final s = _session;
        if (s == null) return;
        if (s.channel.closed) s.ignored++;
        s.channel.receive(f.body);
      default:
        _info('手机不该收到 ${f.type.name} 帧，丢掉');
    }
  }

  void _send(FrameType type, Uint8List body) =>
      _ws!.add(encodeFrame(type, body));

  Future<Map> _pairResult(Duration timeout) async {
    final r = await _replies.next(timeout);
    if (r == null) _fail('等配对结果超时');
    if (r is! Map) _fail('等配对结果时收到了 Handshake2');
    return r;
  }

  Future<_Session> _handshake(
    Keypair local,
    Uint8List desktopKey, {
    bool again = false,
  }) async {
    // 同 link.ts 的 handshake：先扔掉旧的加密会话
    _session?.rpc.close();
    _session = null;
    final initiator = Initiator(
      local: local,
      remote: desktopKey,
      prologue: prologue,
    );
    final m1 = initiator.writeMessage1();
    _send(FrameType.handshake1, m1);
    final reply = await _replies.next(_handshakeTimeout);
    if (reply == null) _fail('等 Handshake2 超时');
    if (reply is Map) _fail('电脑拒绝握手：${jsonEncode(reply)}');
    final keys = initiator.readMessage2(reply as Uint8List).result;
    final s = _Session(keys, (frame) => _ws?.add(frame), _codec);
    _session = s;
    _ok(
      again ? '重新握手' : 'Noise KK 握手',
      '发 ${m1.length + 1} B、收 ${reply.length + 1} B，'
      '握手哈希 ${toHex(keys.hash).substring(0, 16)}…',
    );
    return s;
  }

  Future<void> _hello(_Session s) async {
    final hello = await s.rpc.call('hello', [
      {'batch': true},
    ], _helloTimeout);
    if (hello is! Map || hello['version'] != linkVersion) {
      _fail('hello 的回复不对：$hello');
    }
    _ok('hello', jsonEncode(hello));
  }

  /// 返回第一条会话的 id
  Future<String> _sessions(_Session s) async {
    final list = await s.rpc.call('engine:sessions', const [], _callTimeout);
    if (list is! List || list.isEmpty) _fail('engine:sessions 的回复不对：$list');
    final titles = <String>[];
    for (final item in list) {
      final record = item is Map ? item['record'] : null;
      if (record is! Map || record['id'] is! String) {
        _fail('会话格式不对：$item');
      }
      // 网关只给手机没归档的、去掉审批内容（gateway.ts 的 phoneSessions）
      if (record['archivedAt'] != null) _fail('收到了归档的会话：${record['id']}');
      if ((item as Map).containsKey('pending')) _fail('会话带着审批内容');
      titles.add('${record['title']}（${item['state']}）');
    }
    _ok('engine:sessions', '${list.length} 条：${titles.join('、')}');
    return ((list.first as Map)['record'] as Map)['id'] as String;
  }

  /// 打开会话拿快照：回复超过 1 KB，电脑压缩后发。返回快照的 seq
  Future<int> _bigReply(_Session s, String id) async {
    final before = s.codec.inflated;
    final tail = await s.rpc.call('engine:openSessionTail', [
      id,
      {'limit': 60},
    ], _callTimeout);
    if (tail is! Map || tail['snapshot'] is! Map || tail['seq'] is! int) {
      _fail('engine:openSessionTail 的回复不对');
    }
    final size = encodeJson(tail).length;
    final items = ((tail['snapshot'] as Map)['items'] as List).length;
    if (size >= 1024 && s.codec.inflated == before) {
      _fail('回复 $size B 超过 1 KB，却没有走压缩');
    }
    _ok(
      'engine:openSessionTail（大回复）',
      '$items 条，JSON $size B，压缩帧解开，seq ${tail['seq']}',
    );
    return tail['seq'] as int;
  }

  /// 打开会话后电脑推的事件：增量打包成一帧、条目完成、会话列表、工具页刷新；会话事件的 seq 要连续
  Future<void> _events(_Session s, int seq) async {
    var next = seq + 1;
    var batches = 0, completed = false, sessions = false, tools = false;
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (batches == 0 || !completed || !sessions || !tools) {
      final wait = deadline.difference(DateTime.now());
      final frame = wait.isNegative ? null : await s.frames.next(wait);
      if (frame == null) {
        _fail(
          '5 秒内没收齐事件（批量 $batches、条目完成 $completed、'
          '会话列表 $sessions、工具 $tools）',
        );
      }
      final (channel, data) = frame;
      final events = _unbatch(data);
      final kinds = <String>[];
      for (final e in events) {
        if (e is! Map) _fail('事件不是对象：$e');
        final kind = e['kind'];
        if (kind == 'session') {
          if (e['seq'] != next) _fail('事件 seq 跳号：等 $next，来了 ${e['seq']}');
          next++;
          final type = (e['event'] as Map)['type'];
          if (type == 'item_completed') completed = true;
          kinds.add('$type#${e['seq']}');
        } else {
          if (kind == 'sessions') sessions = true;
          if (kind == 'tools') tools = true;
          kinds.add('$kind');
        }
      }
      final batch = data is Map && data['kind'] == 'batch';
      if (batch) batches++;
      _info(
        '事件帧 $channel${batch ? '（batch，${events.length} 个）' : ''}：'
        '${kinds.join(' ')}',
      );
    }
    _ok('收事件', '增量打包成 $batches 帧，seq ${seq + 1}–${next - 1} 连续，会话列表和工具刷新都到了');
  }

  /// 发一条超过 1 KB 的消息：Dart 压缩，电脑（Node zlib）解压后算 sha256 回来比
  Future<void> _bigSend(_Session s, String id) async {
    final text = List.generate(
      60,
      (i) => '第 $i 行：中文、emoji 🙂🚀、引号 "x"、反斜杠 \\、制表符\t。',
    ).join('\n');
    final before = s.codec.deflated;
    final r = await s.rpc.call('engine:send', [
      id,
      {
        'text': text,
        'clientMessageId': 'probe-${DateTime.now().millisecondsSinceEpoch}',
      },
    ], _callTimeout);
    final expected = toHex(sha256(utf8.encode(text)));
    if (s.codec.deflated == before) _fail('消息 ${text.length} 字符却没有压缩');
    // chars 是 UTF-16 长度：Dart 和 JS 的 String.length 一样
    if (r is! Map || r['sha256'] != expected || r['chars'] != text.length) {
      _fail('电脑收到的消息不一致：$r，本地 sha256 $expected');
    }
    _ok(
      '发大消息 engine:send',
      '${text.length} 个字符压缩后发出，电脑解开算的 sha256 ${expected.substring(0, 16)}… 一致',
    );
  }

  /// 中转改坏发给手机的第 2 个数据帧（第 1 个是 hello 的回复）：同时调两个，回复都到不了
  Future<void> _tamperDown(_Session s) async {
    final calls = [
      s.rpc.call('engine:sessions', const [], _callTimeout),
      s.rpc.call('hello', [
        {'batch': true},
      ], _helloTimeout),
    ].map((f) => f.then<Object?>((_) => null, onError: (Object e) => e));
    final errors = await Future.wait(calls);
    final error = await s.error.future.timeout(
      const Duration(seconds: 5),
      onTimeout: () => _fail('通道没有作废'),
    );
    if ('$error' != 'LINK_DECRYPT_FAILED') _fail('通道作废的原因不对：$error');
    if (errors.any((e) => e == null)) _fail('篡改之后还有调用成功了：$errors');
    // 等后一个回复到，确认作废之后的帧不再处理
    final deadline = DateTime.now().add(const Duration(seconds: 3));
    while (s.ignored == 0 && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(milliseconds: 50));
    }
    if (s.ignored == 0) _fail('没等到作废之后的帧');
    _ok(
      '篡改的帧被拒',
      '通道报 $error，两个调用都失败（${errors.join('、')}），'
          '作废之后又到的 ${s.ignored} 帧没有处理',
    );
  }

  /// 中转改坏发给电脑的第 2 个数据帧（第 1 个是 hello）：电脑丢掉这条加密会话，不回复
  Future<void> _tamperUp(_Session s) async {
    try {
      await s.rpc.call('engine:sessions', const [], const Duration(seconds: 3));
      _fail('改坏的帧电脑居然回复了');
    } on LinkException catch (e) {
      if (e.message != 'RPC_TIMEOUT: engine:sessions') _fail('调用失败的原因不对：$e');
      _ok('电脑拒收篡改的帧', '电脑那边通道作废、不再回复，这次调用 3 秒后 ${e.message}');
    }
  }

  /// 配对密钥不对：电脑核对校验码不通过，不回结果（gateway.ts 的 onPair，免得被拿来探测）
  Future<void> _wrongSecret(PairingOffer offer, Keypair phone) async {
    final wrong = PairingOffer(
      relay: offer.relay,
      desktop: offer.desktop,
      key: offer.key,
      secret: newPairingSecret(),
      name: offer.name,
      expires: offer.expires,
      code: offer.code,
    );
    final request = pairRequest(wrong, phone.publicKey, _phoneName);
    _send(FrameType.pair, encodeJson(request.toJson()));
    final r = await _replies.next(const Duration(seconds: 3));
    if (r != null) {
      _fail('校验码不对，电脑却回了：${r is Map ? jsonEncode(r) : 'Handshake2'}');
    }
    _ok('校验码算错的配对请求被拒', '3 秒内电脑没有任何回应');
    // 没确认的手机直接握手：中转只放行配对请求，到不了电脑
    final initiator = Initiator(
      local: phone,
      remote: fromBase64Url(offer.key),
      prologue: prologue,
    );
    _send(FrameType.handshake1, initiator.writeMessage1());
    final h = await _replies.next(const Duration(seconds: 2));
    if (h != null) _fail('没确认的手机握手却有回应');
    _ok('没确认就握手', '2 秒内没有回应（中转只放行待确认手机的配对请求）');
  }

  /// 配对时登记的是 phone 的公钥，换一把密钥握手：电脑解不开，回 handshake_failed
  Future<void> _wrongKey(Uint8List desktopKey) async {
    final initiator = Initiator(
      local: generateKeypair(),
      remote: desktopKey,
      prologue: prologue,
    );
    _send(FrameType.handshake1, initiator.writeMessage1());
    final r = await _replies.next(_handshakeTimeout);
    if (r is! Map) _fail('换了密钥握手，电脑却${r == null ? '没有回应' : '回了 Handshake2'}');
    if (r['status'] != 'handshake_failed' || r['v'] != linkVersion) {
      _fail('电脑的回应不对：${jsonEncode(r)}');
    }
    _ok('用别的密钥握手被拒', '电脑回 ${jsonEncode(r)}，没有 Handshake2');
  }

  Future<void> _close() async {
    _closing = true;
    _session?.rpc.close();
    final ws = _ws!;
    await ws.close(WebSocketStatus.normalClosure, 'probe done');
    // close 只等自己的关闭帧发出去；关闭码是对方回的，要等连接真的关掉
    await _done.future.timeout(const Duration(seconds: 2), onTimeout: () {});
    _ok('关闭连接', '关闭码 ${ws.closeCode}，期间收到 $_ticks 次心跳');
  }

  void dispose() {
    _closing = true;
    _session?.rpc.close();
    _ws?.close();
    _http.close(force: true);
  }
}

Future<void> main(List<String> argv) async {
  var scenario = 'ok';
  String? link;
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] == '--scenario' && i + 1 < argv.length) {
      scenario = argv[++i];
    } else {
      link = argv[i];
    }
  }
  if (link == null || !_scenarios.containsKey(scenario)) {
    stderr.writeln(
      '用法：dart run tool/link_probe.dart [--scenario ${_scenarios.keys.join('|')}] <配对链接>',
    );
    exit(2);
  }
  stdout.writeln('场景 $scenario：${_scenarios[scenario]}');
  final probe = _Probe(scenario);
  var code = 0;
  try {
    await probe.run(link).timeout(const Duration(seconds: 60));
    stdout.writeln('通过');
  } on _Fail catch (e) {
    stdout.writeln('失败：${e.message}');
    code = 1;
  } on TimeoutException {
    stdout.writeln('失败：60 秒内没走完');
    code = 1;
  } catch (e) {
    stdout.writeln('失败：$e');
    code = 1;
  } finally {
    probe.dispose();
  }
  await stdout.flush();
  // 挂着的计时器、连接不等了
  exit(code);
}
