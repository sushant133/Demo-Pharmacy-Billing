package tech.mantramed;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * How long a tapped notification waits for the page to pick it up before
     * the WebView is sent there directly. Only a web build older than the
     * APK - one without NotificationOpener - should ever reach it.
     */
    private static final long OPEN_FALLBACK_MS = 10_000;

    private static volatile boolean inForeground;

    /** On screen: alert checks show an in-page popup rather than a system banner. */
    static boolean isInForeground() {
        return inForeground;
    }

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
    public void onResume() {
        super.onResume();
        inForeground = true;
    }

    @Override
    public void onPause() {
        inForeground = false;
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFromNotification(intent);
    }

    /**
     * A tapped alert notification lands on its screen, not wherever the app
     * last was. The page navigates itself (no reload, no white flash); on a
     * cold start it asks for the path once it has mounted.
     */
    private void openFromNotification(Intent intent) {
        if (intent == null) return;
        String path = intent.getStringExtra(AlertCheckWorker.EXTRA_OPEN_PATH);
        if (path == null || !path.startsWith("/") || path.startsWith("//")) return;
        // Once only: a rotation or relaunch must not keep dragging the user back.
        intent.removeExtra(AlertCheckWorker.EXTRA_OPEN_PATH);

        if (AlertNotifyPlugin.deliverOpen(path)) return;

        Bridge bridge = getBridge();
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        webView.postDelayed(() -> {
            String waiting = AlertNotifyPlugin.takePendingOpen();
            if (waiting == null) return;
            String origin = getSharedPreferences(AlertCheckWorker.PREFS, Context.MODE_PRIVATE)
                .getString(AlertCheckWorker.PREF_ORIGIN, null);
            if (origin != null) webView.loadUrl(origin + waiting);
        }, OPEN_FALLBACK_MS);
    }
}
