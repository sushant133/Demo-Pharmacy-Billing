package tech.mantramed;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The WebView has no window.print(); SystemPrint bridges to Android's
        // PrintManager so the "Print bill" button still reaches paper.
        registerPlugin(SystemPrintPlugin.class);
        // Stock/expiry alerts in the notification shade, checked in the background.
        registerPlugin(AlertNotifyPlugin.class);
        super.onCreate(savedInstanceState);
        openFromNotification(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromNotification(intent);
    }

    /** A tapped alert notification lands on the Alerts screen, not wherever the app last was. */
    private void openFromNotification(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra(AlertCheckWorker.EXTRA_OPEN_PATH);
        if (path == null || !path.startsWith("/")) return;
        // Once only: a rotation or relaunch must not keep dragging the user back.
        intent.removeExtra(AlertCheckWorker.EXTRA_OPEN_PATH);

        String origin = getSharedPreferences(AlertCheckWorker.PREFS, Context.MODE_PRIVATE)
            .getString(AlertCheckWorker.PREF_ORIGIN, null);
        Bridge bridge = getBridge();
        if (origin == null || bridge == null) return;

        WebView webView = bridge.getWebView();
        webView.post(() -> webView.loadUrl(origin + path));
    }
}
