import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android app is a native shell around the same web client that the server
 * serves, so accounts, conversations and settings are identical everywhere.
 *
 * Point it at your deployment before building:
 *   FLUENTA_SERVER_URL=https://chat.example.com npm run build:debug
 *
 * The emulator default (http://10.0.2.2:8787) reaches a server running on the
 * developer machine. Cleartext is only allowed for that loopback alias.
 */
const serverUrl = process.env.FLUENTA_SERVER_URL || 'http://10.0.2.2:8787';
const isLoopback = /^http:\/\/(10\.0\.2\.2|localhost|127\.0\.0\.1)(:\d+)?$/.test(serverUrl);

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
    url: serverUrl,
    cleartext: isLoopback,
    androidScheme: 'https',
  },
};

export default config;
