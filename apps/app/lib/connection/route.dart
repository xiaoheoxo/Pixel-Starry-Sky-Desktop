// 连接线路（docs/mobile-app.md §20）：正式站按 CDN → 直连 → IP 依次试，记住现在用哪档；不在 CDN 时
// 每 10 分钟（和回到前台时）在后台试比它靠前的档，通了就切回来（实时连接等空闲时再换）。
// 「IP」是 TCP 连源站 IP，TLS 的 SNI、证书校验和 Host 仍按直连域名——等于跳过 DNS。
// 只管正式站的两个域名；测试站、局域网、优质节点照旧只连它们自己。
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../app/log.dart';

enum RouteTier { cdn, direct, ip }

const cdnHost = 'pixelstarrysky.xyz';
const directHost = 'direct.pixelstarrysky.xyz';

/// 源站 IP（最后一档；换服务器 IP 要发版，§20.5 第 4 问）
const originIp = '51.81.246.245';

/// 每一档握手 / 请求最多等多久，超时就换下一档
const tierTimeout = Duration(seconds: 8);

/// 不在 CDN 时多久试一次靠前的档
const probeEvery = Duration(minutes: 10);

bool isOfficialHost(String host) {
  final h = host.toLowerCase();
  return h == cdnHost || h == directHost;
}

/// 这一档要连的地址：CDN 档用 CDN 域名，直连和 IP 档用直连域名（IP 档的「换成 IP」在 [clientFor] 的连接工厂里）
Uri tierUrl(Uri url, RouteTier tier) =>
    url.replace(host: tier == RouteTier.cdn ? cdnHost : directHost);

/// 从 current 开始，依次往后，再绕回前面：direct → ip → cdn
List<RouteTier> tierOrder(RouteTier current) {
  const all = RouteTier.values;
  final i = current.index;
  return [...all.sublist(i), ...all.sublist(0, i)];
}

String tierLabel(RouteTier t) => switch (t) {
  RouteTier.cdn => 'CDN',
  RouteTier.direct => '直连',
  RouteTier.ip => 'IP 直连',
};

/// IP 档用的 HttpClient：TCP 连 [ip]:[port]，TLS 按请求里的域名做 SNI 和证书校验
HttpClient ipClient({
  String ip = originIp,
  int? port,
  SecurityContext? context,
}) {
  final client = HttpClient(context: context);
  // 这一档就是要绕开 DNS 直接连源站：不走环境变量里的代理（走代理时 HttpClient 会先发 CONNECT，和下面自己连的冲突）
  client.findProxy = (_) => 'DIRECT';
  client.connectionFactory = (uri, proxyHost, proxyPort) async {
    final task = await Socket.startConnect(
      ip,
      // WebSocket.connect 传进来的地址端口可能是 0（wss 没写端口时）
      port ?? (uri.port > 0 ? uri.port : 443),
    );
    final secure = task.socket.then(
      (s) => SecureSocket.secure(s, host: uri.host, context: context),
    );
    return ConnectionTask.fromSocket(secure, task.cancel);
  };
  return client;
}

/// 这一档用的 HttpClient：IP 档带连接工厂，别的档普通的
HttpClient clientFor(RouteTier tier) =>
    tier == RouteTier.ip ? ipClient() : HttpClient();

/// 这次失败值不值得换一档：连不上、DNS、TLS、超时、没升级成 WebSocket（426）、5xx
bool tierFailure(Object e) =>
    e is SocketException ||
    e is HandshakeException ||
    e is TlsException ||
    e is TimeoutException ||
    e is WebSocketException ||
    e is HttpException ||
    e is RetryOtherTier;

/// HTTP 请求回了 5xx：请求方抛它，换下一档再试
class RetryOtherTier implements Exception {
  const RetryOtherTier(this.reason);
  final String reason;
  @override
  String toString() => reason;
}

/// 简短的失败原因（日志、设置页用）：不带地址参数
String failureReason(Object e) => switch (e) {
  WebSocketException() => '没升级成实时连接（多半是 426）',
  HandshakeException() || TlsException() => 'TLS 失败',
  TimeoutException() => '超时',
  SocketException(osError: final os) when os != null =>
    '连不上（${os.message.isEmpty ? os.errorCode : os.message}）',
  SocketException() => '连不上',
  HttpException(message: final m) => m,
  RetryOtherTier(reason: final r) => r,
  _ => e.runtimeType.toString(),
};

/// 后台试探一档：发 WebSocket 升级请求（不带令牌），拿到 101 / 4xx（不是 426）就算这档的实时连接能通
typedef TierProbe = Future<bool> Function(RouteTier tier);

