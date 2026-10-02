// kindependence — home-screen widget provider. Purely a renderer: reads whatever
// widget.ts's debounced push last wrote to SharedPreferences (via
// WidgetBridgePlugin) and draws it into the row/footer TextViews of
// widget_kindependence.xml. No network, no JS, no decisions about WHAT to show —
// every decision (who's a row, what precision counts, which agreement is
// active, battery freshness) already happened on the TS side; this class
// only ever formats already-decided strings onto the layout, plus the two
// small presentation calls the JS payload can't make for itself: hiding
// unused row slots, and the "as of / open to refresh / open to set up"
// freshness footer (this class's own clock read — the payload only carries
// `pushedAt` via SharedPreferences, not a pre-formatted footer string).
package dev.forgesworn.kindependence;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.RemoteViews;
import java.util.Date;
import org.json.JSONArray;
import org.json.JSONObject;

public class KindependenceWidgetProvider extends AppWidgetProvider {

  private static final int[] NAME_IDS = { R.id.w_name1, R.id.w_name2, R.id.w_name3, R.id.w_name4 };
  private static final int[] LINE_IDS = { R.id.w_line1, R.id.w_line2, R.id.w_line3, R.id.w_line4 };

  // 25 minutes (task contract) — beyond this, "as of HH:MM" stops being a
  // useful claim and the footer instead asks the user to open the app.
  private static final long FRESH_MS = 25L * 60L * 1000L;

  @Override
  public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
    for (int id : appWidgetIds) {
      render(context, appWidgetManager, id);
    }
  }

  static void render(Context ctx, AppWidgetManager mgr, int id) {
    RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_kindependence);

    SharedPreferences prefs = ctx.getSharedPreferences(WidgetBridgePlugin.PREFS_NAME, Context.MODE_PRIVATE);
    String status = prefs.getString(WidgetBridgePlugin.KEY_STATUS, null);
    long pushedAt = prefs.getLong(WidgetBridgePlugin.KEY_PUSHED_AT, 0L);

    JSONArray rows = null;
    if (status != null) {
      try {
        rows = new JSONObject(status).getJSONArray("rows");
      } catch (Exception e) {
        rows = null; // malformed payload — falls through to the "set up" placeholder below
      }
    }

    if (rows == null) {
      views.setTextViewText(NAME_IDS[0], "Open kindependence to set up");
      views.setViewVisibility(NAME_IDS[0], View.VISIBLE);
      views.setViewVisibility(LINE_IDS[0], View.GONE);
      for (int i = 1; i < NAME_IDS.length; i++) {
        views.setViewVisibility(NAME_IDS[i], View.GONE);
        views.setViewVisibility(LINE_IDS[i], View.GONE);
      }
      views.setViewVisibility(R.id.w_footer, View.GONE);
    } else {
      int count = Math.min(rows.length(), NAME_IDS.length);
      for (int i = 0; i < NAME_IDS.length; i++) {
        if (i >= count) {
          views.setViewVisibility(NAME_IDS[i], View.GONE);
          views.setViewVisibility(LINE_IDS[i], View.GONE);
          continue;
        }
        JSONObject row = rows.optJSONObject(i);
        String name = row != null ? row.optString("name", "") : "";
        String line1 = row != null ? row.optString("line1", "") : "";
        String line2 = row != null ? row.optString("line2", null) : null;
        String line = (line2 != null && line2.length() > 0) ? line1 + "\n" + line2 : line1;
        views.setTextViewText(NAME_IDS[i], name);
        views.setTextViewText(LINE_IDS[i], line);
        views.setViewVisibility(NAME_IDS[i], View.VISIBLE);
        views.setViewVisibility(LINE_IDS[i], View.VISIBLE);
      }

      views.setViewVisibility(R.id.w_footer, View.VISIBLE);
      if (pushedAt > 0 && (System.currentTimeMillis() - pushedAt) < FRESH_MS) {
        // getTimeFormat (not a hard-coded "HH:mm" pattern) honours the
        // device's 12/24-hour system preference for this footer, same as
        // any other Android clock display.
        java.text.DateFormat timeFormat = DateFormat.getTimeFormat(ctx);
        views.setTextViewText(R.id.w_footer, "as of " + timeFormat.format(new Date(pushedAt)));
      } else {
        views.setTextViewText(R.id.w_footer, "Open kindependence to refresh");
      }
    }

    Intent launch = new Intent(ctx, MainActivity.class);
    PendingIntent pi = PendingIntent.getActivity(
      ctx, 0, launch,
      PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    views.setOnClickPendingIntent(R.id.w_root, pi);

    mgr.updateAppWidget(id, views);
  }
}
