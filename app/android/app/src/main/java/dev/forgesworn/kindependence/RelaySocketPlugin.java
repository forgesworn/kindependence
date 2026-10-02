// kindependence — native socket bridge (plan
// internal design record: 2026-09-28-native-socket-bridge.md): the
// Capacitor-facing half of the bridge. All the actual state — sockets,
// logs, orphan handling — lives in SocketHub, the process singleton;
// this class only translates PluginCall <-> SocketHub's plain Java types,
// and owns the two things that are inherently Android/Capacitor: the
// POST_NOTIFICATIONS permission flow and starting/stopping
// RelaySocketService.
//
// Pushes: SocketHub.Sink is set to this instance in load() and cleared in
// handleOnDestroy(), so the hub never pushes into a dead/detached plugin
// bridge — with no sink, entries just stay in the log until the next
// receive()/resync (relay-watch's safety net, or a fresh WebView's resync
// on `install`). Every push and every hub state change happens under the
// hub's own lock (SocketHub is `synchronized` throughout); pushEntry() is
// called from there, i.e. potentially from an OkHttp thread — notifyListeners
// is safe to call from any thread.
//
// Registered by hand in MainActivity, same "app-local plugin" discipline as
// WidgetBridgePlugin/Nip55Plugin/SecureKeyPlugin.
package dev.forgesworn.kindependence;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.List;

