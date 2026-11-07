import { build } from 'vite';
import path from 'node:path';

// The Android APK ships the full client, not a connection screen.
//
// By default it runs against the on-device database. Setting FLUENTA_SERVER_URL
// (for example https://chat.example.com) bakes a real backend into the APK
// instead: sign-up, sign-in and every message then live on that server and work
// across devices. The URL is read at build time so users never type a server
// address.
const serverUrl = (process.env.FLUENTA_SERVER_URL || '').trim().replace(/\/+$/, '');
if (serverUrl) {
  process.env.VITE_FLUENTA_SERVER = serverUrl;
  console.log(`Android build targets the backend at ${serverUrl}`);
}

const root = process.cwd();
await build({
  configFile: path.join(root, 'apps/web/vite.config.ts'),
  define: serverUrl ? { 'import.meta.env.VITE_FLUENTA_SERVER': JSON.stringify(serverUrl) } : {},
  build: {
    outDir: path.join(root, 'apps/android/www'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: false,
  },
});
console.log('Android web assets written to apps/android/www');
