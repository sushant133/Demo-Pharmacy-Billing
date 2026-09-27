package tech.mantramed;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.lang.ref.WeakReference;
import java.util.concurrent.TimeUnit;

/**
 * Turns stock/expiry alerts into Android notifications.
 *
 * `enable({ accountKey })` is called by the web layer once a signed-in user
 * who can see alerts reaches the app (components/native/AlertNotifications.tsx).
 * It asks for the notification permission on Android 13+, binds the device to
 * that account, then schedules AlertCheckWorker every 15 minutes - WorkManager's
 * floor - plus one run straight away. `disable()` is called on sign-out.
 *
 * Two events go back to the page:
 *   - `alerts`: the worker found something new while the app is on screen,
 *     so the page shows its own popup instead of a system banner.
 *   - `open`: a notification was tapped. The page navigates client-side
 *     (components/native/NotificationOpener.tsx) rather than the WebView
 *     reloading, which is what used to flash a white screen.
 */
@CapacitorPlugin(
    name = "AlertNotify",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
)
public class AlertNotifyPlugin extends Plugin {

    private static final String PERIODIC_WORK = "alert-check";
    private static final String IMMEDIATE_WORK = "alert-check-now";

    private static WeakReference<AlertNotifyPlugin> instance = new WeakReference<>(null);
    /** A tapped notification's path the page has not picked up yet. */
    private static String pendingOpen;

    @Override
    public void load() {
        instance = new WeakReference<>(this);
    }

    @PluginMethod
    public void enable(PluginCall call) {
        // Bound before the permission prompt, so a check that races it
        // already knows whose alerts it may show.
        bindAccount(call.getString("accountKey"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        schedule(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        // Scheduled either way: with the permission refused the worker stays
        // silent, and granting it later in Settings starts notifications
        // without another sign-in.
        schedule(call);
    }

    @PluginMethod
    public void disable(PluginCall call) {
        AlertCheckWorker.clear(getContext());
        call.resolve();
    }

    /** Check now rather than at the next 15-minute slot - on resume, and while on screen. */
    @PluginMethod
    public void checkNow(PluginCall call) {
        Context context = getContext();
        String origin = context.getSharedPreferences(AlertCheckWorker.PREFS, Context.MODE_PRIVATE)
            .getString(AlertCheckWorker.PREF_ORIGIN, null);
        if (origin != null) enqueueImmediate(context);
        call.resolve();
    }

    /** The path of a notification tapped before the page was listening (a cold start). */
    @PluginMethod
    public void consumePendingOpen(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (AlertNotifyPlugin.class) {
            result.put("path", pendingOpen);
            pendingOpen = null;
        }
        call.resolve(result);
    }

    /**
     * Hand a tapped notification's path to the page. True when a listener
     * took it; otherwise it waits for `consumePendingOpen`.
     */
    static boolean deliverOpen(String path) {
        AlertNotifyPlugin plugin = instance.get();
        synchronized (AlertNotifyPlugin.class) {
            if (plugin != null && plugin.hasListeners("open")) {
                pendingOpen = null;
                JSObject data = new JSObject();
                data.put("path", path);
                plugin.notifyListeners("open", data);
                return true;
            }
            pendingOpen = path;
            return false;
        }
    }

    /** Still waiting: nobody on the page picked the tap up. */
    static synchronized String takePendingOpen() {
        String path = pendingOpen;
        pendingOpen = null;
        return path;
    }

    /** From the worker thread: something new while the app is on screen. */
    static void emitAlerts(int total, String title, String body, String path) {
        AlertNotifyPlugin plugin = instance.get();
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("total", total);
        data.put("title", title);
        data.put("body", body);
        data.put("path", path);
        plugin.notifyListeners("alerts", data);
    }

    private void bindAccount(String accountKey) {
        if (accountKey == null || accountKey.isEmpty()) return;
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences(AlertCheckWorker.PREFS, Context.MODE_PRIVATE);
        if (accountKey.equals(prefs.getString(AlertCheckWorker.PREF_ACCOUNT, null))) return;
        // A different account on this device: none of the last one's
        // notification or counts carry over.
        AlertCheckWorker.resetBaseline(context);
        prefs.edit().putString(AlertCheckWorker.PREF_ACCOUNT, accountKey).apply();
    }

    private void schedule(PluginCall call) {
        Context context = getContext();
        String origin = serverOrigin();
        if (origin == null) {
            call.reject("No https server origin to check alerts against.");
            return;
        }

        context.getSharedPreferences(AlertCheckWorker.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(AlertCheckWorker.PREF_ORIGIN, origin)
            .apply();
        AlertCheckWorker.ensureChannel(context);

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(AlertCheckWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(online())
                .build()
        );
        enqueueImmediate(context);

        JSObject result = new JSObject();
        result.put("granted", notificationsAllowed());
        call.resolve(result);
    }

    private static void enqueueImmediate(Context context) {
        WorkManager.getInstance(context).enqueueUniqueWork(
            IMMEDIATE_WORK,
            ExistingWorkPolicy.REPLACE,
            new OneTimeWorkRequest.Builder(AlertCheckWorker.class).setConstraints(online()).build()
        );
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    private boolean notificationsAllowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || getPermissionState("notifications") == PermissionState.GRANTED;
    }

    /**
     * The origin comes from the app's own config (capacitor.config.ts
     * server.url), never from the page, so the session cookie is only ever
     * sent back to the server that set it.
     */
    private String serverOrigin() {
        String url = getBridge().getConfig().getServerUrl();
        if (url == null || url.isEmpty()) return null;
        Uri parsed = Uri.parse(url);
        if (!"https".equals(parsed.getScheme()) || parsed.getHost() == null) return null;
        return "https://" + parsed.getEncodedAuthority();
    }

    static void cancelSchedule(Context context) {
        WorkManager work = WorkManager.getInstance(context);
        work.cancelUniqueWork(PERIODIC_WORK);
        work.cancelUniqueWork(IMMEDIATE_WORK);
    }
}
