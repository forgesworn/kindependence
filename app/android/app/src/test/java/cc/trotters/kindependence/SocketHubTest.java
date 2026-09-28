package cc.trotters.kindependence;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

/** Native socket bridge plan: SocketHub against a fake Transport (no
 *  OkHttp, no Android — plain JUnit). */
public class SocketHubTest {

  // ---- fakes ----------------------------------------------------------

  static class FakeTransport implements SocketHub.Transport {
    final String url;
    SocketHub.Transport.Listener listener;
    final List<String> sent = new ArrayList<>();
    final List<int[]> closes = new ArrayList<>();
    final List<String> closeReasons = new ArrayList<>();

    FakeTransport(String url) {
      this.url = url;
    }

    @Override
    public void open(String url, Listener listener) {
      this.listener = listener;
    }

    @Override
    public void send(String data) {
      sent.add(data);
    }

    @Override
    public void close(int code, String reason) {
      closes.add(new int[] { code });
      closeReasons.add(reason);
    }

    boolean closed() {
      return !closes.isEmpty();
    }
  }

  static class FakeTransportFactory implements SocketHub.TransportFactory {
    final List<FakeTransport> created = new ArrayList<>();
    String nextUrl;

    @Override
    public SocketHub.Transport create() {
      FakeTransport t = new FakeTransport(nextUrl);
      created.add(t);
      return t;
    }
  }

  static final class MutableClock {
    long now = 0;
  }

  private static SocketHub newHub(FakeTransportFactory factory, MutableClock clock) {
    return new SocketHub(factory, () -> clock.now);
  }

  // ---- open / send / receive lifecycle -----------------------------------

  @Test
  public void openCreatesASocketInConnectingState() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    factory.nextUrl = "wss://relay.example/";

