# Fluenta

A lightweight, modern alternative to Discord: real-time communities, direct messages, voice,
video and screen sharing in one fast **Android** app.

Fluenta ships as a single signed APK. The whole client is bundled into the app, so it installs and
opens straight into sign-up with nothing else to host, and there is no separate website build to
keep in sync. Optionally point it at a self-hosted Fluenta server to share accounts and messages
between phones.

```
apps/server   Hono + node:sqlite + ws        Optional self-hosted backend (REST + WebSocket hub)
apps/web      React 19 + Vite                The client UI, compiled into the APK
apps/android  Capacitor shell                The Android app — the only shipped build
```

---

## Quick start

```bash
npm install
npm run dev            # client on :5173 talking to the API on :8787
```

`npm run dev` only exists for working on the client UI; the product is the APK:

```bash
npm run android:build  # signed release APK in apps/android/android/app/build/outputs/apk/release
```

The optional backend is the same Node process either way:

```bash
npm ci && npm start    # REST + WebSocket on :8787, data in apps/server/data
```

Node **24+** is recommended (Node 22.6+ works; it runs the TypeScript sources directly, no build
step for the server).

Docker:

```bash
APP_ORIGIN=http://localhost:8787 docker compose up -d --build
```

The database, uploads and the mail outbox live in the `fluenta-data` volume.

---

## Configuration

