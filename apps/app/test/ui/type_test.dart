// 字号层级（docs/mobile-app.md §8.3）：系统字体调大时最多放大到 1.3 倍，调小照常跟随。
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:pixelsky_app/ui/theme/type.dart';

void main() {
  Future<double> scaleUnder(WidgetTester tester, double system) async {
    late double got;
    await tester.pumpWidget(
      MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(system)),
        child: Builder(
          builder: (context) => clampTextScale(
            context,
            Builder(
              builder: (context) {
                got = MediaQuery.textScalerOf(context).scale(10) / 10;
                return const SizedBox();
              },
            ),
          ),
        ),
      ),
    );
    return got;
  }

  testWidgets('系统字体 2 倍时只放大到 1.3 倍；0.9 倍照常', (tester) async {
    expect(await scaleUnder(tester, 2), closeTo(maxTextScale, 1e-9));
    expect(await scaleUnder(tester, 1.15), closeTo(1.15, 1e-9));
    expect(await scaleUnder(tester, 0.9), closeTo(0.9, 1e-9));
  });
}
