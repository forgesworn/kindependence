// kindependence — NIP-55 signer apps (Signet identity plan, Task 4): lets
// nip55.ts sign and do NIP-44 with a key held in a signer app on this phone
// (My Signet, Amber and the others that answer `nostrsigner:` intents).
// Ported from kithmoot-android's Nip55.kt / Nip55Signer.kt.
//
// Signing and NIP-44 try the signer's content provider first — Amber's
// contract, which the others follow: query `content://<package>.<TYPE>` with
// (payload, peer, our pubkey) as the projection; it answers without a screen
// once the app has been approved there, and a null/empty cursor means "ask by
// intent". The fallback is the intent, which brings the signer up to ask —
// except for a call made with `interactive: false` (background work, such as
// unwrapping what a relay delivered), which rejects instead: the signer app
// must never be brought to the front for something no one tapped.
// `get_public_key` always goes by intent: it is the moment the person
// chooses the account, and it should be seen.
//
// Intent results come back through Capacitor's own activity-result plumbing
// (`startActivityForResult(call, intent, "callback")` + `@ActivityCallback`),
// which keeps the PluginCall alive across the round trip so the callback can
// read the call's own options (packageName, eventJson, ...). Capacitor
// tracks only ONE outstanding activity-result call per plugin
// (`lastPluginCallId`), so two overlapping intents would hand the second
// answer to the wrong PluginCall. Only one intent may be open at a time:
// a launch while one is pending is rejected (`intentPending`), every
// callback path clears that flag and releases the saved call, and
// nip55.ts/remote-signer.ts serialise requests on the JS side as well.
//
// The answer is handed back raw (`result`, `event`, `package`); parsing — an
// npub or hex key, a whole event or a bare signature — happens in nip55.ts.
// Refusals reject with words ("declined", "cancelled") that
// remote-signer.ts's mapSignerError classes as SignerRejected.
//
// Registered by hand in MainActivity, like SecureKeyPlugin.
package dev.forgesworn.kindependence;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.net.Uri;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "Nip55")
public class Nip55Plugin extends Plugin {

  static final String SCHEME = "nostrsigner";
  static final String TYPE_GET_PUBLIC_KEY = "get_public_key";
  static final String TYPE_SIGN_EVENT = "sign_event";
  static final String TYPE_NIP44_ENCRYPT = "nip44_encrypt";
  static final String TYPE_NIP44_DECRYPT = "nip44_decrypt";

  /** Kinds asked for up front at sign-in: 30078 (device statements and
   *  app state). Anything else is asked at the moment of use. */
  static final int[] PERMISSION_KINDS = {30078};

  /** True from an intent launch until its @ActivityCallback runs. */
  private final AtomicBoolean intentPending = new AtomicBoolean(false);

  // ---- JS methods ----------------------------------------------------------