Everything is read from the environment at boot. See [.env.example](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `APP_ORIGIN` | derived from request | Canonical origin for OAuth redirects, invite links, reset links |
| `FLUENTA_DATA_DIR` | `apps/server/data` | SQLite file, `uploads/`, `outbox/` |
| `FLUENTA_MAX_UPLOAD_MB` | `25` | Upload ceiling |
| `FLUENTA_REGISTRATION_OPEN` | `true` | Set `false` to close signup |
| `FLUENTA_TRUST_PROXY` | `true` | Use `X-Forwarded-For` for client IPs (rate limits) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Enables Google sign-in |
| `SMTP_URL` or `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` | — | Enables password-reset email |

**Google sign-in** is real OAuth 2.0, not a demo. Add
`${APP_ORIGIN}/api/auth/google/callback` as an authorised redirect URI in Google Cloud Console,
set the two variables, restart. Until then the button is hidden and the server reports
`google: false` from `/api/health`.

**Password reset** uses SMTP when configured. Without SMTP the reset link is written to
`data/outbox/*.eml` and the API says so — that is the documented self-host path, not a silent
failure.

---

## What is implemented**Accounts** — email + password (scrypt, per-user salt), Google OAuth, 30-day sessions with hashed tokens in `HttpOnly` cookies (bearer tokens also accepted for native shells), password recovery, session revocation, profile editing, avatar upload, custom status, presence.

**Badges** — a real, server-side badge system with custom vector art. `Founder` and `Early member` are derived from the database; `Verified`, `Developer`, `Bug hunter`, `Helper`, `Builder` and `Community legend` are granted by the server founder from any profile card, or from the shell with `npm run badges -- grant @alex developer`. Badges appear on member lists, profile cards and Settings → Badges, and update live over the WebSocket.

**Messaging** — real-time DMs and group chats, community channels, edit, delete, replies,
reactions, typing indicators, read receipts, unread badges, file and image attachments with
magic-byte sniffing, message grouping, day dividers, jump-to-message, full-text search over
messages (SQLite FTS5), plus user, channel and community search.

**Communities** — create, join by invite code, channels (text + voice), drag-free ordering,
roles with granular permission bits, per-channel permission overrides, member management,
ownership transfer guards, invites with expiry and usage limits.

**Voice, video, screen share** — WebRTC mesh with pre-negotiated transceivers (so joining a call
never renegotiates the whole room), device picker, mute/deafen, camera, screen share with a
separate track, speaking indicators, and server-side room state so late joiners see who is in.

**Notifications** — unread counts and read state stay in sync inside the app; the APK has no push
service to configure.

**Search** — one palette (⌘K / Ctrl+K) for messages, people, channels and communities.

**Design** — black/white/dark-red, dark and light themes, dense layout, responsive down to
360 px, reduced-motion support, no animation libraries.

---

## Security notes

- Passwords hashed with scrypt (N=16384) and a per-user salt; timing-safe comparison.
- Session tokens are random 32-byte values, stored only as SHA-256 hashes.
- State-changing requests require a same-origin `Origin`/`Referer` check (CSRF), and cookies are
  `HttpOnly`, `SameSite=Lax`, `Secure` when served over HTTPS.
- Every route validates input with zod; authorization is checked per channel and per community
  role, including channel-level overrides.
- Rate limits per IP and per account for login, signup, password reset, uploads and messages;
  WebSocket connections are capped per user.
- Uploads are sniffed by content, size-capped, stored outside the client bundle and served with
  `Content-Disposition` and `nosniff`.
- CSP, `X-Frame-Options` (preview-safe), `Referrer-Policy` and HSTS are set by the server.
- Run behind TLS (Caddy, nginx, Cloudflare Tunnel) in production; `APP_ORIGIN` should be https.

---

## Android app

The APK is **self-contained**: there is no server to run and no address to enter. The whole client
ships inside the APK and runs against an on-device database
(`apps/web/src/lib/localBackend.ts`), so the app opens straight into sign-up/sign-in. Accounts,
communities, channels, direct messages, uploads, roles, badges and the voice room all work on the
phone with nothing installed anywhere else, including offline.

What that means in practice:

- **Sign up or sign in** with an email and password stored as a PBKDF2-SHA-256 hash on the device.
- **Create spaces**, text and voice channels, DMs and groups, and change every profile and account
  setting — including password changes and a device-local password reset.
- **Everything persists** in the app's private storage (IndexedDB inside the WebView) across
  restarts and app updates.
- Data is **per device**: accounts and messages do not sync to other phones, because there is no
  server to sync through. Two people on one phone can each keep their own account.
- **Voice rooms** open the microphone, support mute/deafen, camera and screen share UI, but with a
  single account on the device there is nobody else in the room to hear you. Real multi-user voice
  needs the app built against a shared server (see below).

```bash
npm run android:install      # Capacitor shell dependencies
npm run build:android-web    # build the client into apps/android/www
npm run android:sync         # copy www/ + capacitor config into the Gradle project
npm run android:version      # sync versionName/versionCode from package.json
cd apps/android/android && ./gradlew assembleDebug      # or assembleRelease
```

`npm run android:build` does the client build, version sync and a signed release APK in one step.
The launcher icon, adaptive foreground and every splash screen are generated from the same custom
mark by `npm run icons`.

### In-app updates

Settings → App updates talks to this repository's GitHub releases. It asks
`https://api.github.com/repos/itriedcoding/Fluenta/releases/latest` (at most once every six hours,
or on demand), compares the tag with the installed APK version, and — when newer — downloads the
`fluenta-android.apk` asset through Android's `DownloadManager`, showing real progress, then opens
the package installer via a `FileProvider` URI. Automatic checks can be switched off per device.

Signing matters here: Android will only install an update signed with the same key. The repository
ships a **public development keystore** (`apps/android/keystore/fluenta-release.jks`, alias
`fluenta`, password `fluentamobile`) so releases are updatable out of the box. For a broadly
distributed release, replace it with your own private key and set these repository secrets:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`. Rotating the key later means installed users must reinstall manually.

**Notifications on Android:** there is no website or PWA build, so no Web Push. The app shows
in-app notifications while it runs, and message history is already on the device when you reopen
it.

### Install prompts

The APK is distributed from GitHub, not the Play Store, so Android itself shows one prompt the app
cannot remove: the first update install asks you to allow Fluenta to install unknown apps. The app
handles that for real — it opens the exact system screen for its own package, then continues the
install once you come back — and it verifies every download is an https APK served by GitHub before
handing it to the installer. The manifest requests only the permissions the app uses (internet,
network state, microphone, camera, audio settings) plus that install permission, and the release
build refuses cleartext traffic outside emulator loopback addresses.

---

## Testing

```bash
npm test           # end-to-end API + WebSocket suites (7 suites)
npm run typecheck  # server + client
npm run verify     # typecheck, tests, production build
```

The suites boot a real server against a temporary database and cover: signup/login/reset,
communities/invites/roles, messaging/edit/react/read receipts/FTS search, DMs and unread counts,
uploads and content sniffing, WebRTC signalling relay, and authorization boundaries (CSRF,
cross-community access, rate limits).

---

## Architecture

```
Android APK — client bundled inside
   │
   ├── default: fetch + WebSocket intercepted
   ▼
on-device backend ── IndexedDB
   (accounts, spaces, messages, uploads, search, badges, voice)

Android APK built with FLUENTA_SERVER_URL
   │  fetch /api/*  +  WebSocket /ws  (bearer session token)
   ▼
Hono server ── ws hub ── SQLite ── uploads/
```

Messages are written to SQLite first, then fanned out to the exact audience that is allowed to
see them (server members and conversation participants), so a client never trusts a broadcast it
was not entitled to. Read state is per-user and monotonic. Uploads are referenced by id, so
deleting a message never orphans a file that another message uses.

Scaling: this is a single-node design on purpose — SQLite in WAL mode handles a community-sized
load with a few megabytes of RAM. Beyond that, move `data/` to a fast disk and run behind a
reverse proxy; a multi-node future would replace the in-process hub with a shared bus.

---

## Releases

`.github/workflows/release.yml` builds on every `v*` tag and publishes a **GitHub Release** with:

- `fluenta-android.apk` — the signed Android build (release-signed, verified with `apksigner` in CI)

```bash
git tag v1.0.0
git push origin v1.0.0
```

Or, without creating a tag locally, push a release branch whose name is the version:

```bash
git push origin HEAD:release/v1.0.0
```

Either path builds the signed APK, verifies it with `apksigner`, and attaches `fluenta-android.apk`
to a GitHub Release tagged `v1.0.0` — exactly what the in-app updater reads. The APK is the only
release asset. Running the **Release** workflow manually from the Actions tab builds and verifies
the APK as a workflow artifact without publishing a release.

Locally, `npm run android:build` produces the signed APK at
`apps/android/android/app/build/outputs/apk/release/app-release.apk`.

---

## License

MIT.

## Pointing the Android app at a real backend

The APK bundles the client. With no backend configured it keeps accounts and
messages on the device. To run it against this repository's server instead,
build the bundle with `FLUENTA_SERVER_URL`:

```bash
FLUENTA_SERVER_URL=https://chat.example.com npm run android:build
```

That bakes the address into the APK (users never type a server address), routes
every API call, upload and realtime socket to that server, and authenticates with
a bearer session token instead of cookies, so cross-origin requests from the
WebView work. The on-device database is not installed in this mode.

Deploy the server with the bundled Dockerfile:

```bash
docker build -t fluenta .
docker run -d --name fluenta -p 8787:8787 \
  -e APP_ORIGIN=https://chat.example.com \
  -e FLUENTA_DATA_DIR=/data \
  -v fluenta-data:/data \
  fluenta
```

`APP_ORIGIN` must be the public https origin (it is used for cookies and reset
links). Data lives in SQLite under `FLUENTA_DATA_DIR`, so mount a volume.

For releases, set the repository **variable** `FLUENTA_SERVER_URL`; the Android
job in `.github/workflows/release.yml` passes it to the bundle build, so every
APK you publish talks to that backend automatically.
