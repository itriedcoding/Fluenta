import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android app is a native shell around the same web client the server
 * serves. The server address is chosen inside the app on first launch (and can
 * be changed later in Settings); it is not baked in at build time, so a single
 * APK works for every self-hosted Fluenta instance.
 *
 * `www/` holds the connection screen (and the load-error screen) served from
 * the local WebView origin. As soon as a server is saved, the bridge loads that
 * origin instead and the real app takes over.
 */
const config: CapacitorConfig = {
  appId: 'app.fluenta.mobile',
  appName: 'Fluenta',
  webDir: 'www',
  backgroundColor: '#08080a',
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
