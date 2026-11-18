import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/connection/pairing.dart';

void main() {
  test('主站地址换成中转地址：https → wss、http → ws；正式站走哪个域名由线路定（route_test）', () {
    expect(
      originRelay('https://pixelstarrysky.xyz').toString(),
      'wss://pixelstarrysky.xyz/v1/bridge/ws',
    );
    expect(
      originRelay('http://192.168.1.5:9080').toString(),
      'ws://192.168.1.5:9080/v1/bridge/ws',
    );
  });
}
