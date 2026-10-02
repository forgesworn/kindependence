package dev.forgesworn.kindependence;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.app.Activity;

import android.net.Uri;

import org.junit.Assume;
import org.junit.Test;

/** Device check 2026-09-27: the `nostrsigner:` intent must carry the payload
 *  exactly as NIP-55 sends it — no percent-encoding — or the signer cannot
 *  parse an event template or decrypt a NIP-44 ciphertext. */
public class Nip55PluginTest {

  @Test
  public void eventTemplatePayloadIsNotPercentEncoded() {
    String json = "{\"pubkey\":\"282d\",\"kind\":30078,\"content\":\"a b#c?d\",\"tags\":[[\"d\",\"x/y\"]]}";
    assertEquals("nostrsigner:" + json, Nip55Plugin.askData(json));
  }

  @Test
  public void nip44CiphertextKeepsItsBase64Characters() {
    String ct = "Ai1oZ3QO+IriWs5/SEq6fl==";
    assertEquals("nostrsigner:" + ct, Nip55Plugin.askData(ct));
  }

  /** Payloads with every character a URI encoder would touch: fragment and
   *  query delimiters, a literal percent (and something that looks like an
   *  escape), spaces, newlines, a colon, and non-ASCII. */
  static final String[] AWKWARD = {
    "a#b",
    "100% sure %41 %zz",
    "what?x=1&y=2",
    "with spaces  and\ttabs",
    "line one\nline two\r\nthree",
    "caf\u00e9 \u2014 \ud83d\udc4b \u65e5\u672c",
    "{\"content\":\"a:b/c?d#e%f g\\nh\",\"tags\":[]}",
    "Ai1oZ3QO+IriWs5/SEq6fl==",
  };

  /** What plain JUnit can check: the data string is the scheme, one colon,
   *  and the payload byte for byte — no encoding, no trimming — and the
   *  first colon (where Android's Uri.parse splits the scheme) is the one
   *  we put there, whatever colons the payload holds. */
  @Test
  public void awkwardPayloadsAreCarriedVerbatim() {
    for (String payload : AWKWARD) {
      String data = Nip55Plugin.askData(payload);
      assertEquals(payload, "nostrsigner:" + payload, data);
      int colon = data.indexOf(':');
      assertEquals(payload, Nip55Plugin.SCHEME, data.substring(0, colon));
      assertEquals(payload, payload, data.substring(colon + 1));
    }
  }

  /** The full round trip — `Uri.parse(askData(p))` into the intent, read
   *  back by the signer as `getDataString()` (which is `Uri.toString()`) —
   *  needs the real android.net.Uri. Plain JUnit only has the android.jar
   *  stubs, which throw, so this is skipped here (it runs as-is under
   *  Robolectric or on a device). AOSP's `Uri.parse` returns a StringUri
   *  whose `toString()` is the input string unchanged. */
  @Test
  public void awkwardPayloadsRoundTripThroughUriParse() {
    for (String payload : AWKWARD) {
      String data = Nip55Plugin.askData(payload);
      String back;
      try {
        back = Uri.parse(data).toString();
      } catch (RuntimeException stub) {
        Assume.assumeNoException("android.net.Uri is a stub under plain JUnit", stub);
        return;
      }
      // Only the whole string is compared: the signer reads getDataString()
      // verbatim, whereas getSchemeSpecificPart() would decode `%41` and
      // stop at the `#` (that is the Uri's fragment, not a lost payload).
      assertEquals(payload, data, back);
    }
  }

  // Step 8: an intent that comes back RESULT_CANCELED with no `rejected`
  // extra is nobody refusing (My Signet's activity was finished under it) —
  // SIGNER_ABORTED, which the app retries. My Signet's real denial
  // (Nip55SignerActivity.finishRejected) is RESULT_CANCELED + rejected=true.

  @Test
  public void cancelledWithoutRejectedExtraIsAborted() {
    assertEquals(Nip55Plugin.CODE_ABORTED, Nip55Plugin.outcome(Activity.RESULT_CANCELED, false));
  }

  @Test
  public void cancelledWithRejectedExtraIsRejected() {
    assertEquals(Nip55Plugin.CODE_REJECTED, Nip55Plugin.outcome(Activity.RESULT_CANCELED, true));
  }

  @Test
  public void okWithRejectedExtraIsRejected() {
    assertEquals(Nip55Plugin.CODE_REJECTED, Nip55Plugin.outcome(Activity.RESULT_OK, true));
  }

  @Test
  public void okIsAnAnswer() {
    assertNull(Nip55Plugin.outcome(Activity.RESULT_OK, false));
  }

  @Test
  public void codesMatchTheApp() {
    // remote-signer.ts NIP55_REJECTED / NIP55_ABORTED
    assertEquals("SIGNER_REJECTED", Nip55Plugin.CODE_REJECTED);
    assertEquals("SIGNER_ABORTED", Nip55Plugin.CODE_ABORTED);
  }
}
