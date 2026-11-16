// A4b：抽屉底部账号行、外观和语言、每台电脑记住的项目。
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart' show Locale, ThemeMode;
import 'package:pixelsky_app/app/settings.dart';
import 'package:pixelsky_app/data/tools.dart';
import 'package:pixelsky_app/i18n/i18n.dart';

void main() {
  test('有余额显示余额；没有余额有套餐显示套餐名；头像取第一个字', () {
    expect(
      accountLine(
        Account({
          'name': '小黑',
          'balance': 96.25,
          'currency': 'USD',
          'plan': 'Pro',
        }),
      ),
      '余额 \$96.25',
    );
    expect(
      accountLine(Account({'name': 'a', 'balance': null, 'plan': 'Max'})),
      'Max',
    );
    expect(accountLine(Account({'name': 'a', 'balance': null})), '余额 —');
    expect(accountInitial('小黑'), '小');
    expect(accountInitial('bob'), 'B');
    expect(accountInitial('😀x'), '😀');
    expect(accountInitial(''), '?');
  });

  test('语言：选了就用选的，跟随系统时中文系统用中文、其余英文', () {
    const zh = Locale('zh', 'CN');
    const fr = Locale('fr');
    expect(resolveLanguage(LanguageChoice.system, zh), AppLanguage.zh);
    expect(resolveLanguage(LanguageChoice.system, fr), AppLanguage.en);
    expect(resolveLanguage(LanguageChoice.zh, fr), AppLanguage.zh);
    expect(resolveLanguage(LanguageChoice.en, zh), AppLanguage.en);
    expect(themeModeFor(Appearance.dark), ThemeMode.dark);
    expect(themeModeFor(Appearance.system), ThemeMode.system);
  });

  test('外观、语言、每台电脑的项目；删电脑时一起删', () async {
    final s = AppSettings(persist: false);
    await s.setAppearance(Appearance.dark);
    await s.setLanguage(LanguageChoice.en);
    await s.setProjectFor('d1', 'p1');
    expect(s.appearance, Appearance.dark);
    expect(s.language, LanguageChoice.en);
    expect(s.projectFor('d1'), 'p1');
    await s.forgetDevice('d1');
    expect(s.projectFor('d1'), isNull);
  });
}
