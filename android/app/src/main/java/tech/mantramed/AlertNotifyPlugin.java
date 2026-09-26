package tech.mantramed;

import android.Manifest;
import android.content.Context;
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

import java.util.concurrent.TimeUnit;

/**
 * Turns stock/expiry alerts into Android notifications.
 *
 * `enable()` is called by the web layer once a signed-in user who can see
 * alerts reaches the app (components/native/AlertNotifications.tsx). It asks
 * for the notification permission on Android 13+, then schedules
 * AlertCheckWorker every 15 minutes - WorkManager's floor - plus one run
 * straight away. `disable()` is called on sign-out.
 */
@CapacitorPlugin(
    name = "AlertNotify",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
)
public class AlertNotifyPlugin extends Plugin {

    private static final String PERIODIC_WORK = "alert-check";
    private static final String IMMEDIATE_WORK = "alert-check-now";

    @PluginMethod
    public void enable(PluginCall call) {
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

        Constraints online = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        WorkManager work = WorkManager.getInstance(context);
        work.enqueueUniquePeriodicWork(
            PERIODIC_WORK,
            ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(AlertCheckWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(online)
                .build()
        );
        work.enqueueUniqueWork(
            IMMEDIATE_WORK,
            ExistingWorkPolicy.REPLACE,
            new OneTimeWorkRequest.Builder(AlertCheckWorker.class).setConstraints(online).build()
        );

        JSObject result = new JSObject();
        result.put("granted", notificationsAllowed());
        call.resolve(result);
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
