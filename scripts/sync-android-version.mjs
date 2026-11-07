// Keeps Android's versionName/versionCode in step with the release.
//
//   node scripts/sync-android-version.mjs            # uses package.json
//   FLUENTA_VERSION=v1.2.3 node scripts/sync-android-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const raw = (process.env.FLUENTA_VERSION || pkg.version || '1.0.0').trim();
const clean = raw.replace(/^v/i, '').split(/[-+]/)[0];
const parts = clean.split('.').map((value) => Number.parseInt(value, 10) || 0);
while (parts.length < 3) parts.push(0);
const [major, minor, patch] = parts;
const versionCode = major * 10_000 + minor * 100 + patch;

if (versionCode > 2_100_000_000) {
  console.error(`Version code ${versionCode} overflows Android's limit.`);
  process.exit(1);
}

writeFileSync(
  'apps/android/android/version.properties',
  `versionName=${clean}\nversionCode=${versionCode}\n`,
);
console.log(`Android version set to ${clean} (${versionCode}).`);
