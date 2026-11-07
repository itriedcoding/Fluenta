package app.fluenta.mobile;

import android.webkit.JavascriptInterface;
import org.json.JSONObject;

/**
 * Exposed to the bundled connection screen as `window.FluentaSetup`. Only ever
 * attached to pages served from inside the APK (see MainActivity).
 *
 * Methods run on the WebView's JavaBridge thread, so blocking network calls are
 * safe here and do not stall the UI.
 */
public class SetupBridge {

    private final MainActivity activity;

    SetupBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String info() {
        JSONObject out = new JSONObject();
        try {
            android.content.pm.PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
            out.put("versionName", info.versionName == null ? "" : info.versionName);
            out.put("versionCode", android.os.Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode);
        } catch (Exception ignored) {
            // Version information is cosmetic; an empty object is a valid answer.
        }
        return out.toString();
    }

    /** Validates a candidate server by calling its /api/health endpoint. */
    @JavascriptInterface
    public String probe(String rawUrl) {
        return FluentaNativePlugin.probeServerUrl(rawUrl).toString();
    }

    /** Persists an already validated server address and reloads into it. */
    @JavascriptInterface
    public String connect(String rawUrl) {
        JSONObject out = new JSONObject();
        String normalized = FluentaNativePlugin.normalizeServerUrl(rawUrl);
        if (normalized == null) {
            try {
                out.put("ok", false);
                out.put("error", "That is not a valid http or https address.");
            } catch (Exception ignored) {
                // JSONObject.put only throws for non-finite numbers.
            }
            return out.toString();
        }
        MainActivity.saveServer(activity, normalized);
        try {
            out.put("ok", true);
            out.put("url", normalized);
        } catch (Exception ignored) {
            // Ignored for the same reason as above.
        }
        activity.runOnUiThread(activity::recreate);
        return out.toString();
    }

    @JavascriptInterface
    public void reset() {
        MainActivity.clearServer(activity);
        activity.runOnUiThread(activity::recreate);
    }
}
