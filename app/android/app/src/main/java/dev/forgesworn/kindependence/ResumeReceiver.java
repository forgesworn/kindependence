package dev.forgesworn.kindependence;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/** A restart does not resume the renderer. Ask the user to reopen it. */
public class ResumeReceiver extends BroadcastReceiver {
  static final String PREFS = "kindependence-runtime";
  static final String RESUME = "resume-sharing";

  @Override public void onReceive(Context context, Intent intent) {
    if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
    if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(RESUME, false)) return;
    if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    String channel = "resume-sharing";
    Notification.Builder builder;
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(new NotificationChannel(channel, "Resume sharing", NotificationManager.IMPORTANCE_DEFAULT));
      builder = new Notification.Builder(context, channel);
    } else builder = new Notification.Builder(context);
    builder.setContentTitle("Open Kindependence to resume sharing")
      .setContentText("This phone restarted or the app updated. Updates resume when you open the app.")
      .setSmallIcon(R.drawable.ic_stat_kindependence)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setAutoCancel(true)
      .setContentIntent(PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    manager.notify(4202, builder.build());
  }
}
