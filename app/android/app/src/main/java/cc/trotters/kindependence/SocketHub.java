// kindependence — native socket bridge (plan
// internal design record: 2026-09-28-native-socket-bridge.md): the
// process-wide singleton that owns every relay WebSocket. Pure Java (no
// Capacitor, no OkHttp, no Android) so it's testable with a fake Transport
// and an injectable clock under plain JUnit; the real OkHttp wiring lives
// in RelaySocketOkHttpTransport.
//
// Every state change and every push to JS happens under this object's own
// lock (`synchronized` on `this`): Transport callbacks run on the
// transport's own threads (OkHttp's, for the real implementation), so the
// hub is the one place that serialises them against plugin-method calls
// coming from Capacitor's bridge thread. The hub never assumes a plugin
// bridge exists — `sink` is a volatile reference set by RelaySocketPlugin
// in load() and cleared (only if it's still the current one) in
// handleOnDestroy(); with no sink, entries simply stay in the log until
// someone (a re-attached plugin, or `receive`) asks for them.
package cc.trotters.kindependence;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

public final class SocketHub {

  public static final long ORPHAN_TTL_MS = 30000;
  public static final long ORPHAN_SWEEP_INTERVAL_MS = 10000;
  public static final long QUARANTINE_TIMEOUT_MS = 10000;

  // ---- collaborators --------------------------------------------------------

  /** One connection. `open` is called once per instance; `send`/`close`
   *  act on that same connection afterward. A `TransportFactory` mints a
   *  fresh instance per RelaySocket. */
  public interface Transport {
    void open(String url, Listener listener);
    void send(String data);
    void close(int code, String reason);

    interface Listener {
      void onOpen();
      void onMessage(String text);
      void onClosing(int code, String reason);
      void onClosed(int code, String reason);
      void onFailure(String message);
    }
  }

  public interface TransportFactory {
    Transport create();
  }

  /** The plugin's push side: notifyListeners("entry", ...), one call per
   *  log entry, called under the hub's lock. */
  public interface Sink {
    void push(String socketId, EventLog.Entry entry);
  }

  public static final class HubException extends RuntimeException {
    public final String code;

    public HubException(String message) {
      this(message, null);
    }

    public HubException(String message, String code) {
      super(message);
      this.code = code;
    }
  }

  public static final class SocketSnapshot {
    public final String id;
    public final String url;
    public final int state;
    public final long seq;

    SocketSnapshot(String id, String url, int state, long seq) {
      this.id = id;
      this.url = url;
      this.state = state;
      this.seq = seq;
    }
  }

  public static final class ReceiveResult {
    public final List<EventLog.Entry> entries;
    public final int state;
    public final long dropped;
    public final boolean gap;

    ReceiveResult(List<EventLog.Entry> entries, int state, long dropped, boolean gap) {
      this.entries = entries;
      this.state = state;
      this.dropped = dropped;
      this.gap = gap;
    }
  }

  // ---- process singleton -----------------------------------------------------

  private static volatile SocketHub instance;

  /** Real, OkHttp-backed hub used by production code. Tests build their
   *  own instance directly with a fake TransportFactory instead. */
  public static SocketHub getInstance() {
    SocketHub result = instance;
    if (result == null) {
      synchronized (SocketHub.class) {
        result = instance;
        if (result == null) {
          instance = result = new SocketHub(new RelaySocketOkHttpTransport.Factory());
        }
      }
    }
    return result;
  }

  // ---- instance ---------------------------------------------------------

  private final TransportFactory transportFactory;
  private final LongSupplier clock;
  private final Map<String, RelaySocket> sockets = new LinkedHashMap<>();
  private String currentSession;
  private volatile Sink sink;

  private ScheduledExecutorService orphanSweepExecutor;
  private ScheduledFuture<?> orphanSweepTask;

  public SocketHub(TransportFactory transportFactory) {
    this(transportFactory, System::currentTimeMillis);
  }

  SocketHub(TransportFactory transportFactory, LongSupplier clock) {
    this.transportFactory = transportFactory;
    this.clock = clock;
  }

  public synchronized void setSink(Sink sink) {
    this.sink = sink;
  }

  /** Clears the push target only if it is still the one given — a plugin
   *  instance being destroyed must never blank out a newer instance's sink
   *  (e.g. the activity was recreated and a new plugin already called
   *  load() before the old one's handleOnDestroy() runs). */
  public synchronized void clearSinkIfCurrent(Sink sink) {
    if (this.sink == sink) this.sink = null;
  }

  // ---- plugin-facing operations ------------------------------------------

