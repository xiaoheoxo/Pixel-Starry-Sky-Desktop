import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// 正式签名（docs/mobile-app.md §8.6）：密钥和密码在仓库外，默认 ~/.pixelsky/app-release.properties，
// 工作流用环境变量 PIXELSKY_KEY_PROPERTIES 指过去。storeFile 相对这个文件所在的文件夹。
// 没有这个文件时 release 退回 debug 签名（别人拉代码也能打包，但装不到正式版上面覆盖）。
val releaseKeyFile = file(
    System.getenv("PIXELSKY_KEY_PROPERTIES")
        ?: "${System.getProperty("user.home")}/.pixelsky/app-release.properties",
)
val releaseKey = Properties().apply {
    if (releaseKeyFile.isFile) FileInputStream(releaseKeyFile).use { load(it) }
}
val hasReleaseKey = releaseKey.getProperty("storeFile") != null

android {
    namespace = "xyz.pixelstarrysky.pixelsky_app"
    // flutter_local_notifications、androidx.core 1.19 要求用 37 编译（targetSdk 不变）
    compileSdk = 37
    ndkVersion = flutter.ndkVersion

    compileOptions {
        // flutter_local_notifications 要求打开 desugaring
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "xyz.pixelstarrysky.mobile"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // 版本号取 pubspec.yaml 的 version（0.1.0+1 → versionName 0.1.0、versionCode 1）
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = releaseKeyFile.parentFile.resolve(releaseKey.getProperty("storeFile"))
                storePassword = releaseKey.getProperty("storePassword")
                keyAlias = releaseKey.getProperty("keyAlias")
                keyPassword = releaseKey.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseKey) {
                signingConfigs.getByName("release")
            } else {
                logger.warn("没有找到正式签名（$releaseKeyFile），release 用 debug 签名")
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
