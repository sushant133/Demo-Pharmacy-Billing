package tech.mantramed;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.CookieManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Background check behind the stock/expiry notification.
 *
 * The WebView's JavaScript is frozen once the app leaves the screen, so the
 * check runs natively under WorkManager instead. It calls the same roll-up
 * the Alerts nav badge reads (POST /api/reports/alerts) with the session
 * cookie the WebView already holds, and posts to the notification shade only
 * when something new needs action - or once a day while anything still does.
 *
 * Signed out (401/403) means the till has changed hands: the notification is
 * cleared and the schedule cancelled until the next sign-in enables it again.
 *
 * Account-bound: `enable()` records which pharmacy + user this device was
 * switched on for, and the server echoes the account behind the cookie. If
 * they differ - another account signed in on the same phone - nothing is
 * posted and the old account's notification is withdrawn, so a device only
 * ever shows alerts for the account signed in on it.
 */
public class AlertCheckWorker extends Worker {

    static final String CHANNEL_ID = "stock-alerts";
    static final String EXTRA_OPEN_PATH = "tech.mantramed.OPEN_PATH";
    static final String PREFS = "alert-notify";
    static final String PREF_ORIGIN = "origin";
    static final String PREF_ACCOUNT = "account";

    private static final int NOTIFICATION_ID = 4101;
    private static final String PREF_LAST = "last-counts";
    private static final String PREF_LAST_NOTIFIED_AT = "last-notified-at";
    private static final long REMIND_AFTER_MS = 24L * 60 * 60 * 1000;

    public AlertCheckWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String origin = prefs.getString(PREF_ORIGIN, null);
        if (origin == null) return Result.success();

        String cookie;
        try {
            cookie = CookieManager.getInstance().getCookie(origin);
        } catch (Exception error) {
            return Result.retry();
        }
        if (cookie == null || cookie.isEmpty()) {
            clear(context);
            return Result.success();
        }

        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(origin + "/api/reports/alerts").openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(20_000);
            connection.setRequestProperty("Cookie", cookie);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            try (OutputStream body = connection.getOutputStream()) {
                body.write("{}".getBytes(StandardCharsets.UTF_8));
            }

            int status = connection.getResponseCode();
            if (status == 401 || status == 403) {
                clear(context);
                return Result.success();
            }
            if (status < 200 || status >= 300) return Result.retry();

            StringBuilder text = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) text.append(line);
            }

            JSONObject data = new JSONObject(text.toString()).getJSONObject("data");
            String expected = prefs.getString(PREF_ACCOUNT, null);
            String actual = data.optString("accountKey", "");
            if (expected != null && !actual.isEmpty() && !expected.equals(actual)) {
                // The cookie now belongs to someone else. Their own sign-in
                // re-enables notifications under their key; until then, stay quiet.
                NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
                return Result.success();
            }
            handle(context, prefs, data);
            return Result.success();
        } catch (Exception error) {
            return Result.retry();
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void handle(Context context, SharedPreferences prefs, JSONObject data) {
        JSONObject expiry = data.optJSONObject("expiry");
        JSONObject stock = data.optJSONObject("stock");
        int expired = expiry != null ? expiry.optInt("expired") : 0;
        int expiring = expiry != null ? expiry.optInt("critical") : 0;
        int out = stock != null ? stock.optInt("out") : 0;
        int runningOut = stock != null ? stock.optInt("critical") : 0;
        int total = data.optInt("actionableCount", expired + expiring + out + runningOut);

        int[] now = { expired, expiring, out, runningOut };
        int[] last = parse(prefs.getString(PREF_LAST, ""));
        long lastNotifiedAt = prefs.getLong(PREF_LAST_NOTIFIED_AT, 0);

        SharedPreferences.Editor editor = prefs.edit().putString(PREF_LAST, join(now));

        if (total <= 0) {
            editor.apply();
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
            return;
        }

        boolean grew = false;
        for (int i = 0; i < now.length; i++) {
            if (now[i] > last[i]) grew = true;
        }
        boolean remind = System.currentTimeMillis() - lastNotifiedAt >= REMIND_AFTER_MS;

        if (grew || remind) {
            List<String> parts = new ArrayList<>();
            if (expired > 0) parts.add(expired + " expired");
            if (expiring > 0) parts.add(expiring + " expiring soon");
            if (out > 0) parts.add(out + " out of stock");
            if (runningOut > 0) parts.add(runningOut + " running out");
            String body = parts.isEmpty() ? "Open Alerts to review." : String.join(" · ", parts);
            String title = total == 1 ? "1 alert needs action" : total + " alerts need action";
            // Land on the tab the news is about: expiry first, it costs money soonest.
            String path = expired + expiring > 0 ? "/alerts?tab=expiry" : "/alerts?tab=stock";

            // In the foreground the page shows its own popup, so the shade entry
            // goes in quietly rather than dropping a second banner over it.
            boolean foreground = MainActivity.isInForeground();
            if (show(context, total, title, body, path, foreground)) {
                editor.putLong(PREF_LAST_NOTIFIED_AT, System.currentTimeMillis());
            }
            if (foreground) AlertNotifyPlugin.emitAlerts(total, title, body, path);
        }
        editor.apply();
    }

    private boolean show(Context context, int total, String title, String body, String path, boolean silent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        ensureChannel(context);

        Intent open = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_OPEN_PATH, path);
        PendingIntent tap = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_alert)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setNumber(total)
            .setAutoCancel(true)
            .setSilent(silent)
            .setContentIntent(tap);

        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build());
            return true;
        } catch (SecurityException denied) {
            return false;
        }
    }

    static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        // HIGH so it drops down as a heads-up banner, not only into the shade.
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Stock & expiry alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Expired, expiring and out-of-stock medicines that need action.");
        manager.createNotificationChannel(channel);
    }

    /** Signed out or disabled: drop the notification, the baseline, the account and the schedule. */
    static void clear(Context context) {
        resetBaseline(context);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(PREF_ACCOUNT).apply();
        AlertNotifyPlugin.cancelSchedule(context);
    }

    /** A different account: its first check starts from nothing, not from the last one's counts. */
    static void resetBaseline(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(PREF_LAST)
            .remove(PREF_LAST_NOTIFIED_AT)
            .apply();
    }

    private static int[] parse(String value) {
        int[] counts = new int[4];
        String[] parts = value.split(",");
        for (int i = 0; i < counts.length && i < parts.length; i++) {
            try {
                counts[i] = Integer.parseInt(parts[i].trim());
            } catch (NumberFormatException ignored) {
                // A missing or garbled value counts as zero: worst case, one extra notification.
            }
        }
        return counts;
    }

    private static String join(int[] counts) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < counts.length; i++) {
            if (i > 0) out.append(',');
            out.append(counts[i]);
        }
        return out.toString();
    }
}
