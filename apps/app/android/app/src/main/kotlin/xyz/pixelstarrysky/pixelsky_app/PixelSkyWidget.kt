package xyz.pixelstarrysky.pixelsky_app

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.widget.RemoteViews
import es.antonborri.home_widget.HomeWidgetLaunchIntent
import es.antonborri.home_widget.HomeWidgetProvider

// 桌面小部件（第三批 D3，docs/mobile-app.md §15.9）：「等你处理 N 件」+ 第一件的标题；没有时「都处理完了」和最后同步时间。
// 字由 App 算好写进 home_widget 的存储（lib/platform/home_widget.dart），这里只画；点一下打开 App 逐个处理。
class PixelSkyWidget : HomeWidgetProvider() {
  override fun onUpdate(
      context: Context,
      appWidgetManager: AppWidgetManager,
      appWidgetIds: IntArray,
      widgetData: SharedPreferences,
  ) {
    val title = widgetData.getString("title", null) ?: context.getString(R.string.widget_empty_title)
    val body = widgetData.getString("body", null) ?: context.getString(R.string.widget_empty_body)
    val waiting = widgetData.getBoolean("waiting", false)
    for (id in appWidgetIds) {
      val views = RemoteViews(context.packageName, R.layout.pixelsky_widget).apply {
        setTextViewText(R.id.widget_title, title)
        setTextViewText(R.id.widget_body, body)
        setInt(
            R.id.widget_dot,
            "setColorFilter",
            context.getColor(if (waiting) R.color.widget_waiting else R.color.widget_idle),
        )
        setOnClickPendingIntent(
            R.id.widget_root,
            HomeWidgetLaunchIntent.getActivity(
                context,
                MainActivity::class.java,
                Uri.parse("pixelsky://widget/triage"),
            ),
        )
      }
      appWidgetManager.updateAppWidget(id, views)
    }
  }
}
