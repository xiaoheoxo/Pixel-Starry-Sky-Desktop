import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/connection/pairing.dart';

void main() {
  test('正式站 CDN 域名的中转改走直连域名（CDN 去掉 WebSocket 升级头），别的地址照旧', () {
    expect(
      originRelay('https://pixelstarrysky.xyz').toString(),
      'wss://direct.pixelstarrysky.xyz/v1/bridge/ws',
    );
    expect(
      originRelay('https://direct.pixelstarrysky.xyz').toString(),
      'wss://direct.pixelstarrysky.xyz/v1/bridge/ws',
    );
    expect(
      originRelay('https://auth.example.com').toString(),
      'wss://auth.example.com/v1/bridge/ws',
    );
    expect(
      originRelay('http://192.168.1.5:9080').toString(),
      'ws://192.168.1.5:9080/v1/bridge/ws',
    );
  });
}
