// ToolData：写操作带回的新状态不会被写之前发出的那次重取盖掉（审查回归）
import 'package:flutter_test/flutter_test.dart';
import 'package:pixelsky_app/connection/connections.dart';
import 'package:pixelsky_app/connection/desktop_link.dart';
import 'package:pixelsky_app/connection/storage.dart';
import 'package:pixelsky_app/data/tools.dart';
import 'package:pixelsky_app/demo/demo.dart';

void main() {
  test('set 之后，之前发出的重取回来也不覆盖', () async {
    final demo = DemoDesktop();
    final connections = Connections(
      store: MemoryPairingStore([demo.pairing]),
      connect: demo.accept,
    );
    await connections.load();
    final device = demo.pairing.deviceId;
    for (
      var i = 0;
      i < 100 && connections.state(device) != LinkState.ready;
      i++
    ) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    expect(connections.state(device), LinkState.ready);

    final data = ToolData(connections, device, 'projectTools:gitStatus', [
      {'projectId': 'p1'},
    ]);
    for (var i = 0; i < 100 && !data.loaded; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    data.reload(); // 写之前发出的重取，还没回来
    data.set({'fresh': true}); // 写操作带回的新状态
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(data.data, {'fresh': true});
    expect(data.loading, isFalse);

    data.dispose();
    connections.dispose();
    demo.dispose();
  });
}
