package dev.forgesworn.kindependence;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import android.webkit.WebView;
import android.webkit.RenderProcessGoneDetail;

public class MainActivity extends BridgeActivity {
  // WidgetBridgePlugin, SecureKeyPlugin, Nip55Plugin and RelaySocketPlugin
  // are app-local (not npm packages), so they don't auto-register the way
  // @capacitor/* plugins do — registered by hand, before super.onCreate,
  // same "register first" discipline as flock's own MainActivity.java.
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(WidgetBridgePlugin.class);
    registerPlugin(SecureKeyPlugin.class);
    registerPlugin(Nip55Plugin.class);
    registerPlugin(RelaySocketPlugin.class);
    super.onCreate(savedInstanceState);
    getBridge().addWebViewListener(new WebViewListener() {
      @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        if (view.getParent() instanceof android.view.ViewGroup) ((android.view.ViewGroup) view.getParent()).removeView(view);
        view.destroy();
        recreate();
        return true;
      }
    });
  }
}