    SocketHub.SocketSnapshot snap = hub.open("wss://relay.example/");
    assertEquals(RelaySocket.CONNECTING, snap.state);
    assertEquals("wss://relay.example/", snap.url);
    assertEquals(1, factory.created.size());
  }

  @Test
  public void onOpenTransitionsToOpenAndLogsAnOpenEntry() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot snap = hub.open("wss://relay.example/");

    factory.created.get(0).listener.onOpen();

    SocketHub.ReceiveResult r = hub.receive(snap.id, 0);
    assertEquals(RelaySocket.OPEN, r.state);
    assertEquals(1, r.entries.size());
    assertEquals("open", r.entries.get(0).type);
  }

  @Test
  public void sendRejectsWhenSocketIsNotOpen() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot snap = hub.open("wss://relay.example/");
    // still CONNECTING: no onOpen fired

    try {
      hub.send(snap.id, "[\"REQ\",\"sub1\"]");
      fail("expected not-open rejection");
    } catch (SocketHub.HubException e) {
      assertEquals("not-open", e.code);
    }
  }

  @Test
  public void sendRejectsForAnUnknownSocketId() {
    SocketHub hub = newHub(new FakeTransportFactory(), new MutableClock());
    try {
      hub.send("no-such-id", "hello");
      fail("expected not-open rejection");
    } catch (SocketHub.HubException e) {
      assertEquals("not-open", e.code);
    }
  }

  @Test
  public void sendForwardsToTransportOnceOpen() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot snap = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    hub.send(snap.id, "[\"REQ\",\"sub1\",{}]");

    assertEquals(1, factory.created.get(0).sent.size());
    assertEquals("[\"REQ\",\"sub1\",{}]", factory.created.get(0).sent.get(0));
  }

  @Test
  public void closingCallbackFinishesTheHandshakeAndClosedCallbackLogsClose() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot snap = hub.open("wss://relay.example/");
    FakeTransport t = factory.created.get(0);
    t.listener.onOpen();

    t.listener.onClosing(1000, "bye");
    assertTrue(t.closed()); // handshake finished via transport.close()

    t.listener.onClosed(1000, "bye");
    SocketHub.ReceiveResult r = hub.receive(snap.id, 1); // after the open entry
    assertEquals(RelaySocket.CLOSED, r.state);
    assertEquals(1, r.entries.size());
    assertEquals("close", r.entries.get(0).type);
    assertEquals(Integer.valueOf(1000), r.entries.get(0).code);
  }

  @Test
  public void onFailureLogsErrorThenCloseWithCode1006() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot snap = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    factory.created.get(0).listener.onFailure("network gone");

    SocketHub.ReceiveResult r = hub.receive(snap.id, 1);
    assertEquals(RelaySocket.CLOSED, r.state);
    assertEquals(2, r.entries.size());
    assertEquals("error", r.entries.get(0).type);
    assertEquals("network gone", r.entries.get(0).message);
    assertEquals("close", r.entries.get(1).type);
    assertEquals(Integer.valueOf(1006), r.entries.get(1).code);
  }

  // ---- per-socket isolation -----------------------------------------------

  @Test
  public void eachSocketHasItsOwnLog() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot a = hub.open("wss://a/");
    SocketHub.SocketSnapshot b = hub.open("wss://b/");
    factory.created.get(0).listener.onOpen();
    factory.created.get(1).listener.onOpen();

    hub.send(a.id, "[\"REQ\",\"s\",{}]");
    factory.created.get(0).listener.onMessage("{\"from\":\"a\"}");

    SocketHub.ReceiveResult rb = hub.receive(b.id, 1); // just the open entry acked
    assertEquals(0, rb.entries.size());

    SocketHub.ReceiveResult ra = hub.receive(a.id, 1);
    assertEquals(1, ra.entries.size());
    assertEquals("{\"from\":\"a\"}", ra.entries.get(0).data);
  }

  // ---- attach / orphan / adoption -----------------------------------------

  @Test
  public void attachOrphansSocketsOfAnEarlierSessionAndSendsCloseForRecordedSubIds() {
    FakeTransportFactory factory = new FakeTransportFactory();
    MutableClock clock = new MutableClock();
    SocketHub hub = newHub(factory, clock);
    hub.attach("session-1");
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();
    hub.send(s.id, "[\"REQ\",\"sub1\",{}]");
    hub.send(s.id, "[\"REQ\",\"sub2\",{}]");

    hub.attach("session-2");

    List<String> sent = factory.created.get(0).sent;
    // the two REQs, then a CLOSE for each recorded sub id
    assertTrue(sent.contains("[\"CLOSE\",\"sub1\"]"));
    assertTrue(sent.contains("[\"CLOSE\",\"sub2\"]"));
  }

  @Test
  public void orphanedSocketIsAdoptedByUrlWithoutANewConnection() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    hub.attach("session-1");
    SocketHub.SocketSnapshot original = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    hub.attach("session-2"); // orphans the socket

    SocketHub.SocketSnapshot adopted = hub.open("wss://relay.example/");
    assertEquals(original.id, adopted.id);
    assertEquals(RelaySocket.OPEN, adopted.state);
    assertEquals(1, factory.created.size()); // no second Transport created
  }

  @Test
  public void orphanNotAdoptedWithinTtlIsClosedAndDropped() {
    FakeTransportFactory factory = new FakeTransportFactory();
    MutableClock clock = new MutableClock();
    SocketHub hub = newHub(factory, clock);
    hub.attach("session-1");
    SocketHub.SocketSnapshot orphaned = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    hub.attach("session-2"); // orphans it
    clock.now += SocketHub.ORPHAN_TTL_MS; // exactly at the boundary: expired

    // triggers expiry sweep
    hub.open("wss://another-relay/");

    assertTrue(factory.created.get(0).closed());
    try {
      hub.receive(orphaned.id, 0);
      fail("expected the expired orphan to be gone");
    } catch (SocketHub.HubException e) {
      // expected: unknown socket
    }
  }

  @Test
  public void orphanAdoptedBeforeTtlIsNotClosed() {
    FakeTransportFactory factory = new FakeTransportFactory();
    MutableClock clock = new MutableClock();
    SocketHub hub = newHub(factory, clock);
    hub.attach("session-1");
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();
    hub.attach("session-2");
    clock.now += SocketHub.ORPHAN_TTL_MS - 1;

    SocketHub.SocketSnapshot adopted = hub.open("wss://relay.example/");
    assertEquals(s.id, adopted.id);
    assertFalse(factory.created.get(0).closed());
  }

  // ---- close / deactivate -------------------------------------------------

  @Test
  public void closeIsIdempotentForUnknownOrAlreadyClosedSocket() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    hub.close("no-such-id", null, null); // must not throw

    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();
    factory.created.get(0).listener.onClosed(1000, "");
    hub.close(s.id, null, null); // already CLOSED: no-op, must not throw
  }

  @Test
  public void closeDefaultsCodeAndReason() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    hub.close(s.id, null, null);

    assertEquals(1000, factory.created.get(0).closes.get(0)[0]);
    assertEquals("", factory.created.get(0).closeReasons.get(0));
  }

  @Test
  public void deactivateAllClosesEverySocketAndClearsTheHub() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot a = hub.open("wss://a/");
    SocketHub.SocketSnapshot b = hub.open("wss://b/");
    factory.created.get(0).listener.onOpen();
    factory.created.get(1).listener.onOpen();

    hub.deactivateAll();

    assertTrue(factory.created.get(0).closed());
    assertTrue(factory.created.get(1).closed());
    try {
      hub.receive(a.id, 0);
      fail("expected the hub to be cleared");
    } catch (SocketHub.HubException e) {
      // expected
    }
    try {
      hub.receive(b.id, 0);
      fail("expected the hub to be cleared");
    } catch (SocketHub.HubException e) {
      // expected
    }
  }

  // ---- receive / ack --------------------------------------------------

  @Test
  public void receiveRejectsAnUnknownSocketId() {
    SocketHub hub = newHub(new FakeTransportFactory(), new MutableClock());
    try {
      hub.receive("no-such-id", 0);
      fail("expected an exception");
    } catch (SocketHub.HubException expected) {
      // ok
    }
  }

  @Test
  public void ackRejectsAnUnknownSocketId() {
    SocketHub hub = newHub(new FakeTransportFactory(), new MutableClock());
    try {
      hub.ack("no-such-id", 5);
      fail("expected an exception");
    } catch (SocketHub.HubException expected) {
      // ok
    }
  }

  @Test
  public void ackEvictsWithoutReturningEntries() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();
    factory.created.get(0).listener.onMessage("m1");

    hub.ack(s.id, 2); // acks open (1) and message (2)

    SocketHub.ReceiveResult r = hub.receive(s.id, 0);
    assertEquals(0, r.entries.size());
    assertFalse(r.gap);
  }

  // ---- command parsing (used internally by send) -------------------------

  @Test
  public void parseCommandRecognisesReqAndClose() {
    assertEquals("REQ", SocketHub.parseCommand("[\"REQ\",\"sub1\",{\"kinds\":[1]}]")[0]);
    assertEquals("sub1", SocketHub.parseCommand("[\"REQ\",\"sub1\",{\"kinds\":[1]}]")[1]);
    assertEquals("CLOSE", SocketHub.parseCommand("[\"CLOSE\",\"sub1\"]")[0]);
    assertEquals("sub1", SocketHub.parseCommand("[\"CLOSE\",\"sub1\"]")[1]);
  }

  @Test
  public void parseCommandIgnoresEventAndOtherFrames() {
    assertNull(SocketHub.parseCommand("[\"EVENT\",{\"id\":\"x\"}]"));
    assertNull(SocketHub.parseCommand("not json at all"));
    assertNull(SocketHub.parseCommand(null));
  }

  @Test
  public void closeFrameShapeMatchesNostrCloseMessage() {
    assertEquals("[\"CLOSE\",\"sub1\"]", SocketHub.closeFrame("sub1"));
  }

  // ---- seq semantics: "last seq already seen", not "next seq" -----------

  @Test
  public void freshSocketSeqIsZeroUntilTheFirstEntry() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot snap = hub.open("wss://relay.example/");
    assertEquals(0, snap.seq);

    factory.created.get(0).listener.onOpen(); // first entry: seq 1
    SocketHub.ReceiveResult r = hub.receive(snap.id, 0);
    assertEquals(1, r.entries.size());
    assertEquals(1, r.entries.get(0).seq);
  }

  @Test
  public void adoptedSocketSeqEqualsTheLastEntryAppendedBeforeAdoption() {
    FakeTransportFactory factory = new FakeTransportFactory();
    MutableClock clock = new MutableClock();
    SocketHub hub = newHub(factory, clock);
    hub.attach("session-1");
    hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();       // seq 1
    factory.created.get(0).listener.onMessage("m"); // seq 2

    hub.attach("session-2"); // orphans it

    SocketHub.SocketSnapshot adopted = hub.open("wss://relay.example/");
    assertEquals(2, adopted.seq);
  }

  // ---- close-code echo safety --------------------------------------------

  @Test
  public void onClosingNeverEchoesTheRelaysCloseCodeBack() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    hub.open("wss://relay.example/");
    FakeTransport t = factory.created.get(0);
    t.listener.onOpen();

    t.listener.onClosing(1006, "abnormal"); // a code OkHttp would reject if echoed

    assertEquals(1000, t.closes.get(0)[0]);
    assertEquals("", t.closeReasons.get(0));
  }

  @Test
  public void aThrowingTransportCloseIsSwallowedNotPropagated() {
    FakeTransportFactory factory = new FakeTransportFactory() {
      @Override
      public SocketHub.Transport create() {
        FakeTransport t = new FakeTransport(nextUrl) {
          @Override
          public void close(int code, String reason) {
            super.close(code, reason);
            throw new IllegalArgumentException("bad code");
          }
        };
        created.add(t);
        return t;
      }
    };
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    hub.close(s.id, 1000, "bye"); // must not throw
    factory.created.get(0).listener.onClosing(1006, ""); // must not throw either
  }

  // ---- map hygiene: reaping closed sockets --------------------------------

  @Test
  public void closedSocketIsRemovedAfterAnExplicitClose() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    hub.close(s.id, null, null);
    factory.created.get(0).listener.onClosed(1000, "");

    assertEquals(0, hub.socketCount());
  }

  @Test
  public void closedSocketStaysUntilJsAcksPastItsCloseEntry() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();  // seq 1
    factory.created.get(0).listener.onClosed(1000, ""); // seq 2, closeSeq = 2

    assertEquals(1, hub.socketCount()); // not explicitly closed, not an orphan: stays

    hub.ack(s.id, 2); // acks up to and including the close entry

    assertEquals(0, hub.socketCount());
  }

  @Test
  public void closedSocketStaysIfAckDoesNotReachTheCloseEntry() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();  // seq 1
    factory.created.get(0).listener.onClosed(1000, ""); // seq 2

    hub.ack(s.id, 1); // hasn't reached the close entry yet

    assertEquals(1, hub.socketCount());
  }

  @Test
  public void closedOrphanIsRemovedImmediatelyWithoutWaitingForTtl() {
    FakeTransportFactory factory = new FakeTransportFactory();
    MutableClock clock = new MutableClock();
    SocketHub hub = newHub(factory, clock);
    hub.attach("session-1");
    hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();

    hub.attach("session-2"); // orphans it
    factory.created.get(0).listener.onClosed(1000, ""); // relay closed it while orphaned

    assertEquals(0, hub.socketCount());
  }

  // ---- periodic orphan sweep ----------------------------------------------

  @Test
  public void sweepExpiresOrphansPastTtlUsingTheInjectedClock() {
    FakeTransportFactory factory = new FakeTransportFactory();
    MutableClock clock = new MutableClock();
    SocketHub hub = newHub(factory, clock);
    hub.attach("session-1");
    hub.open("wss://relay.example/");
    factory.created.get(0).listener.onOpen();
    hub.attach("session-2"); // orphans it

    clock.now += SocketHub.ORPHAN_TTL_MS;
    hub.sweep();

    assertEquals(0, hub.socketCount());
    assertTrue(factory.created.get(0).closed());
  }

  @Test
  public void sweepIsANoOpWhenThereIsNothingToExpire() {
    SocketHub hub = newHub(new FakeTransportFactory(), new MutableClock());
    hub.sweep(); // must not throw on an empty hub
    assertEquals(0, hub.socketCount());
  }

  // ---- stale-subscription quarantine on adoption --------------------------

  /** Advances past a `receive` call the way JS would: the next call's
   *  `afterSeq` is the last seq it actually got back, not the original
   *  baseline. Returns the entries this call delivered. */
  private static List<EventLog.Entry> receiveNext(SocketHub hub, String id, long[] cursor) {
    SocketHub.ReceiveResult r = hub.receive(id, cursor[0]);
    if (!r.entries.isEmpty()) cursor[0] = r.entries.get(r.entries.size() - 1).seq;
    return r.entries;
  }

  /** Pulls the sentinel id out of the `["REQ","q:...",{"limit":0}]` frame
   *  orphanLocked sends (the last frame sent during that attach call). */
  private static String lastSentSentinelId(List<String> sent) {
    String frame = sent.get(sent.size() - 1);
    String[] cmd = SocketHub.parseCommand(frame);
    assertEquals("REQ", cmd[0]);
    return cmd[1];
  }

  @Test
  public void staleSubscriptionFramesStayDroppedUntilTheSentinelEoseArrives() {
    FakeTransportFactory factory = new FakeTransportFactory();
    SocketHub hub = newHub(factory, new MutableClock());
    hub.attach("session-1");
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    FakeTransport t = factory.created.get(0);
    t.listener.onOpen();
    hub.send(s.id, "[\"REQ\",\"sub:1\",{}]"); // old owner subscribes

    hub.attach("session-2"); // orphans: CLOSE for sub:1, then a sentinel REQ
    String sentinelId = lastSentSentinelId(t.sent);
    SocketHub.SocketSnapshot adopted = hub.open("wss://relay.example/"); // new owner adopts
    assertEquals(s.id, adopted.id);
    long[] cursor = { adopted.seq };

    // Stale EOSE for the old subscription: dropped, not logged.
    t.listener.onMessage("[\"EOSE\",\"sub:1\"]");
    assertEquals(0, receiveNext(hub, adopted.id, cursor).size());

    // New owner re-REQs the SAME id (nostr-tools does this immediately) --
    // must NOT lift quarantine; traffic for it is still dropped.
    hub.send(adopted.id, "[\"REQ\",\"sub:1\",{}]");
    t.listener.onMessage("[\"EVENT\",\"sub:1\",{\"id\":\"still-stale\"}]");
    assertEquals(0, receiveNext(hub, adopted.id, cursor).size());

    // A sub id that was never stale is delivered normally throughout.
    hub.send(adopted.id, "[\"REQ\",\"sub:2\",{}]");
    t.listener.onMessage("[\"EVENT\",\"sub:2\",{\"id\":\"fresh\"}]");
    List<EventLog.Entry> fresh = receiveNext(hub, adopted.id, cursor);
    assertEquals(1, fresh.size());
    assertEquals("[\"EVENT\",\"sub:2\",{\"id\":\"fresh\"}]", fresh.get(0).data);

    // The sentinel's own EOSE lifts quarantine and is itself dropped.
    t.listener.onMessage("[\"EOSE\",\"" + sentinelId + "\"]");
    assertEquals(0, receiveNext(hub, adopted.id, cursor).size());

    // Now traffic for sub:1 is delivered again.
    t.listener.onMessage("[\"EVENT\",\"sub:1\",{\"id\":\"finally\"}]");
    List<EventLog.Entry> revived = receiveNext(hub, adopted.id, cursor);
    assertEquals(1, revived.size());
    assertEquals("[\"EVENT\",\"sub:1\",{\"id\":\"finally\"}]", revived.get(0).data);
  }

  @Test
  public void quarantineLiftsAfterTenSecondsEvenWithoutASentinelEose() {
    FakeTransportFactory factory = new FakeTransportFactory();
    MutableClock clock = new MutableClock();
    SocketHub hub = newHub(factory, clock);
    hub.attach("session-1");
    SocketHub.SocketSnapshot s = hub.open("wss://relay.example/");
    FakeTransport t = factory.created.get(0);
    t.listener.onOpen();
    hub.send(s.id, "[\"REQ\",\"sub:1\",{}]");

    hub.attach("session-2"); // orphans: sub:1 becomes stale, quarantine starts now
    SocketHub.SocketSnapshot adopted = hub.open("wss://relay.example/");
    long[] cursor = { adopted.seq };

    // Still within the 10s window: dropped.
    t.listener.onMessage("[\"EVENT\",\"sub:1\",{\"id\":\"still-stale\"}]");
    assertEquals(0, receiveNext(hub, adopted.id, cursor).size());

    // No sentinel EOSE ever arrives; the timeout fallback lifts quarantine
    // instead, enforced by the periodic sweep.
    clock.now += SocketHub.QUARANTINE_TIMEOUT_MS;
    hub.sweep();

    t.listener.onMessage("[\"EVENT\",\"sub:1\",{\"id\":\"now-ok\"}]");
    List<EventLog.Entry> delivered = receiveNext(hub, adopted.id, cursor);
    assertEquals(1, delivered.size());
    assertEquals("[\"EVENT\",\"sub:1\",{\"id\":\"now-ok\"}]", delivered.get(0).data);
  }

  @Test
  public void reqSentinelFrameShapeIsAZeroLimitReq() {
    String frame = SocketHub.reqSentinelFrame("q:abc");
    assertEquals("[\"REQ\",\"q:abc\",{\"limit\":0}]", frame);
  }

  @Test
  public void parseIncomingSubFrameRecognisesEventEoseClosedOnly() {
    assertArrayEquals(new String[] { "EVENT", "sub:1" }, SocketHub.parseIncomingSubFrame("[\"EVENT\",\"sub:1\",{}]"));
    assertArrayEquals(new String[] { "EOSE", "sub:1" }, SocketHub.parseIncomingSubFrame("[\"EOSE\",\"sub:1\"]"));
    assertArrayEquals(
      new String[] { "CLOSED", "sub:1" },
      SocketHub.parseIncomingSubFrame("[\"CLOSED\",\"sub:1\",\"reason\"]")
    );
    assertNull(SocketHub.parseIncomingSubFrame("[\"NOTICE\",\"hi\"]"));
    // A client->relay EVENT publish has no sub id (its 2nd element is the
    // event object, not a string), so it must not parse as one.
    assertNull(SocketHub.parseIncomingSubFrame("[\"EVENT\",{\"id\":\"abc\"}]"));
  }
}
