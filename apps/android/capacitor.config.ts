import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android app is self-contained: the whole web client is bundled in the APK
 * under `www/` and runs against the on-device database installed by
 * `apps/web/src/lib/localBackend.ts`. There is no server address to enter, so the
 * app opens straight into sign-up/sign-in and every account, community, channel
 * and message lives in the app's private storage.
 *
 * `npm run build:android-web` populates `www/` before `cap sync android`.
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
