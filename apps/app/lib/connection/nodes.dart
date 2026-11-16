// 中转节点（同网页版 apps/mobile/src/connection/nodes.ts，docs/cloud-admin-seats-plan.md §4）：
// 有优质节点权益的账号，电脑连的是另一台中转，二维码里的中转地址就是它。兑换配对码仍在主站，节点只管之后的实时连接。
// 只跟随主站 GET /v1/bridge/nodes 列出的节点（不然改过的二维码能把手机引到任意服务器）。
import 'dart:convert';

import '../link/link.dart';

class RelayNode {
  const RelayNode(this.name, this.url, this.premium);
  final String name;

  /// 中转的 WebSocket 地址（wss://…/v1/bridge/ws）
  final String url;
  final bool premium;
}

const _wsPath = '/v1/bridge/ws';
final _wsScheme = RegExp(r'^wss?://', caseSensitive: false);

/// 规范化成 WebSocket 地址；不是 ws / wss、带用户名密码、解析不了的返回 null
String? wsUrl(Object? raw) {
  if (raw is! String || raw.length > 512 || !_wsScheme.hasMatch(raw)) {
    return null;
  }
  final url = Uri.tryParse(raw);
  if (url == null || url.userInfo.isNotEmpty || url.host.isEmpty) return null;
  // 去掉查询和片段（同 TS 的 url.search = ''、url.hash = ''）
  return Uri(
    scheme: url.scheme.toLowerCase(),
    host: url.host,
    port: url.hasPort ? url.port : null,
    path: url.path.isEmpty || url.path == '/' ? _wsPath : url.path,
  ).toString();
}

/// GET /v1/bridge/nodes 的返回；格式不对的项丢掉
List<RelayNode> parseNodes(Object? raw) {
  final list = raw is Map ? raw['nodes'] : null;
  if (list is! List) return const [];
  final out = <RelayNode>[];
  for (final n in list.take(100)) {
    if (n is! Map) continue;
    final ws = wsUrl(n['url']);
    if (ws == null) continue;
    final name = n['name'];
    out.add(
      RelayNode(
        name is String ? (name.length > 64 ? name.substring(0, 64) : name) : '',
        ws,
        n['premium'] == true,
      ),
    );
  }
  return out;
}

String _originOf(String ws) {
  final u = Uri.parse(ws);
  return '${u.scheme}://${u.host}${u.hasPort ? ':${u.port}' : ''}';
}

/// 二维码里的中转地址在节点列表里（按协议 + 主机 + 端口比）就返回列表里的地址，否则 null
String? matchNode(String? relay, List<RelayNode> nodes) {
  final ws = wsUrl(relay);
  if (ws == null) return null;
  final origin = _originOf(ws);
  for (final n in nodes) {
    if (_originOf(n.url) == origin) return n.url;
  }
  return null;
}

/// 取主站的节点列表（GET 返回 JSON）；出错返回 null
typedef GetJson = Future<Object?> Function(Uri url);

/// 配对时用哪个中转节点：二维码里的地址就是主站、或者不在主站的节点列表里，返回 null（连主站）。
/// 接口 404、连不上、返回不对也是 null
Future<String?> pickNode(String? relay, String origin, GetJson getJson) async {
  if (relay == null) return null;
  try {
    if (bridgeApiBase(relay) == origin) return null;
  } on LinkException {
    return null;
  }
  try {
    return matchNode(
      relay,
      parseNodes(await getJson(Uri.parse('$origin/v1/bridge/nodes'))),
    );
  } catch (_) {
    return null;
  }
}

/// [GetJson] 的 dart:io 实现在 http.dart；这里只放解析，方便测试
Object? decodeJsonBody(String body) {
  try {
    return jsonDecode(body);
  } on FormatException {
    return null;
  }
}
