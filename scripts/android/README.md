# Android build

The Android app is the same Tauri 2 project as the desktop app, built with
`src-tauri/tauri.android.conf.json` merged on top (no bundled resources, no node sidecar, no
updater artifacts). CI builds a debug APK in `.github/workflows/android-build.yml`; that workflow
only uploads a 7-day workflow artifact and never creates a release or `latest.json`.

> **A debug APK built without `VITE_CLOUD_API_URL` talks to the PRODUCTION cloud.**
> The frontend is always a production Vite build inside the APK, and with no cloud URL set the
> app falls back to its built-in production URL. Set `VITE_CLOUD_API_URL` (locally) or the
> `cloud_api_url` input (CI "Run workflow") to point a test build elsewhere.

## Build locally on Windows

1. Install Android Studio. In *SDK Manager* install: an Android SDK Platform (36),
   *SDK Platform-Tools*, *SDK Build-Tools*, *NDK (Side by side)* (CI pins 27.2.12479018) and
   *Android SDK Command-line Tools*.
2. JDK 17: use Android Studio's bundled JBR or install Temurin 17.
3. Rust targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
4. Environment variables (PowerShell, then open a new terminal):
   ```powershell
   [Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Android\Android Studio\jbr", "User")
   [Environment]::SetEnvironmentVariable("ANDROID_HOME", "$env:LocalAppData\Android\Sdk", "User")
   $ndk = Get-ChildItem "$env:LocalAppData\Android\Sdk\ndk" | Select-Object -Last 1
   [Environment]::SetEnvironmentVariable("NDK_HOME", $ndk.FullName, "User")
   ```
5. From the repo root, after `npm --prefix frontend ci`:
   ```powershell
   npm run build:android   # debug APK, arm64
   npm run app:android     # dev mode on a USB-connected phone (USB debugging on)
   ```
   Both run `tauri android init --ci` the first time (it creates `src-tauri/gen/android`, which
   is generated and not committed) and then `patch-android-project.mjs`, which turns off Android
   backup and device-to-device transfer so the phone's SQLite and device identity never get
   restored onto another phone. `build:android` also blocks cleartext HTTP; `app:android` allows it
   in the debug build only, for the Vite dev server's live reload.

The APK lands in
`src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk`.

## Sideload onto a phone

- From CI: open the workflow run, download the `FroozERP-Android-debug-<sha>` artifact, unzip.
  Check the APK against `SHA256SUMS.txt`.
- With USB debugging on: `adb install -r FroozERP-<sha>-app-universal-debug.apk`.
- Or copy the APK to the phone and open it; allow "Install unknown apps" for the file manager.
- Debug APKs are signed with a throwaway debug key, and every CI run uses a different one, so
  installing a build from another machine or run over an existing one fails with a signature
  mismatch. Uninstall first; that deletes the phone's local data (backup is off by design).
- Use a test phone. Do not put a debug build on a counter device.
