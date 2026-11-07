# Fluenta

A lightweight, modern alternative to Discord: real-time communities, direct messages, voice,
video and screen sharing in one fast app for **web, Windows/desktop and Android**.

Fluenta is one Node server with an embedded SQLite database and one React client. Every platform
talks to that same backend, so accounts, communities, conversations, roles and settings are the
same everywhere — there is no sync layer to fall out of date.

```
apps/server   Hono + node:sqlite + ws        REST, WebSocket hub, WebRTC signalling, Web Push
apps/web      React 19 + Vite                The app. Served by the server in production
apps/desktop  Electron shell                 Thin native window around your deployment
apps/android  Capacitor shell                Native Android app around the same client
```

---

## Quick start

```bash
npm install
npm run dev            # API on :8787, Vite on :5173 with a proxy
```

Then open <http://localhost:5173>, create an account, and you are in. The first community you
create gets `#general` and a `Lounge` voice channel.

Production, single process:

```bash
npm ci
npm run build:web      # builds the client into apps/server/public
npm start              # http://localhost:8787 (server + client + WebSocket)
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

**Notifications** — Web Push (VAPID keys generated and persisted on first boot) for browsers,
installed PWAs and Android Chrome; local OS notifications while a desktop window is in the
background.

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

## Desktop app (Electron)

```bash
npm run desktop:install    # installs Electron in apps/desktop
npm run desktop:start      # opens the shell
npm run desktop:dist       # builds installers into apps/desktop/dist
```

On first launch the shell asks for your server address and remembers it. It is a real native
window (own menu, external links open in the browser, window bounds persisted) — not a wrapped
localhost dev server. Point it at `https://chat.example.com`, or at `http://localhost:8787` when
self-hosting. Builds for Windows, macOS and Linux are produced by the release workflow.

## Android app

The APK is a thin native shell that connects to **any** Fluenta server. On first launch it asks for
the server address, verifies it with `GET /api/health`, then loads that server's client in the
WebView. Settings → App updates → Server switches servers later. Nothing is hard-coded, so one APK
works for every deployment, including a LAN address such as `http://192.168.1.10:8787`.

```bash
npm run android:install      # Capacitor shell dependencies
npm run android:sync         # copy www/ + capacitor config into the Gradle project
npm run android:version      # sync versionName/versionCode from package.json
cd apps/android/android && ./gradlew assembleDebug      # or assembleRelease
```

`npm run android:build` does the web build, version sync and a signed release APK in one step.
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

**Push on Android:** browsers and installed PWAs get real Web Push (including on Android Chrome).
A Capacitor WebView cannot receive Web Push — a store build needs FCM wired through
`@capacitor/push-notifications` and `google-services.json`. The PWA path is the supported one.

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
Browser / Desktop / Android
   │  fetch /api/*            (REST, JSON, cookie session)
   │  WebSocket /ws           (messages, typing, presence, read, voice signalling)
   ▼
Hono server ── ws hub ── SQLite (WAL + FTS5) ── uploads/ ── Web Push
                                │
                                └── outbox/ (mail fallback)
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
- `fluenta-web-*.zip` — static client bundle
- Windows `.exe` (NSIS installer + portable), macOS `.dmg`, Linux `.AppImage` and `.deb`

```bash
git tag v1.0.0
git push origin v1.0.0
```

Or, without creating a tag locally, push a release branch whose name is the version:

```bash
git push origin HEAD:release/v1.0.0
```

Either path builds the web bundle and the signed APK, verifies it with `apksigner`, and attaches
`fluenta-android.apk` to a GitHub Release tagged `v1.0.0` — exactly what the in-app updater reads.
The APK and web bundle are required assets; desktop installers are attached when their builds
succeed, so a platform packaging failure cannot keep the Android release offline. Running the
**Release** workflow manually from the Actions tab builds and verifies the APK as a workflow
artifact without publishing a release.

Locally, `npm run bundle` produces the two web bundles in `release/`, and
`npm run android:build` produces the signed APK at
`apps/android/android/app/build/outputs/apk/release/app-release.apk`.

---

## License

MIT.