  public synchronized List<SocketSnapshot> attach(String session) {
    if (session == null || session.isEmpty()) throw new HubException("session is required");
    expireOrphansLocked();
    if (!session.equals(currentSession)) {
      for (RelaySocket rs : sockets.values()) {
        if (!rs.orphan) orphanLocked(rs);
      }
      currentSession = session;
    }
    List<SocketSnapshot> out = new ArrayList<>();
    for (RelaySocket rs : sockets.values()) out.add(snapshot(rs));
    return out;
  }

  public synchronized SocketSnapshot open(String url) {
    if (url == null || url.isEmpty()) throw new HubException("url is required");
    expireOrphansLocked();
    for (RelaySocket rs : sockets.values()) {
      if (rs.orphan && rs.state == RelaySocket.OPEN && url.equals(rs.url)) {
        rs.orphan = false;
        rs.ownerSession = currentSession;
        rescheduleOrphanSweepLocked();
        return snapshot(rs);
      }
    }
    String id = UUID.randomUUID().toString();
    RelaySocket rs = new RelaySocket(id, url);
    rs.ownerSession = currentSession;
    Transport transport = transportFactory.create();
    rs.transport = transport;
    sockets.put(id, rs);
    transport.open(url, listenerFor(rs));
    return snapshot(rs);
  }

  public synchronized void send(String id, String data) {
    RelaySocket rs = sockets.get(id);
    if (rs == null || rs.state != RelaySocket.OPEN) {
      throw new HubException("socket is not open", "not-open");
    }
    rs.transport.send(data);
    recordSubId(rs, data);
  }

  /** Idempotent: an unknown or already-closed id is a no-op (beyond
   *  reaping an already-closed socket once JS has explicitly asked to
   *  close it). */
  public synchronized void close(String id, Integer code, String reason) {
    RelaySocket rs = sockets.get(id);
    if (rs == null) return;
    rs.explicitCloseRequested = true;
    if (rs.state == RelaySocket.CLOSED) {
      maybeReapLocked(rs, Long.MIN_VALUE);
      return;
    }
    safeClose(rs.transport, code == null ? 1000 : code, reason == null ? "" : reason);
  }

  public synchronized ReceiveResult receive(String id, long afterSeq) {
    RelaySocket rs = sockets.get(id);
    if (rs == null) throw new HubException("unknown socket");
    rs.log.ack(afterSeq);
    List<EventLog.Entry> entries = rs.log.since(afterSeq);
    boolean gap = rs.log.hasGapAfter(afterSeq);
    long dropped = rs.log.dropped();
    int state = rs.state;
    maybeReapLocked(rs, afterSeq);
    return new ReceiveResult(entries, state, dropped, gap);
  }

  public synchronized void ack(String id, long upToSeq) {
    RelaySocket rs = sockets.get(id);
    if (rs == null) throw new HubException("unknown socket");
    rs.log.ack(upToSeq);
    maybeReapLocked(rs, upToSeq);
  }

  /** setActive(false): closes every socket and clears the hub. Starting
   *  and stopping the foreground service, and the notification-permission
   *  flow, are Android-only and live in RelaySocketPlugin. */
  public synchronized void deactivateAll() {
    for (RelaySocket rs : sockets.values()) {
      safeClose(rs.transport, 1000, "");
    }
    sockets.clear();
    currentSession = null;
    rescheduleOrphanSweepLocked();
  }

  // ---- map hygiene: reap closed sockets nobody needs anymore ------------

  /** Removes `rs` from the map once it is CLOSED and any of: JS explicitly
   *  asked to close it, JS has acked past its close entry (receive/ack
   *  with upToSeq >= the close entry's seq — `ackedUpTo` here), or it's an
   *  orphan (nobody will ever adopt a CLOSED orphan; open() only adopts
   *  OPEN ones). */
  private void maybeReapLocked(RelaySocket rs, long ackedUpTo) {
    if (rs.state != RelaySocket.CLOSED) return;
    boolean ackedClose = rs.closeSeq != null && ackedUpTo >= rs.closeSeq;
    if (rs.explicitCloseRequested || ackedClose || rs.orphan) {
      sockets.remove(rs.id);
      rescheduleOrphanSweepLocked();
    }
  }

  // ---- orphan handling ----------------------------------------------------

