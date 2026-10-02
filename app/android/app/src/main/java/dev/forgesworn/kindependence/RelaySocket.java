// kindependence — native socket bridge: the per-socket state SocketHub
// keeps in its `Map<id, RelaySocket>`. Pure Java (no Android/OkHttp
// imports) so SocketHub and this class are testable under plain JUnit with
// a fake SocketHub.Transport.
package dev.forgesworn.kindependence;

import java.util.LinkedHashSet;
import java.util.Set;

final class RelaySocket {

  // WebSocket state numbering (plan: "States use the WebSocket numbering").
  static final int CONNECTING = 0;
  static final int OPEN = 1;
  static final int CLOSING = 2;
  static final int CLOSED = 3;

  final String id;
  final String url;
  final EventLog log = new EventLog();

  /** Recorded REQ subscription ids currently open on this socket (CLOSE
   *  removes). Only the id string is kept — enough to send `["CLOSE", id]`
   *  for each when this socket is orphaned. */
  final Set<String> subIds = new LinkedHashSet<>();

  /** Sub ids CLOSEd-out by orphaning: incoming EVENT/EOSE/CLOSED frames
   *  naming one of these are stale relay traffic for a subscription
   *  nobody here claims anymore, and are dropped rather than logged.
   *  Cleared only by the quarantine sentinel's own EOSE or the quarantine
   *  timeout — NOT by the new owner re-REQing the same id (nostr-tools
   *  reuses ids like "sub:1" immediately, which is exactly the traffic
   *  this must hold back). */
  final Set<String> stale = new LinkedHashSet<>();

  /** The zero-limit REQ id sent when this socket was last orphaned, or
   *  null when no quarantine is pending. Its own EOSE (or, failing that,
   *  quarantineDeadlineMs) lifts quarantine (clears `stale`). */
  String quarantineSentinel;
  long quarantineDeadlineMs;

  SocketHub.Transport transport;
  volatile int state = CONNECTING;
  String ownerSession;
  boolean orphan;
  long orphanedAtMs;

  /** True once JS has explicitly called `close` on this socket — one of
   *  the conditions (alongside an acked close entry, or being an orphan)
   *  under which a CLOSED socket is reaped from the hub's map. */
  boolean explicitCloseRequested;

  /** The seq of this socket's `close` log entry, once it has one. */
  Long closeSeq;

  RelaySocket(String id, String url) {
    this.id = id;
    this.url = url;
  }
}
