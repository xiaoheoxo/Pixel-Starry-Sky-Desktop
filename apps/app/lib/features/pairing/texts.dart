// 配对和连接状态的中英文说明（文字照网页版 connection/offer.ts、index.ts、界面上的状态文字）
import '../../connection/desktop_link.dart';
import '../../connection/offer.dart';
import '../../connection/pair.dart';
import '../../i18n/i18n.dart';

String offerErrorText(OfferError e) => switch (e) {
  OfferError.notFound => L(
    '没有找到配对链接。请在电脑的 设置 › 手机 › 添加手机 里点「复制配对链接」，再粘贴到这里。',
    'No pairing link found. On your computer, go to Settings › Phone › Add a phone, click “Copy pairing link”, then paste it here.',
  ),
  OfferError.incomplete => L(
    '这个链接不完整或被改动过，请回到电脑上重新复制配对链接。',
    'This link is incomplete or was modified. Copy the pairing link again on your computer.',
  ),
  OfferError.invalid => L(
    '这个配对链接不对（可能复制得不完整），请在电脑上重新复制。',
    'This pairing link is invalid (it may be incomplete). Copy it again on your computer.',
  ),
  OfferError.expired => L(
    '这个配对链接已经过期（5 分钟有效），请在电脑上重新生成。',
    'This pairing link has expired (valid for 5 minutes). Generate a new one on your computer.',
  ),
};

String pairErrorText(PairError e) => switch (e) {
  PairError.notCloud => L(
    '这个二维码不是经云端配对的，手机连不上。',
    'This QR code isn’t for cloud pairing, so the phone can’t connect.',
  ),
  PairError.network => L(
    '连不上云端，检查一下网络。',
    'Can’t reach the cloud. Check your network.',
  ),
  PairError.invalidCode => L(
    '二维码已过期或已经用过，请在电脑上重新生成。',
    'The QR code has expired or was already used. Generate a new one on your computer.',
  ),
  PairError.tooManyDevices => L(
    '每台电脑最多配对 5 部手机，这台已经满了，先在电脑上移除一部。',
    'Each computer can pair with up to 5 phones and this one is full. Remove one on your computer first.',
  ),
  PairError.failed => L(
    '配对失败，请在电脑上重新生成二维码。',
    'Pairing failed. Generate a new QR code on your computer.',
  ),
};

/// 连接状态的一句话；ready 时为 null
String? linkStateText(LinkState? s) => switch (s) {
  null || LinkState.connecting => L('正在连接…', 'Connecting…'),
  LinkState.desktopOffline => L(
    '电脑不在线：开机并打开像素星空的「手机远程」',
    'Computer is offline: turn it on and enable Phone remote in PixelSky',
  ),
  LinkState.waitingConfirm => L('请在电脑上点「允许」', 'Tap “Allow” on your computer'),
  LinkState.handshaking => L('正在建立加密连接…', 'Setting up encryption…'),
  LinkState.ready => null,
  LinkState.removed => L(
    '这部手机已被电脑移除，请重新配对',
    'This phone was removed by the computer. Pair again.',
  ),
  LinkState.unrecognized => L(
    '电脑上找不到这部手机的配对，稍后自动重试',
    'The computer doesn’t recognize this phone. Retrying shortly.',
  ),
  LinkState.incompatible => L(
    '电脑版和 App 的版本不兼容，请更新',
    'Computer and app versions are incompatible. Please update.',
  ),
  LinkState.offline => L('网络断了，正在重连…', 'Offline. Reconnecting…'),
  LinkState.replaced => L(
    '远程席位已满，被另一台设备顶掉了',
    'All remote seats are in use; another device took over.',
  ),
};