Future<bool> probeTier(RouteTier tier) async {
  final client = clientFor(tier);
  client.connectionTimeout = tierTimeout;
  try {
    final url = Uri.parse(
      'https://${tier == RouteTier.cdn ? cdnHost : directHost}/v1/bridge/ws?role=probe',
    );
    final req = await client.getUrl(url).timeout(tierTimeout);
    req.headers
      ..set(HttpHeaders.connectionHeader, 'Upgrade')
      ..set(HttpHeaders.upgradeHeader, 'websocket')
      ..set('Sec-WebSocket-Version', '13')
      ..set('Sec-WebSocket-Key', 'cGl4ZWxza3lwcm9iZTE2YQ==');
    final res = await req.close().timeout(tierTimeout);
    final status = res.statusCode;
    if (status == HttpStatus.switchingProtocols) {
      (await res.detachSocket()).destroy();
    } else {
      await res.drain<void>().catchError((Object _) {});
    }
    return status != HttpStatus.upgradeRequired && status < 500;
  } catch (_) {
    return false;
  } finally {
    client.close(force: true);
  }
}

/// 现在用哪档存在哪（测试里换成内存）
abstract interface class RouteStore {
  Future<String?> read();
  Future<void> write(String value);
}

class PrefsRouteStore implements RouteStore {
  final _prefs = SharedPreferencesAsync();
  static const _key = 'connection.routeTier';
  @override
  Future<String?> read() => _prefs.getString(_key);
  @override
  Future<void> write(String value) => _prefs.setString(_key, value);
}

class MemoryRouteStore implements RouteStore {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String v) async => value = v;
}

class RouteState extends ChangeNotifier {
  RouteState({this._store, TierProbe? probe, this.now = DateTime.now})
    : _probe = probe ?? probeTier;

  final RouteStore? _store;
  final TierProbe _probe;
  final DateTime Function() now;

  RouteTier current = RouteTier.cdn;

  /// 最近一次换档：什么时候、为什么（设置页显示）
  DateTime? changedAt;
  String? reason;

  /// 后台试探把 current 往前换了：实时连接等空闲时重连到新档
  final _improved = StreamController<RouteTier>.broadcast();
  Stream<RouteTier> get improved => _improved.stream;

  Timer? _timer;
  bool _probing = false;

  Future<void> load() async {
    final saved = await _store?.read();
    for (final t in RouteTier.values) {
      if (t.name == saved) current = t;
    }
  }

  /// 开始定时试探（App 启动后调一次；回到前台时调 [probeNow]）
  void start() {
    _timer ??= Timer.periodic(probeEvery, (_) => unawaited(probeNow()));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _improved.close();
    super.dispose();
  }

  void _set(RouteTier next, String why) {
    if (next == current) return;
    appLog.info('线路', '从 ${tierLabel(current)} 换到 ${tierLabel(next)}：$why');
    current = next;
    changedAt = now();
    reason = why;
    unawaited(_store?.write(next.name));
    notifyListeners();
  }

  /// 一档用成功了。实时连接成功可以往前、往后换；HTTP 成功只往后换（CDN 的 HTTP 通不代表实时连接通）
  void succeeded(RouteTier tier, {required bool realtime, String? why}) {
    if (tier == current) return;
    if (!realtime && tier.index < current.index) return;
    _set(tier, why ?? '${tierLabel(current)} 连不上');
  }

  /// 不在 CDN 时按顺序试靠前的档，第一个通的就切过去
  Future<void> probeNow() async {
    if (_probing || current == RouteTier.cdn) return;
    _probing = true;
    try {
      for (final t in RouteTier.values) {
        if (t.index >= current.index) break;
        if (await _probe(t)) {
          _set(t, '${tierLabel(t)} 恢复了');
          _improved.add(t);
          break;
        }
      }
    } finally {
      _probing = false;
    }
  }

  /// 按 current 起依次试，[attempt] 抛 [tierFailure] 认的错就换下一档；都失败抛最后一个错。
  /// 第一档以外成功的，记成当前档
  Future<T> run<T>(
    Future<T> Function(RouteTier tier) attempt, {
    required bool realtime,
  }) async {
    Object? last;
    StackTrace? lastStack;
    final failed = <String>[];
    for (final tier in tierOrder(current)) {
      try {
        final result = await attempt(tier);
        succeeded(
          tier,
          realtime: realtime,
          why: failed.isEmpty ? null : failed.join('；'),
        );
        return result;
      } catch (e, st) {
        if (!tierFailure(e)) rethrow;
        failed.add('${tierLabel(tier)} ${failureReason(e)}');
        last = e;
        lastStack = st;
      }
    }
    Error.throwWithStackTrace(last!, lastStack!);
  }
}

/// 全 App 一份（main 里 load / start；测试里各自 new）
final appRoute = RouteState(store: PrefsRouteStore());

/// HTTP 请求按线路走：正式站的地址按三档试；别的地址直接发。[send] 拿到这一档的 HttpClient 和地址，5xx 抛 [RetryOtherTier]
Future<T> routedHttp<T>(
  Uri url,
  Future<T> Function(HttpClient client, Uri url) send, {
  RouteState? route,
}) async {
  if (!isOfficialHost(url.host)) {
    final client = HttpClient();
    try {
      return await send(client, url);
    } finally {
      client.close();
    }
  }
  return (route ?? appRoute).run((tier) async {
    final client = clientFor(tier)..connectionTimeout = tierTimeout;
    try {
      return await send(client, tierUrl(url, tier));
    } finally {
      client.close();
    }
  }, realtime: false);
}
