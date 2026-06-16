# Branding Assets

Official master branding source:

```text
branding/source/frooz-official-logo.png
```

The original master source must remain unchanged. The uploaded source also exists as:

```text
branding/source/frooz-official-logo.png.png
```

## Generated Assets

Production generated assets:

```text
branding/generated/frooz-official-logo-master-copy.png
branding/generated/frooz-logo-full-2048.png
branding/generated/frooz-logo-full-1024.png
branding/generated/frooz-logo-full-512.png
branding/generated/frooz-symbol-1024.png
branding/generated/frooz-symbol-512.png
```

Web-visible assets:

```text
frontend/public/branding/frooz-official-logo.png
frontend/public/branding/frooz-logo-full-1024.png
frontend/public/branding/frooz-logo-full-512.png
frontend/public/branding/frooz-logo-invoice-320.png
frontend/public/branding/frooz-symbol-512.png
frontend/public/branding/frooz-symbol-192.png
frontend/public/branding/frooz-symbol-64.png
```

Tauri/Windows icon assets:

```text
src-tauri/icons/32x32.png
src-tauri/icons/128x128.png
src-tauri/icons/128x128@2x.png
src-tauri/icons/icon.png
src-tauri/icons/icon.ico
```

Future platform source assets only:

```text
branding/generated/future-android/adaptive-icon-foreground-432.png
branding/generated/future-android/adaptive-icon-monochrome-432.png
branding/generated/future-android/play-store-icon-source-512.png
branding/generated/future-ios/ios-app-icon-source-1024.png
branding/generated/future-ios/ios-mark-source-1024.png
```

Android and iOS builds are not part of Phase 3.

## Usage

- Full official logo: login, splash/preparation screen, about panel, invoice/report headings and large brand areas.
- Compact official symbol: sidebar, header, dashboard, favicon, PWA icons, Windows application icon and small UI locations.
- Invoice/report logo: `frontend/public/branding/frooz-logo-invoice-320.png`.
- Browser favicon: `frontend/public/branding/frooz-symbol-64.png`.
- PWA manifest icons: `frooz-symbol-192.png` and `frooz-symbol-512.png`.

## Transparent Background Note

Transparent-background variants were not generated because the source logo uses a white `F` shape inside the fruit symbol. Automated white background removal would likely damage the official mark. Large branding areas should use the white-background official logo. A professionally prepared transparent master is recommended for future high-polish release work.

## Rules

- Do not redesign the logo.
- Do not alter wording, colours or proportions.
- Preserve the source file.
- Preserve aspect ratio.
- Do not crop tagline text in large logo placements.
- Do not use tiny tagline text inside small icons.
- Keep print/report backgrounds white with solid black report text.
