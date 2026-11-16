// 中英文：照网页版 apps/mobile/src/i18n 的 L(中文, 英文) 写法，文字就写在用到的地方，不另建词典文件。
// 语言跟随系统，设置里可以改（A4）；改了之后整个界面重建。
import 'package:flutter/widgets.dart';

enum AppLanguage { zh, en }

/// 当前语言；main.dart 按系统语言设好，切换时改它再重建界面
final language = ValueNotifier<AppLanguage>(AppLanguage.zh);

/// 按当前语言选文字（大写的 L 同网页版，读起来像一个标记）
// ignore: non_constant_identifier_names
String L(String zh, String en) => language.value == AppLanguage.en ? en : zh;

/// 系统语言是中文就用中文，其余都用英文
AppLanguage languageFor(Locale locale) =>
    locale.languageCode == 'zh' ? AppLanguage.zh : AppLanguage.en;
