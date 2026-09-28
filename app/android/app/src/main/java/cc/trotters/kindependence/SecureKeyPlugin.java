// kindependence — secure key storage (Signet identity plan, Task 3): backs
// secure-key.ts's native `SecretStore` with the Android Keystore. A single
// AES-256-GCM key (alias `kindependence-secure-key`) is generated inside the
// Keystore itself — `setKeySize(256)` on an `AndroidKeyStore`-provider
// `KeyGenerator` produces a non-exportable key: the Keystore never lets raw
// key material leave it, only lets this app ask it to encrypt/decrypt with
// that key. Values are stored as `base64(iv || ciphertext)` in their own
// SharedPreferences file — the ciphertext at rest, never the plaintext.
//
// No third-party dependency: everything here is javax.crypto / java.security
// (JDK) plus android.security.keystore (platform SDK).
//
// Registered by hand in MainActivity (registerPlugin, before super.onCreate)
// — same "app-local plugin, not an npm package" discipline as
// WidgetBridgePlugin.
package cc.trotters.kindependence;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureKey")
public class SecureKeyPlugin extends Plugin {

  static final String PREFS_NAME = "kindependence-secure";
  static final String KEYSTORE_ALIAS = "kindependence-secure-key";
  static final String ANDROID_KEYSTORE = "AndroidKeyStore";
  static final String TRANSFORMATION = "AES/GCM/NoPadding";
  static final int GCM_IV_LENGTH_BYTES = 12;
  static final int GCM_TAG_LENGTH_BITS = 128;

  @PluginMethod
  public void get(PluginCall call) {
    String name = call.getString("name");
    if (name == null) {
      call.reject("name is required");
      return;
    }
    String stored = prefs().getString(name, null);
    JSObject ret = new JSObject();
    if (stored == null) {
      // Review fix round 1: org.json's JSONObject.put(String, Object)
      // REMOVES the key when given a Java `null` (that's `put`'s own
      // documented null-handling), so `{ "value": null }` never actually
      // reached the JS side — the bridge resolved `{}`, and destructuring
      // `{ value }` off that gave `undefined`, not `null`. JSONObject.NULL
      // is org.json's own null-in-JSON sentinel and survives `put` intact.
      ret.put("value", JSONObject.NULL);
      call.resolve(ret);
      return;
    }
    try {
      byte[] combined = Base64.decode(stored, Base64.NO_WRAP);
      byte[] iv = new byte[GCM_IV_LENGTH_BYTES];
      byte[] ciphertext = new byte[combined.length - GCM_IV_LENGTH_BYTES];
      System.arraycopy(combined, 0, iv, 0, GCM_IV_LENGTH_BYTES);
      System.arraycopy(combined, GCM_IV_LENGTH_BYTES, ciphertext, 0, ciphertext.length);

      Cipher cipher = Cipher.getInstance(TRANSFORMATION);
      cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv));
      byte[] plain = cipher.doFinal(ciphertext);

      ret.put("value", new String(plain, StandardCharsets.UTF_8));
      call.resolve(ret);
    } catch (Exception e) {
      call.reject("SecureKey.get failed: " + e.getMessage(), e);
    }
  }

  @PluginMethod
  public void set(PluginCall call) {
    String name = call.getString("name");
    String value = call.getString("value");
    if (name == null || value == null) {
      call.reject("name and value are required");
      return;
    }
    try {
      Cipher cipher = Cipher.getInstance(TRANSFORMATION);
      cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
      byte[] iv = cipher.getIV();
      byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));

      byte[] combined = new byte[iv.length + ciphertext.length];
      System.arraycopy(iv, 0, combined, 0, iv.length);
      System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);

      String encoded = Base64.encodeToString(combined, Base64.NO_WRAP);
      prefs().edit().putString(name, encoded).apply();
      call.resolve();
    } catch (Exception e) {
      call.reject("SecureKey.set failed: " + e.getMessage(), e);
    }
  }

  @PluginMethod
  public void remove(PluginCall call) {
    String name = call.getString("name");
    if (name == null) {
      call.reject("name is required");
      return;
    }
    prefs().edit().remove(name).apply();
    call.resolve();
  }

  private SharedPreferences prefs() {
    return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
  }

  /** Returns the app's AES-256-GCM Keystore key, generating it (inside the
   *  Keystore, non-exportable) the first time it's needed. */
  private SecretKey getOrCreateKey() throws Exception {
    KeyStore keyStore = KeyStore.getInstance(ANDROID_KEYSTORE);
    keyStore.load(null);

    if (keyStore.containsAlias(KEYSTORE_ALIAS)) {
      return (SecretKey) keyStore.getKey(KEYSTORE_ALIAS, null);
    }

    KeyGenerator keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
    KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
        KEYSTORE_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build();
    keyGenerator.init(spec);
    return keyGenerator.generateKey();
  }
}
