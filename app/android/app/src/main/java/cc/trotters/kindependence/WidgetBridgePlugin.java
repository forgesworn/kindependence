// kindependence — bridge from widget.ts's debounced push to the home-screen
// widget. One method: take the JSON status payload the JS side already
// built (widget.ts's `buildWidgetStatus`), write it to SharedPreferences,
// then ask every placed instance of KindependenceWidgetProvider to redraw from
// what was just written. No parsing/formatting decisions happen here — that
// all already happened in JS; this plugin (and the provider) only move
// bytes and trigger a redraw.
//
// Registered by hand in MainActivity (registerPlugin, before super.onCreate)
// — same "app-local plugin, not an npm package, so it doesn't auto-register"
// discipline as flock's own MainActivity.java.
package cc.trotters.kindependence;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

  static final String PREFS_NAME = "kindependence.widget";
  static final String KEY_STATUS = "status";
  static final String KEY_PUSHED_AT = "pushedAt";

  @PluginMethod
  public void update(PluginCall call) {
    String json = call.getString("json");
    Context ctx = getContext();

    SharedPreferences.Editor editor = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit();
    editor.putString(KEY_STATUS, json);
    editor.putLong(KEY_PUSHED_AT, System.currentTimeMillis());
    editor.apply();

    AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
    int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, KindependenceWidgetProvider.class));
    for (int id : ids) {
      KindependenceWidgetProvider.render(ctx, mgr, id);
    }

    call.resolve();
  }
}
