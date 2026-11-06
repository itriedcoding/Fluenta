#!/usr/bin/env bash
# Builds the downloadable web bundles that ship with a release.
# Desktop installers and the Android APK are built by .github/workflows/release.yml
# on runners that have the native toolchains.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT="release"
rm -rf "$OUT"
mkdir -p "$OUT/fluenta-web"

node scripts/generate-icons.mjs
npm run build:web

# 1. Static client, ready to drop behind any reverse proxy that forwards /api and /ws.
cp -r apps/server/public/. "$OUT/fluenta-web/"

# 2. Self-host bundle: server + client + docs, without data, deps or build junk.
mkdir -p "$OUT/fluenta-selfhost-$VERSION"
tar -c \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='apps/server/data' \
  --exclude='apps/desktop/dist' \
  --exclude='apps/android/android' \
  --exclude='apps/android/node_modules' \
  --exclude='apps/desktop/node_modules' \
  --exclude='release' \
  --exclude='artifacts' \
  . | tar -x -C "$OUT/fluenta-selfhost-$VERSION"

if command -v zip >/dev/null 2>&1; then
  (cd "$OUT" && zip -qr "fluenta-web-$VERSION.zip" fluenta-web)
  (cd "$OUT" && zip -qr "fluenta-selfhost-$VERSION.zip" "fluenta-selfhost-$VERSION")
else
  (cd "$OUT" && tar -czf "fluenta-web-$VERSION.tar.gz" fluenta-web)
  (cd "$OUT" && tar -czf "fluenta-selfhost-$VERSION.tar.gz" "fluenta-selfhost-$VERSION")
fi

rm -rf "$OUT/fluenta-web" "$OUT/fluenta-selfhost-$VERSION"
echo "Release bundles:"
ls -lh "$OUT"
