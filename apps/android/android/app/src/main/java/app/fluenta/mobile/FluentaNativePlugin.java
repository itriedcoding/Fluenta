package app.fluenta.mobile;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * The native side of the Android app.
 *
 * `installUpdate` is a real DownloadManager download of the GitHub release APK,
 * followed by a real package-installer intent. There is no simulated progress:
 * every event comes from DownloadManager itself.
 */
@CapacitorPlugin(name = "FluentaNative")
public class FluentaNativePlugin extends Plugin {

    private static final String PREFS = MainActivity.PREFS;
    private static final String KEY_APK_PATH = "downloaded_apk_path";
    private static final String KEY_APK_VERSION = "downloaded_apk_version";

    private long downloadId = -1L;
    private String downloadFileName;
    private String downloadVersion;
    private BroadcastReceiver receiver;
    private Handler handler;
    private Runnable progressPoll;

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject result = new JSObject();
        try {
            android.content.pm.PackageInfo info = getContext()
                .getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            result.put(
                "versionCode",
                Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode
            );
        } catch (Exception err) {
            result.put("versionName", "");
            result.put("versionCode", 0);
        }
        result.put("packageName", getContext().getPackageName());
        result.put("platform", "android");
        result.put("installer", Build.MANUFACTURER + " " + Build.MODEL);
        call.resolve(result);
    }

    @PluginMethod
    public void probeServer(PluginCall call) {
        String raw = call.getString("url", "");
        getBridge().execute(() -> {
            JSONObject probe = probeServerUrl(raw);
            JSObject result = new JSObject();
            result.put("ok", probe.optBoolean("ok"));
            result.put("url", probe.optString("url", ""));
            result.put("name", probe.optString("name", ""));
            result.put("version", probe.optString("version", ""));
            result.put("error", probe.optString("error", ""));
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setServer(PluginCall call) {
        String raw = call.getString("url", "");
        getBridge().execute(() -> {
            JSONObject probe = probeServerUrl(raw);
            if (!probe.optBoolean("ok")) {
                call.reject(probe.optString("error", "That server could not be reached."));
                return;
            }
            MainActivity.saveServer(getContext(), probe.optString("url"));
            call.resolve();
            MainActivity.restart(getContext());
        });
    }

    @PluginMethod
    public void changeServer(PluginCall call) {
        MainActivity.clearServer(getContext());
        call.resolve();
        MainActivity.restart(getContext());
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 26) {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getContext().startActivity(intent);
            } catch (Exception ignored) {
                // Some OEM builds hide this screen; the installer still prompts.
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String version = call.getString("version", "latest");
        if (url == null || url.isEmpty()) {
            call.reject("Missing the update download URL.");
            return;
        }
        if (!isTrustedDownload(url)) {
            call.reject("Refusing to download an APK from an untrusted host.");
            return;
        }

        // If this exact version was already downloaded, install it without refetching.
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String existingPath = prefs.getString(KEY_APK_PATH, null);
        String existingVersion = prefs.getString(KEY_APK_VERSION, null);
        if (existingPath != null && version.equals(existingVersion)) {
            File existing = new File(existingPath);
            if (existing.exists()) {
                launchInstaller(existing);
                JSObject started = new JSObject();
                started.put("status", "installing");
                notifyListeners("update", started);
                call.resolve();
                return;
            }
        }

        String safeVersion = version.replaceAll("[^A-Za-z0-9._-]", "_");
        downloadFileName = "fluenta-" + safeVersion + ".apk";
        downloadVersion = version;

        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("This device has no download manager.");
            return;
        }

        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle("Fluenta " + safeVersion);
        request.setDescription("Downloading the update…");
        request.setMimeType("application/vnd.android.package-archive");
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        request.setAllowedOverMetered(true);
        request.setAllowedOverRoaming(false);
        request.setDestinationInExternalFilesDir(
            getContext(),
            Environment.DIRECTORY_DOWNLOADS,
            downloadFileName
        );

        try {
            downloadId = manager.enqueue(request);
        } catch (Exception err) {
            call.reject("Could not start the download: " + err.getMessage());
            return;
        }

        registerDownloadReceiver();
        startProgressPolling();
        JSObject started = new JSObject();
        started.put("status", "downloading");
        started.put("progress", 0);
        notifyListeners("update", started);
        call.resolve();
    }

    private boolean isTrustedDownload(String url) {
        try {
            URL parsed = new URL(url);
            if (!"https".equalsIgnoreCase(parsed.getProtocol())) return false;
            String host = parsed.getHost() == null ? "" : parsed.getHost().toLowerCase();
            boolean trustedHost = host.equals("github.com") || host.endsWith(".github.com") || host.endsWith(".githubusercontent.com");
            return trustedHost && parsed.getPath() != null && parsed.getPath().toLowerCase().endsWith(".apk");
        } catch (MalformedURLException err) {
            return false;
        }
    }

    private void registerDownloadReceiver() {
        if (receiver != null) return;
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != downloadId) return;
                stopProgressPolling();
                finishDownload();
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    private void startProgressPolling() {
        stopProgressPolling();
        handler = new Handler(Looper.getMainLooper());
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        progressPoll = new Runnable() {
            @Override
            public void run() {
                if (manager == null || downloadId < 0) return;
                DownloadManager.Query query = new DownloadManager.Query().setFilterById(downloadId);
                try (Cursor cursor = manager.query(query)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        long soFar = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        int progress = total > 0 ? (int) Math.min(100, Math.round((soFar * 100.0) / total)) : 0;
                        JSObject update = new JSObject();
                        update.put("status", "downloading");
                        update.put("progress", progress);
                        notifyListeners("update", update);
                    }
                } catch (Exception ignored) {
                    // A vanished download id simply stops reporting progress.
                }
                if (handler != null && progressPoll != null) handler.postDelayed(progressPoll, 600);
            }
        };
        handler.post(progressPoll);
    }

    private void stopProgressPolling() {
        if (handler != null && progressPoll != null) handler.removeCallbacks(progressPoll);
        progressPoll = null;
        handler = null;
    }

    private void finishDownload() {
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return;
        DownloadManager.Query query = new DownloadManager.Query().setFilterById(downloadId);
        try (Cursor cursor = manager.query(query)) {
            if (cursor == null || !cursor.moveToFirst()) {
                notifyFailure("The download disappeared before it finished.");
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                notifyFailure("The update download failed (reason " + reason + ").");
                return;
            }
        } catch (Exception err) {
            notifyFailure("Could not read the downloaded update.");
            return;
        }

        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        File file = dir == null || downloadFileName == null ? null : new File(dir, downloadFileName);
        if (file == null || !file.exists()) {
            notifyFailure("The downloaded APK is missing.");
            return;
        }

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs
            .edit()
            .putString(KEY_APK_PATH, file.getAbsolutePath())
            .putString(KEY_APK_VERSION, downloadVersion)
            .apply();

        launchInstaller(file);
    }

    private void launchInstaller(File file) {
        try {
            if (Build.VERSION.SDK_INT >= 26 && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
                JSObject event = new JSObject();
                event.put("status", "failed");
                event.put("message", "Allow Fluenta to install unknown apps, then tap Install again.");
                notifyListeners("update", event);
                return;
            }

            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                file
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject event = new JSObject();
            event.put("status", "installing");
            notifyListeners("update", event);
        } catch (Exception err) {
            notifyFailure("Could not open the package installer: " + err.getMessage());
        }
    }

    private void notifyFailure(String message) {
        JSObject event = new JSObject();
        event.put("status", "failed");
        event.put("message", message);
        notifyListeners("update", event);
    }

    @Override
    protected void handleOnDestroy() {
        stopProgressPolling();
        if (receiver != null) {
            try {
                getContext().unregisterReceiver(receiver);
            } catch (Exception ignored) {
                // Already unregistered.
            }
            receiver = null;
        }
        super.handleOnDestroy();
    }

    // ---- shared server probing ------------------------------------------------

    static String normalizeServerUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty() || value.matches(".*\\s.*")) return null;
        if (!value.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*")) value = "https://" + value;
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        try {
            URL parsed = new URL(value);
            String protocol = parsed.getProtocol().toLowerCase();
            if (!protocol.equals("http") && !protocol.equals("https")) return null;
            String host = parsed.getHost();
            if (host == null || host.isEmpty()) return null;
            return value;
        } catch (MalformedURLException err) {
            return null;
        }
    }

    /**
     * Calls /api/health and verifies the answer really comes from a Fluenta
     * server. Runs on a background thread.
     */
    static JSONObject probeServerUrl(String raw) {
        JSONObject out = new JSONObject();
        String normalized = normalizeServerUrl(raw);
        try {
            out.put("url", normalized == null ? "" : normalized);
        } catch (Exception ignored) {
            // Normalised URLs are plain strings.
        }
        if (normalized == null) {
            putError(out, "Enter an address like https://chat.example.com");
            return out;
        }

        HttpURLConnection connection = null;
        try {
            URL url = new URL(normalized + "/api/health");
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "Fluenta-Android");

            int code = connection.getResponseCode();
            if (code != 200) {
                putError(out, "That server answered HTTP " + code + ". Is Fluenta running there?");
                return out;
            }

            StringBuilder body = new StringBuilder();
            try (
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)
                )
            ) {
                char[] buffer = new char[2048];
                int read;
                while ((read = reader.read(buffer)) != -1 && body.length() < 65536) {
                    body.append(buffer, 0, read);
                }
            }

            JSONObject health = new JSONObject(body.toString());
            if (!health.optBoolean("ok") || !"Fluenta".equalsIgnoreCase(health.optString("name"))) {
                putError(out, "That address is online but it is not a Fluenta server.");
                return out;
            }
            out.put("ok", true);
            out.put("name", health.optString("name", "Fluenta"));
            out.put("version", health.optString("version", ""));
            out.put("users", health.optInt("users", 0));
            return out;
        } catch (Exception err) {
            putError(
                out,
                "Could not reach " + normalized + ". Check the address, the server and your connection."
            );
        } finally {
            if (connection != null) connection.disconnect();
        }
        return out;
    }

    private static void putError(JSONObject out, String message) {
        try {
            out.put("ok", false);
            out.put("error", message);
        } catch (Exception ignored) {
            // JSONObject only rejects non-finite numbers.
        }
    }
}