  /** Device check 2026-09-26, fix 6: a plain `ACTION_VIEW` on a URI the app
   *  itself already knows the target for (the `signet-grant:` pairing URI —
   *  contacts-view.ts's own `window.open(uri, '_blank')`), targeted at the
   *  session's own signer package when one is known. Unlike `askIntent`
   *  below, this fires and forgets — no answer is expected back, so no
   *  `startActivityForResult`/`intentPending` bookkeeping. With no
   *  `packageName`, Android resolves the scheme itself (a chooser if more
   *  than one app answers it) — the same as the `window.open` fallback
   *  nip55.ts keeps for when this plugin isn't available (web/dev) or no
   *  package is known. */
  @PluginMethod
  public void openUri(PluginCall call) {
    String uriStr = call.getString("uri");
    if (uriStr == null || uriStr.isEmpty()) {
      call.reject("uri is required");
      return;
    }
    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(uriStr));
    String pkg = call.getString("packageName");
    if (pkg != null && !pkg.isEmpty()) intent.setPackage(pkg);
    try {
      getActivity().startActivity(intent);
      call.resolve();
    } catch (ActivityNotFoundException e) {
      call.reject("No app can open that link.");
    }
  }

  /** Every app that takes a `nostrsigner:` intent, so the person can pick one by name. */
  @PluginMethod
  public void installedSigners(PluginCall call) {
    PackageManager pm = getContext().getPackageManager();
    Intent probe = new Intent(Intent.ACTION_VIEW, Uri.parse(SCHEME + ":"));
    List<ResolveInfo> found = pm.queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY);
    Map<String, String> byPackage = new LinkedHashMap<>();
    for (ResolveInfo info : found) {
      String pkg = info.activityInfo.packageName;
      if (byPackage.containsKey(pkg)) continue;
      CharSequence label = info.loadLabel(pm);
      String text = label == null ? "" : label.toString().trim();
      byPackage.put(pkg, text.isEmpty() ? pkg : text);
    }
    List<Map.Entry<String, String>> sorted = new ArrayList<>(byPackage.entrySet());
    Collections.sort(sorted, (a, b) -> a.getValue().toLowerCase(Locale.ROOT).compareTo(b.getValue().toLowerCase(Locale.ROOT)));
    JSArray signers = new JSArray();
    for (Map.Entry<String, String> e : sorted) {
      JSObject s = new JSObject();
      s.put("packageName", e.getKey());
      s.put("label", e.getValue());
      signers.put(s);
    }
    JSObject ret = new JSObject();
    ret.put("signers", signers);
    call.resolve(ret);
  }

  /** Asks the signer app which key it holds; always by intent. */
  @PluginMethod
  public void getPublicKey(PluginCall call) {
    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(SCHEME + ":"));
    String pkg = call.getString("packageName");
    if (pkg != null && !pkg.isEmpty()) intent.setPackage(pkg);
    intent.putExtra("type", TYPE_GET_PUBLIC_KEY);
    intent.putExtra("permissions", permissions());
    launch(call, intent, "onPublicKey");
  }

  @PluginMethod
  public void signEvent(PluginCall call) {
    String pkg = call.getString("packageName");
    String pubkey = call.getString("pubkey");
    String eventJson = call.getString("eventJson");
    if (pkg == null || pubkey == null || eventJson == null) {
      call.reject("packageName, pubkey and eventJson are required");
      return;
    }
    ProviderReply reply = viaProvider(pkg, TYPE_SIGN_EVENT, eventJson, null, pubkey);
    if (reply == ProviderReply.REJECTED) {
      call.reject(appLabel(pkg) + " declined to sign.", CODE_REJECTED);
      return;
    }
    if (reply != null) {
      call.resolve(signAnswer(reply.result, reply.event));
      return;
    }
    if (!interactive(call)) {
      call.reject(NOT_SILENT);
      return;
    }
    launch(call, askIntent(pkg, TYPE_SIGN_EVENT, eventJson, null, pubkey), "onSignEvent");
  }

  @PluginMethod
  public void nip44Encrypt(PluginCall call) {
    crypt(call, TYPE_NIP44_ENCRYPT);
  }

  @PluginMethod
  public void nip44Decrypt(PluginCall call) {
    crypt(call, TYPE_NIP44_DECRYPT);
  }

  // ---- intent results --------------------------------------------------------

  @ActivityCallback
  private void onPublicKey(PluginCall call, ActivityResult result) {
    if (!finish(call)) return;
    String outcome = outcome(result);
    if (CODE_REJECTED.equals(outcome)) {
      call.reject("The signer app declined.", CODE_REJECTED);
      return;
    }
    if (CODE_ABORTED.equals(outcome)) {
      call.reject("The signer app closed before answering.", CODE_ABORTED);
      return;
    }
    Intent answer = result.getData();
    if (answer == null) {
      call.reject("The signer app did not return a public key.");
      return;
    }
    String key = firstNonNull(answer.getStringExtra("result"), answer.getStringExtra("signature"));
    if (key == null || key.trim().isEmpty()) {
      call.reject("The signer app did not return a public key.");
      return;
    }
    JSObject ret = new JSObject();
    ret.put("result", key.trim());
    String chosen = answer.getStringExtra("package");
    if (chosen == null || chosen.trim().isEmpty()) chosen = call.getString("packageName");
    if (chosen != null) ret.put("package", chosen);
    call.resolve(ret);
  }

  @ActivityCallback
  private void onSignEvent(PluginCall call, ActivityResult result) {
    if (!finish(call)) return;
    String pkg = call.getString("packageName", "");
    String outcome = outcome(result);
    if (CODE_REJECTED.equals(outcome)) {
      call.reject(appLabel(pkg) + " declined to sign.", CODE_REJECTED);
      return;
    }
    if (CODE_ABORTED.equals(outcome)) {
      call.reject(appLabel(pkg) + " closed before answering.", CODE_ABORTED);
      return;
    }
    Intent answer = result.getData();
    if (answer == null) {
      call.reject(appLabel(pkg) + " did not return a signed event.");
      return;
    }
    String event = answer.getStringExtra("event");
    String sig = firstNonNull(answer.getStringExtra("result"), answer.getStringExtra("signature"));
    if (event == null && sig == null) {
      call.reject(appLabel(pkg) + " did not return a signed event.");
      return;
    }
    call.resolve(signAnswer(sig, event));
  }

  @ActivityCallback
  private void onCrypt(PluginCall call, ActivityResult result) {
    if (!finish(call)) return;
    String pkg = call.getString("packageName", "");
    String outcome = outcome(result);
    if (CODE_REJECTED.equals(outcome)) {
      call.reject(appLabel(pkg) + " declined.", CODE_REJECTED);
      return;
    }
    if (CODE_ABORTED.equals(outcome)) {
      call.reject(appLabel(pkg) + " closed before answering.", CODE_ABORTED);
      return;
    }
    Intent answer = result.getData();
    if (answer == null) {
      call.reject(appLabel(pkg) + " returned nothing.");
      return;
    }
    String out = answer.getStringExtra("result");
    if (out == null || out.isEmpty()) {
      call.reject(appLabel(pkg) + " returned nothing.");
      return;
    }
    JSObject ret = new JSObject();
    ret.put("result", out);
    call.resolve(ret);
  }

  // ---- helpers -------------------------------------------------------------

  /** The rejection for a background call the provider could not answer.
   *  Deliberately free of the refusal words (reject/denied/declined/cancel)
   *  so remote-signer.ts classes it SignerUnavailable: retry later, when the
   *  signer is unlocked or approved — the request itself was not refused. */
  static final String NOT_SILENT = "The signer app could not answer in the background.";

  /** False when the caller asked for the silent path only
   *  (`interactive: false`: a background call no one tapped for, e.g. a
   *  relay-delivered wrap). Such a call never falls back to the intent, so
   *  it never brings the signer app to the front. Default true. */
  static boolean interactive(PluginCall call) {
    Boolean v = call.getBoolean("interactive", true);
    return v == null || v;
  }

  private void crypt(PluginCall call, String type) {
    String pkg = call.getString("packageName");
    String pubkey = call.getString("pubkey");
    String peer = call.getString("peer");
    String payload = call.getString("payload");
    if (pkg == null || pubkey == null || peer == null || payload == null) {
      call.reject("packageName, pubkey, peer and payload are required");
      return;
    }
    ProviderReply reply = viaProvider(pkg, type, payload, peer, pubkey);
    if (reply == ProviderReply.REJECTED) {
      call.reject(appLabel(pkg) + " declined.", CODE_REJECTED);
      return;
    }
    if (reply != null && reply.result != null) {
      JSObject ret = new JSObject();
      ret.put("result", reply.result);
      call.resolve(ret);
      return;
    }
    if (!interactive(call)) {
      call.reject(NOT_SILENT);
      return;
    }
    launch(call, askIntent(pkg, type, payload, peer, pubkey), "onCrypt");
  }

  private void launch(PluginCall call, Intent intent, String callback) {
    if (!intentPending.compareAndSet(false, true)) {
      call.reject("Another signer request is still open; try again shortly.");
      return;
    }
    try {
      startActivityForResult(call, intent, callback);
      // Capacitor rejects the call itself (and saves nothing) when the
      // callback name has no @ActivityCallback; don't stay pending then.
      if (bridge.getSavedCall(call.getCallbackId()) == null) intentPending.set(false);
    } catch (ActivityNotFoundException e) {
      intentPending.set(false);
      bridge.releaseCall(call);
      call.reject("No signer app answers nostrsigner: intents here.");
    } catch (RuntimeException e) {
      intentPending.set(false);
      bridge.releaseCall(call);
      call.reject("Could not open the signer app.");
    }
  }

  /** Every @ActivityCallback starts here: the intent is no longer pending
   *  and the saved call is released (its options stay readable on the
   *  object). False when there is no call to answer. */
  private boolean finish(PluginCall call) {
    intentPending.set(false);
    if (call == null) return false;
    bridge.releaseCall(call);
    return true;
  }

  /** Error codes on `call.reject`, read by remote-signer.ts's
   *  `mapSignerError` (NIP55_REJECTED / NIP55_ABORTED there). */
  static final String CODE_REJECTED = "SIGNER_REJECTED";
  static final String CODE_ABORTED = "SIGNER_ABORTED";

  /** How an intent came back: CODE_REJECTED when the signer said no — the
   *  NIP-55 `rejected` extra (My Signet's denial is RESULT_CANCELED with
   *  rejected=true); CODE_ABORTED when it came back without an answer and
   *  without that extra — the signer's activity was finished under it (step
   *  8: My Signet's singleTask MainActivity relaunched from the launcher
   *  while its PIN screen was up) or the person backed out; null for an
   *  answer (RESULT_OK). Nobody refused an aborted request, so the app
   *  keeps it waiting and retries rather than marking it rejected. */
  static String outcome(int resultCode, boolean rejectedExtra) {
    if (rejectedExtra) return CODE_REJECTED;
    if (resultCode != Activity.RESULT_OK) return CODE_ABORTED;
    return null;
  }

  private static String outcome(ActivityResult result) {
    if (result == null) return CODE_ABORTED;
    Intent data = result.getData();
    boolean rejected = data != null && data.getBooleanExtra("rejected", false);
    return outcome(result.getResultCode(), rejected);
  }

  private static JSObject signAnswer(String result, String event) {
    JSObject ret = new JSObject();
    if (result != null) ret.put("result", result);
    if (event != null) ret.put("event", event);
    return ret;
  }

  private static String firstNonNull(String a, String b) {
    return a != null ? a : b;
  }

  /** The data string for one request: `nostrsigner:` + the payload exactly
   *  as it is, per NIP-55 (`Uri.parse("nostrsigner:$content")`).
   *
   *  Device check 2026-09-27: this used to be built with
   *  `Uri.Builder().opaquePart(payload)`, which PERCENT-ENCODES the payload
   *  (`{"pubkey":...` became `%7B%22pubkey%22...`, and a NIP-44 ciphertext's
   *  `+`, `/`, `=` were escaped too). Signers read the scheme-specific part
   *  as sent (My Signet's Nip55Wire keeps `dataString` verbatim), so every
   *  request that fell back from the content provider to the intent failed
   *  to parse or decrypt and came back "declined". `Uri.parse` keeps the
   *  string as given, and `Intent.getDataString()` returns it unchanged,
   *  `#` and `?` included. */
  static String askData(String payload) {
    return SCHEME + ":" + payload;
  }

  /** The intent for one request. */
  private static Intent askIntent(String pkg, String type, String payload, String peer, String pubkey) {
    Uri uri = Uri.parse(askData(payload));
    Intent intent = new Intent(Intent.ACTION_VIEW, uri);
    intent.setPackage(pkg);
    intent.putExtra("type", type);
    intent.putExtra("id", UUID.randomUUID().toString());
    intent.putExtra("current_user", pubkey);
    if (peer != null) intent.putExtra("pubkey", peer);
    return intent;
  }

  /** The permissions asked for at sign-in, as a JSON array string. */
  static String permissions() {
    JSONArray out = new JSONArray();
    try {
      for (int kind : PERMISSION_KINDS) {
        out.put(new JSONObject().put("type", TYPE_SIGN_EVENT).put("kind", kind));
      }
      out.put(new JSONObject().put("type", TYPE_NIP44_ENCRYPT));
      out.put(new JSONObject().put("type", TYPE_NIP44_DECRYPT));
    } catch (JSONException e) {
      // Only string/int puts with non-null keys: cannot happen.
    }
    return out.toString();
  }

  /** The silent path. Null means "ask by intent" (no provider, no row, no
   *  answer, or the query threw); REJECTED means the signer said no. Plugin
   *  methods run on Capacitor's background thread, so the query is not on
   *  the UI thread. */
  private ProviderReply viaProvider(String pkg, String type, String payload, String peer, String pubkey) {
    Uri uri = Uri.parse("content://" + pkg + "." + type.toUpperCase(Locale.ROOT));
    String[] projection = {payload, peer == null ? "" : peer, pubkey};
    try (Cursor cursor = getContext().getContentResolver().query(uri, projection, null, null, null)) {
      if (cursor == null || !cursor.moveToFirst()) return null;
      String rejected = column(cursor, "rejected");
      if (rejected != null && rejected.equalsIgnoreCase("true")) return ProviderReply.REJECTED;
      String result = firstNonNull(column(cursor, "result"), column(cursor, "signature"));
      String event = column(cursor, "event");
      if (result == null && event == null) return null;
      return new ProviderReply(result, event);
    } catch (RuntimeException e) {
      return null;
    }
  }

  private static String column(Cursor cursor, String name) {
    int i = cursor.getColumnIndex(name);
    return i >= 0 ? cursor.getString(i) : null;
  }

  private String appLabel(String pkg) {
    try {
      PackageManager pm = getContext().getPackageManager();
      ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
      return pm.getApplicationLabel(info).toString();
    } catch (Exception e) {
      return pkg == null || pkg.isEmpty() ? "The signer app" : pkg;
    }
  }

  private static final class ProviderReply {
    static final ProviderReply REJECTED = new ProviderReply(null, null);
    final String result;
    final String event;

    ProviderReply(String result, String event) {
      this.result = result;
      this.event = event;
    }
  }
}
