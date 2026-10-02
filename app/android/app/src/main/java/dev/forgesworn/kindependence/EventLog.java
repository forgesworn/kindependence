// kindependence — native socket bridge (plan
// internal design record: 2026-09-28-native-socket-bridge.md): the bounded,
// seq-numbered event log kept per relay socket by SocketHub. Pure Java, no
// Android imports, so it runs under plain JUnit.
//
// Entries are appended as they happen (open/message/error/close) and stay in
// the log until the JS side acks them (`ack`/`receive`), so a push lost to a
// frozen WebView can be replayed on resume. The log is bounded by both count
// and total payload bytes; on overflow the oldest un-acked entries are
// evicted and counted (`dropped()`), and `hasGapAfter` tells the caller when
// it asked for a seq that no longer exists because of that eviction (as
// opposed to one it acked itself, which is not a gap).
package dev.forgesworn.kindependence;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

public final class EventLog {

  public static final int MAX_ENTRIES = 2000;
  public static final int MAX_BYTES = 4 * 1024 * 1024; // 4 MiB

  /** One log entry. Fields mirror the `receive` result / `entry` event
   *  shape in the plugin API table: `{ seq, type, data?, code?, reason?,
   *  message? }`. */
  public static final class Entry {
    public final long seq;
    public final String type;
    public final String data;
    public final Integer code;
    public final String reason;
    public final String message;

    Entry(long seq, String type, String data, Integer code, String reason, String message) {
      this.seq = seq;
      this.type = type;
      this.data = data;
      this.code = code;
      this.reason = reason;
      this.message = message;
    }

    /** Rough serialized size for the byte bound: the fields that carry
     *  payload, in UTF-16 chars. Not exact wire size; a stable, cheap proxy
     *  is all the bound needs. */
    int approxBytes() {
      int n = type == null ? 0 : type.length();
      if (data != null) n += data.length();
      if (reason != null) n += reason.length();
      if (message != null) n += message.length();
      return n;
    }
  }

  private final Deque<Entry> entries = new ArrayDeque<>();
  private long nextSeq = 1;
  private long droppedCount = 0;
  private long evictedUpToSeq = 0; // high-water mark of overflow-evicted seqs
  private int totalBytes = 0;

  public synchronized Entry append(String type, String data, Integer code, String reason, String message) {
    Entry e = new Entry(nextSeq++, type, data, code, reason, message);
    entries.addLast(e);
    totalBytes += e.approxBytes();
    evictOverflowLocked();
    return e;
  }

  public Entry appendOpen() {
    return append("open", null, null, null, null);
  }

  public Entry appendMessage(String data) {
    return append("message", data, null, null, null);
  }

  public Entry appendError(String message) {
    return append("error", null, null, null, message);
  }

  public Entry appendClose(int code, String reason) {
    return append("close", null, code, reason, null);
  }

  private void evictOverflowLocked() {
    while (entries.size() > MAX_ENTRIES || totalBytes > MAX_BYTES) {
      Entry oldest = entries.pollFirst();
      if (oldest == null) break;
      totalBytes -= oldest.approxBytes();
      droppedCount++;
      if (oldest.seq > evictedUpToSeq) evictedUpToSeq = oldest.seq;
    }
  }

  /** Entries with seq strictly greater than afterSeq, in order. */
  public synchronized List<Entry> since(long afterSeq) {
    List<Entry> out = new ArrayList<>();
    for (Entry e : entries) {
      if (e.seq > afterSeq) out.add(e);
    }
    return out;
  }

  /** Evicts entries with seq <= upToSeq: the caller has them, they can go. */
  public synchronized void ack(long upToSeq) {
    while (!entries.isEmpty() && entries.peekFirst().seq <= upToSeq) {
      Entry e = entries.pollFirst();
      totalBytes -= e.approxBytes();
    }
  }

  /** Entries evicted for overflow (not acked away), all-time. */
  public synchronized long dropped() {
    return droppedCount;
  }

  /** True when the caller, sitting at afterSeq, can no longer reconstruct
   *  the stream because something beyond that point was overflow-evicted
   *  (as opposed to acked, which the caller already knows about). */
  public synchronized boolean hasGapAfter(long afterSeq) {
    if (evictedUpToSeq > afterSeq) return true;
    Entry oldest = entries.peekFirst();
    return oldest != null && oldest.seq > afterSeq + 1;
  }

  /** The seq that will be assigned to the next appended entry. */
  public synchronized long nextSeq() {
    return nextSeq;
  }

  /** Empties the log without disturbing the seq counter: used when a
   *  socket is orphaned (plan: "clears its event log and resets its ack
   *  point to the current seq" — the ack point becomes nextSeq()-1, i.e.
   *  as if everything so far had been acked; seq numbering itself stays
   *  monotonic). Overflow bookkeeping (dropped/evictedUpToSeq) is cleared
   *  too: nothing retained means nothing to report a gap against. */
  public synchronized void clear() {
    entries.clear();
    totalBytes = 0;
    droppedCount = 0;
    evictedUpToSeq = 0;
  }
}
