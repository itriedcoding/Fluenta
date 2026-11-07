package app.fluenta.mobile;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.ArrayList;
import java.util.List;

/**
 * The app is fully self-contained: it loads the bundled web client from the APK
 * and that client talks to the on-device database in the WebView. There is no
 * server to configure.
 *
 * The only native work left here is granting microphone/camera access to the
 * WebView when a voice room asks for it, which needs both the WebView permission
 * and the Android runtime permission.
 */
public class MainActivity extends BridgeActivity {

    public static final String PREFS = "fluenta_app";
    public static final String KEY_SERVER = "server_url";

    private static final int MEDIA_PERMISSIONS_REQUEST = 4102;
    private PermissionRequest pendingPermissionRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(FluentaNativePlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        // Voice rooms connect without an extra tap after joining a channel.
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                handleMediaPermission(request);
            }
        });
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void handleMediaPermission(PermissionRequest request) {
        List<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && !granted(Manifest.permission.RECORD_AUDIO)) {
                needed.add(Manifest.permission.RECORD_AUDIO);
            } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && !granted(Manifest.permission.CAMERA)) {
                needed.add(Manifest.permission.CAMERA);
            }
        }
        if (needed.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        pendingPermissionRequest = request;
        ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), MEDIA_PERMISSIONS_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != MEDIA_PERMISSIONS_REQUEST) return;
        PermissionRequest request = pendingPermissionRequest;
        pendingPermissionRequest = null;
        if (request == null) return;
        boolean allGranted = true;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) allGranted = false;
        }
        if (allGranted) request.grant(request.getResources());
        else request.deny();
    }

    /**
     * Kept so an older installed build that still asks for a server address can
     * clear it; the current build ignores the value and always runs on-device.
     */
    public static String storedServer(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String value = prefs.getString(KEY_SERVER, null);
        if (value == null || value.trim().isEmpty()) return null;
        return value;
    }

    public static void saveServer(Context context, String url) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply();
    }

    public static void clearServer(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_SERVER).apply();
    }

    public static void restart(Context context) {
        if (context instanceof MainActivity) {
            MainActivity activity = (MainActivity) context;
            activity.runOnUiThread(activity::recreate);
        }
    }
}