  private void orphanLocked(RelaySocket rs) {
    for (String subId : new ArrayList<>(rs.subIds)) {
      rs.transport.send(closeFrame(subId));
    }
    // Kept as "stale": traffic for these subscriptions is still in flight
    // from the relay and must be dropped. Quarantine lifts either when the
    // sentinel REQ's own EOSE comes back (relays answer in order, so
    // everything stale for the old ids arrives before it) or after
    // QUARANTINE_TIMEOUT_MS, whichever is first — never on the new owner
    // re-REQing one of the old ids, since nostr-tools reuses sub ids
    // (e.g. "sub:1") immediately and that would lift quarantine on exactly
    // the traffic it exists to hold back.
    long now = clock.getAsLong();
    rs.stale.addAll(rs.subIds);
    rs.subIds.clear();
    rs.log.clear();
    rs.orphan = true;
    rs.orphanedAtMs = now;
    if (!rs.stale.isEmpty()) {
      String sentinel = randomSentinelId();
      rs.quarantineSentinel = sentinel;
      rs.quarantineDeadlineMs = now + QUARANTINE_TIMEOUT_MS;
      rs.transport.send(reqSentinelFrame(sentinel));
    } else {
      rs.quarantineSentinel = null;
      rs.quarantineDeadlineMs = 0;
    }
    rescheduleOrphanSweepLocked();
  }

  private void expireOrphansLocked() {
    long now = clock.getAsLong();
    if (!sockets.isEmpty()) {
      List<String> expired = new ArrayList<>();
      for (RelaySocket rs : sockets.values()) {
        if (rs.orphan && now - rs.orphanedAtMs >= ORPHAN_TTL_MS) {
          safeClose(rs.transport, 1000, "");
          expired.add(rs.id);
        }
      }
      for (String id : expired) sockets.remove(id);
    }
    expireQuarantinesLocked(now);
    rescheduleOrphanSweepLocked();
  }

  /** The 10 s quarantine fallback: independent of orphan status (adoption
   *  usually happens almost immediately after orphaning, well before the
   *  quarantine itself should lift). */
  private void expireQuarantinesLocked(long now) {
    for (RelaySocket rs : sockets.values()) {
      if (rs.quarantineSentinel != null && now >= rs.quarantineDeadlineMs) {
        liftQuarantineLocked(rs);
      }
    }
  }

  private void liftQuarantineLocked(RelaySocket rs) {
    rs.stale.clear();
    rs.quarantineSentinel = null;
    rs.quarantineDeadlineMs = 0;
  }

  /** Explicit hook for the periodic sweep, and for tests driving an
   *  injected clock without waiting on the real scheduler. */
  public void sweep() {
    synchronized (this) {
      expireOrphansLocked();
    }
  }

  /** Keeps a single background tick running every ORPHAN_SWEEP_INTERVAL_MS
   *  while any orphan or pending quarantine exists, and stops it (cancels,
   *  no thread left idling) once neither do. Must be called under the
   *  lock. The executor itself is plain java.util.concurrent — nothing
   *  Android-specific — and is only ever created lazily, so a test run
   *  that never orphans a socket never starts a thread. */
  private void rescheduleOrphanSweepLocked() {
    boolean anyPending = false;
    for (RelaySocket rs : sockets.values()) {
      if (rs.orphan || rs.quarantineSentinel != null) {
        anyPending = true;
        break;
      }
    }
    if (anyPending) {
      if (orphanSweepTask == null || orphanSweepTask.isCancelled()) {
        if (orphanSweepExecutor == null) orphanSweepExecutor = newDaemonScheduler();
        orphanSweepTask = orphanSweepExecutor.scheduleAtFixedRate(
          this::sweep,
          ORPHAN_SWEEP_INTERVAL_MS,
          ORPHAN_SWEEP_INTERVAL_MS,
          TimeUnit.MILLISECONDS
        );
      }
    } else if (orphanSweepTask != null) {
      orphanSweepTask.cancel(false);
      orphanSweepTask = null;
    }
  }

  private static ScheduledExecutorService newDaemonScheduler() {
    ThreadFactory factory = r -> {
      Thread t = new Thread(r, "kindependence-relay-orphan-sweep");
      t.setDaemon(true);
      return t;
    };
    return Executors.newSingleThreadScheduledExecutor(factory);
  }

  static String closeFrame(String subId) {
    StringBuilder sb = new StringBuilder();
    sb.append("[\"CLOSE\",\"");
    escapeInto(sb, subId);
    sb.append("\"]");
    return sb.toString();
  }

  /** The quarantine end-marker: a zero-limit REQ whose own EOSE (relays
   *  answer in order) tells the hub that every stale frame for the ids it
   *  just CLOSEd has now arrived and quarantine can lift. */
  static String reqSentinelFrame(String sentinelId) {
    StringBuilder sb = new StringBuilder();
    sb.append("[\"REQ\",\"");
    escapeInto(sb, sentinelId);
    sb.append("\",{\"limit\":0}]");
    return sb.toString();
  }

