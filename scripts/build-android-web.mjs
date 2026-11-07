import { build } from 'vite';
import path from 'node:path';

// The Android APK ships the full client, not a connection screen. Building it
// into apps/android/www lets `npx cap sync android` copy the same SPA the web
// build produces into the WebView assets.
const root = process.cwd();
await build({
  configFile: path.join(root, 'apps/web/vite.config.ts'),
  build: {
    outDir: path.join(root, 'apps/android/www'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: false,
  },
});
console.log('Android web assets written to apps/android/www');
