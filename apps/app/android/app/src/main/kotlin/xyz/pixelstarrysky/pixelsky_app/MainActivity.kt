package xyz.pixelstarrysky.pixelsky_app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

// local_auth（面容 / 指纹锁）要求 FragmentActivity
class MainActivity : FlutterFragmentActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // App 内更新（docs/mobile-app.md §16.1）：缓存目录、调起系统安装
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "pixelsky/update")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "cacheDir" -> result.success(cacheDir.absolutePath)
                    "install" -> result.success(install(call.argument<String>("path")))
                    else -> result.notImplemented()
                }
            }
    }

    /** 还没允许「安装未知应用」：跳到系统设置，返回 false；只装缓存目录 update/ 里的 */
    private fun install(path: String?): Boolean {
        val dir = File(cacheDir, "update").canonicalFile
        val file = path?.let { File(it).canonicalFile } ?: return false
        if (file.parentFile != dir || !file.isFile) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return false
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.update", file)
        startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return true
    }
}
