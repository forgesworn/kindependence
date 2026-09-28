// kindependence — native socket bridge: the real, OkHttp-backed
// SocketHub.Transport. Only text frames go to JS (nostr is JSON text);
// binary frames are dropped with a Log.w, per the plan's OkHttp mapping.
//
// One OkHttpClient per hub (Factory holds it, shared by every Transport it
// mints) with a 30 s pingInterval, so a dead network path is noticed within
// about a minute even with nothing to send.
package cc.trotters.kindependence;

import android.util.Log;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

final class RelaySocketOkHttpTransport implements SocketHub.Transport {

  private static final String TAG = "RelaySocket";

  static final class Factory implements SocketHub.TransportFactory {
    private final OkHttpClient client = new OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build();

    @Override
    public SocketHub.Transport create() {
      return new RelaySocketOkHttpTransport(client);
    }
  }

  private final OkHttpClient client;
  private volatile WebSocket webSocket;

  private RelaySocketOkHttpTransport(OkHttpClient client) {
    this.client = client;
  }

  @Override
  public void open(String url, Listener listener) {
    Request request = new Request.Builder().url(url).build();
    webSocket = client.newWebSocket(request, new WebSocketListener() {
      @Override
      public void onOpen(WebSocket ws, Response response) {
        listener.onOpen();
      }

      @Override
      public void onMessage(WebSocket ws, String text) {
        listener.onMessage(text);
      }

      @Override
      public void onMessage(WebSocket ws, ByteString bytes) {
        Log.w(TAG, "native-socket: dropping binary frame (" + bytes.size() + " bytes)");
      }

      @Override
      public void onClosing(WebSocket ws, int code, String reason) {
        listener.onClosing(code, reason);
      }

      @Override
      public void onClosed(WebSocket ws, int code, String reason) {
        listener.onClosed(code, reason);
      }

      @Override
      public void onFailure(WebSocket ws, Throwable t, Response response) {
        listener.onFailure(t.getMessage() == null ? t.toString() : t.getMessage());
      }
    });
  }

  @Override
  public void send(String data) {
    WebSocket ws = webSocket;
    if (ws != null) ws.send(data);
  }

  @Override
  public void close(int code, String reason) {
    WebSocket ws = webSocket;
    if (ws != null) ws.close(code, reason);
  }
}