  private static String randomSentinelId() {
    return "q:" + UUID.randomUUID();
  }

  private static void escapeInto(StringBuilder sb, String s) {
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\') sb.append('\\');
      sb.append(c);
    }
  }

  /** A transport.close() must never throw out of hub code: OkHttp rejects
   *  reserved/invalid close codes (e.g. echoing a relay's 1005/1006 back to
   *  it throws IllegalArgumentException), and a bad code from JS shouldn't
   *  be able to wedge the hub either. Logged and swallowed. */
  private static void safeClose(Transport transport, int code, String reason) {
    try {
      transport.close(code, reason);
    } catch (RuntimeException e) {
      log("transport.close(" + code + ") failed: " + e);
    }
  }

  private static void log(String message) {
    System.out.println("SocketHub: " + message);
  }

  // ---- sub-id recording / stale-subscription quarantine -------------------

  private static void recordSubId(RelaySocket rs, String data) {
    String[] cmd = parseCommand(data);
    if (cmd == null) return;
    if ("REQ".equals(cmd[0])) {
      // Does NOT lift quarantine on cmd[1]: nostr-tools reuses sub ids
      // (e.g. "sub:1") immediately, so a fresh REQ for a just-orphaned id
      // is exactly the case quarantine has to survive. Only the sentinel's
      // own EOSE or the timeout (see orphanLocked/expireQuarantinesLocked)
      // lifts it.
      rs.subIds.add(cmd[1]);
    } else if ("CLOSE".equals(cmd[0])) {
      rs.subIds.remove(cmd[1]);
    }
  }

  /** Hand-rolled parser for just enough of `["REQ", "subId", ...]` /
   *  `["CLOSE", "subId"]` to pull the command and sub id out. org.json is a
   *  stub under plain JUnit (throws), so SocketHub — testable without
   *  Android — can't use it; a tiny parser sidesteps that and is all this
   *  needs (nostr-tools always sends REQ/CLOSE with the sub id as the
   *  second array element, a JSON string). Returns null for anything that
   *  doesn't parse as `[ "command" , "id" ...` or whose command isn't
   *  REQ/CLOSE. */
  static String[] parseCommand(String data) {
    String[] pair = parsePair(data);
    if (pair == null) return null;
    if (!"REQ".equals(pair[0]) && !"CLOSE".equals(pair[0])) return null;
    return pair;
  }

  /** Same parse, for incoming relay->client frames that carry a sub id as
   *  their second element: `["EVENT", "subId", event]`, `["EOSE",
   *  "subId"]`, `["CLOSED", "subId", message]`. (Client->relay `["EVENT",
   *  event]` — a publish — has no sub id and its second element isn't a
   *  quoted string, so it simply fails to parse here, which is correct: it
   *  was never subject to stale quarantine.) */
  static String[] parseIncomingSubFrame(String data) {
    String[] pair = parsePair(data);
    if (pair == null) return null;
    if (!"EVENT".equals(pair[0]) && !"EOSE".equals(pair[0]) && !"CLOSED".equals(pair[0])) return null;
    return pair;
  }

  private static String[] parsePair(String data) {
    if (data == null) return null;
    String s = data;
    int len = s.length();
    int i = skipWs(s, 0, len);
    if (i >= len || s.charAt(i) != '[') return null;
    i++;
    i = skipWs(s, i, len);
    String command = readString(s, i, len);
    if (command == null) return null;
    i = skipWs(s, indexAfterString(s, i, len), len);
    if (i >= len || s.charAt(i) != ',') return null;
    i++;
    i = skipWs(s, i, len);
    String id = readString(s, i, len);
    if (id == null) return null;
    return new String[] { unescape(command), unescape(id) };
  }

  private static int skipWs(String s, int i, int len) {
    while (i < len) {
      char c = s.charAt(i);
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
      i++;
    }
    return i;
  }

  /** Null if `s.charAt(from)` is not a `"`, or the string is unterminated;
   *  otherwise the raw (still-escaped) contents between the quotes. */
  private static String readString(String s, int from, int len) {
    if (from >= len || s.charAt(from) != '"') return null;
    int i = from + 1;
    StringBuilder sb = new StringBuilder();
    while (i < len) {
      char c = s.charAt(i);
      if (c == '"') return sb.toString();
      if (c == '\\' && i + 1 < len) {
        sb.append(c);
        sb.append(s.charAt(i + 1));
        i += 2;
        continue;
      }
      sb.append(c);
      i++;
    }
    return null; // unterminated
  }

  /** Index just past the closing quote of the string starting at `from`
   *  (which must itself be the opening quote), or `len` if unterminated. */
  private static int indexAfterString(String s, int from, int len) {
    int i = from + 1;
    while (i < len) {
      char c = s.charAt(i);
      if (c == '"') return i + 1;
      if (c == '\\' && i + 1 < len) {
        i += 2;
        continue;
      }
      i++;
    }
    return len;
  }

  private static String unescape(String raw) {
    if (raw.indexOf('\\') < 0) return raw;
    StringBuilder sb = new StringBuilder(raw.length());
    for (int i = 0; i < raw.length(); i++) {
      char c = raw.charAt(i);
      if (c == '\\' && i + 1 < raw.length()) {
        char next = raw.charAt(++i);
        switch (next) {
          case 'n': sb.append('\n'); break;
          case 't': sb.append('\t'); break;
          case 'r': sb.append('\r'); break;
          case '"': sb.append('"'); break;
          case '\\': sb.append('\\'); break;
          case '/': sb.append('/'); break;
          default: sb.append(next);
        }
      } else {
        sb.append(c);
      }
    }
    return sb.toString();
  }

  // ---- transport listener --------------------------------------------------

  private Transport.Listener listenerFor(RelaySocket rs) {
    return new Transport.Listener() {
      @Override
      public void onOpen() {
        handleOpen(rs);
      }

      @Override
      public void onMessage(String text) {
        handleMessage(rs, text);
      }

      @Override
      public void onClosing(int code, String reason) {
        handleClosing(rs, code, reason);
      }

      @Override
      public void onClosed(int code, String reason) {
        handleClosed(rs, code, reason);
      }

      @Override
      public void onFailure(String message) {
        handleFailure(rs, message);
      }
    };
  }

  private synchronized void handleOpen(RelaySocket rs) {
    rs.state = RelaySocket.OPEN;
    pushLocked(rs, rs.log.appendOpen());
  }

  private synchronized void handleMessage(RelaySocket rs, String text) {
    String[] frame = parseIncomingSubFrame(text);
    if (frame != null) {
      String subId = frame[1];
      if (subId.equals(rs.quarantineSentinel)) {
        // The end-marker itself is never delivered to JS. Its EOSE means
        // every stale frame for the CLOSEd ids has now arrived (relays
        // answer in order): quarantine lifts.
        if ("EOSE".equals(frame[0])) liftQuarantineLocked(rs);
        log("dropping quarantine sentinel frame on socket " + rs.id);
        return;
      }
      if (rs.stale.contains(subId)) {
        log("dropping stale frame for sub " + subId + " on socket " + rs.id);
        return;
      }
    }
    pushLocked(rs, rs.log.appendMessage(text));
  }

  private synchronized void handleClosing(RelaySocket rs, int code, String reason) {
    rs.state = RelaySocket.CLOSING;
    // Never echo the relay's own close code back at it: OkHttp rejects
    // reserved codes like 1005/1006 (they're never actually sent on the
    // wire), which onClosing can still be called with.
    safeClose(rs.transport, 1000, "");
  }

  private synchronized void handleClosed(RelaySocket rs, int code, String reason) {
    rs.state = RelaySocket.CLOSED;
    EventLog.Entry entry = rs.log.appendClose(code, reason);
    rs.closeSeq = entry.seq;
    pushLocked(rs, entry);
    maybeReapLocked(rs, Long.MIN_VALUE);
  }

  private synchronized void handleFailure(RelaySocket rs, String message) {
    rs.state = RelaySocket.CLOSED;
    pushLocked(rs, rs.log.appendError(message));
    EventLog.Entry closeEntry = rs.log.appendClose(1006, "");
    rs.closeSeq = closeEntry.seq;
    pushLocked(rs, closeEntry);
    maybeReapLocked(rs, Long.MIN_VALUE);
  }

  private void pushLocked(RelaySocket rs, EventLog.Entry entry) {
    Sink s = sink;
    if (s == null) return; // no bridge attached right now; stays in the log
    try {
      s.push(rs.id, entry);
    } catch (RuntimeException ignored) {
      // A push failure must never break hub state; the entry is still in
      // the log for the next receive()/resync.
    }
  }

  // ---- test/debug helpers -----------------------------------------------

  synchronized int socketCount() {
    return sockets.size();
  }

  synchronized RelaySocket socketFor(String id) {
    return sockets.get(id);
  }

  private static SocketSnapshot snapshot(RelaySocket rs) {
    // The last seq already assigned (0 for a fresh socket, since nextSeq()
    // starts at 1) — JS treats this as "the last seq I've already seen",
    // the baseline it hands back to receive()/ack().
    return new SocketSnapshot(rs.id, rs.url, rs.state, rs.log.nextSeq() - 1);
  }
}