@CapacitorPlugin(
  name = "RelaySocket",
  permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class RelaySocketPlugin extends Plugin implements SocketHub.Sink {

  @Override
  public void load() {
    SocketHub.getInstance().setSink(this);
  }

  @Override
  protected void handleOnDestroy() {
    // Only clear the hub's push target if it's still this instance: on
    // activity recreation a newer plugin's load() may already have taken
    // over before this (older) instance's handleOnDestroy() runs, and this
    // must not blank out that newer sink.
    SocketHub.getInstance().clearSinkIfCurrent(this);
  }

  // ---- SocketHub.Sink: native push -> notifyListeners("entry", ...) -------

  @Override
  public void push(String socketId, EventLog.Entry entry) {
    JSObject data = new JSObject();
    data.put("id", socketId);
    entryInto(data, entry);
    notifyListeners("entry", data);
  }

  // ---- JS methods -----------------------------------------------------

  @PluginMethod
  public void attach(PluginCall call) {
    String session = call.getString("session");
    if (session == null || session.isEmpty()) {
      call.reject("session is required");
      return;
    }
    try {
      List<SocketHub.SocketSnapshot> snaps = SocketHub.getInstance().attach(session);
      JSArray sockets = new JSArray();
      for (SocketHub.SocketSnapshot s : snaps) sockets.put(snapshotWithUrl(s));
      JSObject ret = new JSObject();
      ret.put("sockets", sockets);
      call.resolve(ret);
    } catch (SocketHub.HubException e) {
      call.reject(e.getMessage(), e.code);
    }
  }

  @PluginMethod
  public void open(PluginCall call) {
    String url = call.getString("url");
    if (url == null || url.isEmpty()) {
      call.reject("url is required");
      return;
    }
    try {
      SocketHub.SocketSnapshot s = SocketHub.getInstance().open(url);
      JSObject ret = new JSObject();
      ret.put("id", s.id);
      ret.put("state", s.state);
      ret.put("seq", s.seq);
      call.resolve(ret);
    } catch (SocketHub.HubException e) {
      call.reject(e.getMessage(), e.code);
    }
  }

  @PluginMethod
  public void send(PluginCall call) {
    String id = call.getString("id");
    String data = call.getString("data");
    if (id == null || data == null) {
      call.reject("id and data are required");
      return;
    }
    try {
      SocketHub.getInstance().send(id, data);
      call.resolve();
    } catch (SocketHub.HubException e) {
      call.reject(e.getMessage(), e.code);
    }
  }

  @PluginMethod
  public void close(PluginCall call) {
    String id = call.getString("id");
    if (id == null) {
      call.reject("id is required");
      return;
    }
    Integer code = call.getInt("code");
    String reason = call.getString("reason");
    try {
      SocketHub.getInstance().close(id, code, reason);
      call.resolve();
    } catch (SocketHub.HubException e) {
      call.reject(e.getMessage(), e.code);
    }
  }

  @PluginMethod
  public void receive(PluginCall call) {
    String id = call.getString("id");
    Integer afterSeq = call.getInt("afterSeq");
    if (id == null || afterSeq == null) {
      call.reject("id and afterSeq are required");
      return;
    }
    try {
      SocketHub.ReceiveResult r = SocketHub.getInstance().receive(id, afterSeq);
      JSArray entries = new JSArray();
      for (EventLog.Entry e : r.entries) {
        JSObject entry = new JSObject();
        entryInto(entry, e);
        entries.put(entry);
      }
      JSObject ret = new JSObject();
      ret.put("entries", entries);
      ret.put("state", r.state);
      ret.put("dropped", r.dropped);
      ret.put("gap", r.gap);
      call.resolve(ret);
    } catch (SocketHub.HubException e) {
      call.reject(e.getMessage(), e.code);
    }
  }

  @PluginMethod
  public void ack(PluginCall call) {
    String id = call.getString("id");
    Integer upToSeq = call.getInt("upToSeq");
    if (id == null || upToSeq == null) {
      call.reject("id and upToSeq are required");
      return;
    }
    try {
      SocketHub.getInstance().ack(id, upToSeq);
      call.resolve();
    } catch (SocketHub.HubException e) {
      call.reject(e.getMessage(), e.code);
    }
  }

  /** Set once this process has asked for POST_NOTIFICATIONS, whatever the
   *  answer. JS calls setActive(true) again on every resume (native-socket
   *  reasserts on resume/visibilitychange), so without this a person who
   *  denied the prompt once would be re-prompted every time they came back
   *  to the app. */
  private static volatile boolean notificationsPermissionAsked;

  @PluginMethod
  public void setActive(PluginCall call) {
    Boolean active = call.getBoolean("active");
    if (active == null) {
      call.reject("active is required");
      return;
    }
    if (!active) {
      SocketHub.getInstance().deactivateAll();
      stopRelayService();
      call.resolve();
      return;
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
      && getPermissionState("notifications") != PermissionState.GRANTED
      && !notificationsPermissionAsked) {
      notificationsPermissionAsked = true;
      // Start regardless of the answer -- the plan is explicit that the
      // service starts either way; the permission only affects whether the
      // required notification is visible.
      requestPermissionForAlias("notifications", call, "onNotificationsPermission");
    } else {
      startRelayService();
      call.resolve();
    }
  }

  @PermissionCallback
  private void onNotificationsPermission(PluginCall call) {
    startRelayService();
    call.resolve();
  }

  // ---- helpers -----------------------------------------------------------

  private void startRelayService() {
    Context ctx = getContext();
    Intent intent = new Intent(ctx, RelaySocketService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      ctx.startForegroundService(intent);
    } else {
      ctx.startService(intent);
    }
  }

  private void stopRelayService() {
    Context ctx = getContext();
    ctx.stopService(new Intent(ctx, RelaySocketService.class));
  }

  private static JSObject snapshotWithUrl(SocketHub.SocketSnapshot s) {
    JSObject ret = new JSObject();
    ret.put("id", s.id);
    ret.put("url", s.url);
    ret.put("state", s.state);
    ret.put("seq", s.seq);
    return ret;
  }

  private static void entryInto(JSObject data, EventLog.Entry entry) {
    data.put("seq", entry.seq);
    data.put("type", entry.type);
    if (entry.data != null) data.put("data", entry.data);
    if (entry.code != null) data.put("code", entry.code);
    if (entry.reason != null) data.put("reason", entry.reason);
    if (entry.message != null) data.put("message", entry.message);
  }
}
