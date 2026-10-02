package dev.forgesworn.kindependence;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

/** Native socket bridge plan: the bounded, seq-numbered per-socket log. */
public class EventLogTest {

  @Test
  public void appendAssignsIncreasingSeqStartingAtOne() {
    EventLog log = new EventLog();
    EventLog.Entry a = log.appendOpen();
    EventLog.Entry b = log.appendMessage("hi");
    assertEquals(1, a.seq);
    assertEquals(2, b.seq);
    assertEquals(3, log.nextSeq());
  }

  @Test
  public void sinceReturnsOnlyLaterEntriesInOrder() {
    EventLog log = new EventLog();
    log.appendOpen();
    log.appendMessage("one");
    log.appendMessage("two");
    List<EventLog.Entry> out = log.since(1);
    assertEquals(2, out.size());
    assertEquals("one", out.get(0).data);
    assertEquals("two", out.get(1).data);
  }

  @Test
  public void sinceZeroReturnsEverything() {
    EventLog log = new EventLog();
    log.appendOpen();
    log.appendMessage("x");
    assertEquals(2, log.since(0).size());
  }

  @Test
  public void ackEvictsUpToAndIncludingTheGivenSeq() {
    EventLog log = new EventLog();
    log.appendOpen();       // seq 1
    log.appendMessage("a"); // seq 2
    log.appendMessage("b"); // seq 3
    log.ack(2);
    List<EventLog.Entry> remaining = log.since(0);
    assertEquals(1, remaining.size());
    assertEquals(3, remaining.get(0).seq);
  }

  @Test
  public void ackDoesNotCountAsDroppedOrGap() {
    EventLog log = new EventLog();
    log.appendOpen();
    log.appendMessage("a");
    log.ack(2);
    assertEquals(0, log.dropped());
    assertFalse(log.hasGapAfter(2));
  }

  @Test
  public void boundedByEntryCountEvictsOldestAndCounts() {
    EventLog log = new EventLog();
    for (int i = 0; i < EventLog.MAX_ENTRIES + 5; i++) {
      log.appendMessage("m" + i);
    }
    assertEquals(5, log.dropped());
    List<EventLog.Entry> remaining = log.since(0);
    assertEquals(EventLog.MAX_ENTRIES, remaining.size());
    // the oldest surviving entry is the 6th appended (seq 6), 1-indexed
    assertEquals(6, remaining.get(0).seq);
  }

  @Test
  public void boundedByTotalBytesEvictsOldestAndCounts() {
    EventLog log = new EventLog();
    String big = repeat("x", EventLog.MAX_BYTES / 3 + 1);
    log.appendMessage(big); // seq 1
    log.appendMessage(big); // seq 2
    log.appendMessage(big); // seq 3 -- pushes total over MAX_BYTES, evicts seq 1
    assertTrue(log.dropped() >= 1);
    List<EventLog.Entry> remaining = log.since(0);
    assertFalse(containsSeq(remaining, 1));
  }

  @Test
  public void gapDetectedWhenAskedSeqWasOverflowEvicted() {
    EventLog log = new EventLog();
    for (int i = 0; i < EventLog.MAX_ENTRIES + 3; i++) {
      log.appendMessage("m" + i);
    }
    // seqs 1..3 were overflow-evicted; asking for anything at or before that
    // is a gap.
    assertTrue(log.hasGapAfter(0));
    assertTrue(log.hasGapAfter(2));
    assertFalse(log.hasGapAfter(3));
  }

  @Test
  public void noGapOnAFreshOrEmptyLog() {
    EventLog log = new EventLog();
    assertFalse(log.hasGapAfter(0));
    log.appendOpen();
    log.ack(1);
    assertFalse(log.hasGapAfter(1));
  }

  @Test
  public void clearEmptiesEntriesButKeepsSeqMonotonic() {
    EventLog log = new EventLog();
    log.appendOpen();       // seq 1
    log.appendMessage("a"); // seq 2
    log.clear();
    assertEquals(0, log.since(0).size());
    assertEquals(3, log.nextSeq());
    EventLog.Entry next = log.appendMessage("b");
    assertEquals(3, next.seq);
  }

  @Test
  public void clearResetsDroppedAndGapBookkeeping() {
    EventLog log = new EventLog();
    for (int i = 0; i < EventLog.MAX_ENTRIES + 5; i++) {
      log.appendMessage("m" + i);
    }
    assertTrue(log.dropped() > 0);
    log.clear();
    assertEquals(0, log.dropped());
    assertFalse(log.hasGapAfter(0));
  }

  @Test
  public void entryTypesCarryTheirOwnFields() {
    EventLog log = new EventLog();
    EventLog.Entry open = log.appendOpen();
    EventLog.Entry msg = log.appendMessage("payload");
    EventLog.Entry err = log.appendError("boom");
    EventLog.Entry close = log.appendClose(1000, "bye");

    assertEquals("open", open.type);
    assertEquals("message", msg.type);
    assertEquals("payload", msg.data);
    assertEquals("error", err.type);
    assertEquals("boom", err.message);
    assertEquals("close", close.type);
    assertEquals(Integer.valueOf(1000), close.code);
    assertEquals("bye", close.reason);
  }

  private static boolean containsSeq(List<EventLog.Entry> entries, long seq) {
    for (EventLog.Entry e : entries) {
      if (e.seq == seq) return true;
    }
    return false;
  }

  private static String repeat(String s, int n) {
    StringBuilder sb = new StringBuilder(n);
    for (int i = 0; i < n; i++) sb.append(s);
    return sb.toString();
  }
}
