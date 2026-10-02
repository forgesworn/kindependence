// kindependence — native socket bridge: the foreground service that keeps
// the process (and so SocketHub's sockets) alive while the app has an
// active session and at least one circle. It owns nothing of the sockets
// themselves — SocketHub is the process-wide singleton that outlives this
// service being started/stopped/timed out; this class only keeps the
// process foreground and shows the required notification.
//
// Android 15+ (target/compile 36) caps a `dataSync` foreground service at
// ~6h/day and calls onTimeout when the cap is hit for this instance; per
// the plan we just stop being foreground (STOP_FOREGROUND_REMOVE) without
// touching the hub — the sockets and their logs are untouched, and
// RelaySocketPlugin.setActive(true) (e.g. on the next resume) restarts the
// service. See the plan's Leftovers for the longer-term follow-up.
package dev.forgesworn.kindependence;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

public class RelaySocketService extends Service {

  private static final String TAG = "RelaySocketService";
  static final String CHANNEL_ID = "relay_socket_channel";
  static final int NOTIFICATION_ID = 4201;

  @Override
  public void onCreate() {
    super.onCreate();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager manager = getSystemService(NotificationManager.class);
      NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        getString(R.string.relay_service_channel),
        NotificationManager.IMPORTANCE_LOW
      );
      manager.createNotificationChannel(channel);
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    Notification notification = buildNotification();
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
      } else {
        startForeground(NOTIFICATION_ID, notification);
      }
    } catch (RuntimeException e) {
      // ForegroundServiceStartNotAllowedException (31+) or the 15+
      // dataSync time-quota case: the hub and its sockets are untouched
      // either way — just give up being foreground this time.
      Log.w(TAG, "native-socket: startForeground failed", e);
      stopSelf();
      return START_NOT_STICKY;
    }
    // Not sticky: if the process dies, SocketHub dies with it (it's a
    // process singleton, not persisted). A sticky restart would show the
    // notification with nothing actually connected; JS re-asserts via
    // setActive on its next launch/resume instead.
    return START_NOT_STICKY;
  }

  private Notification buildNotification() {
    Notification.Builder builder;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      builder = new Notification.Builder(this, CHANNEL_ID);
    } else {
      builder = new Notification.Builder(this);
    }
    builder
      .setContentTitle(getString(R.string.relay_service_channel))
      .setContentText(getString(R.string.relay_service_text))
      .setSmallIcon(R.drawable.ic_stat_kindependence)
      .setOngoing(true);
    return builder.build();
  }

  /** API 35: called when this service instance hits its foreground-service
   *  time limit. Stop being foreground and stop the service itself —
   *  Android 15 throws ForegroundServiceDidNotStopInTimeException if a
   *  timed-out service doesn't actually stop. SocketHub and its sockets
   *  are left exactly as they are; setActive(true) starts the service
   *  again (e.g. on the next resume). */
  @Override
  public void onTimeout(int startId, int fgsType) {
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
