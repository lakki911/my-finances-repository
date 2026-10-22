# My Finances: developer handoff

This file is the complete context for anyone (a person or an AI assistant) continuing development. Read it first.

## 1. What the app is

A personal finance tracker for one person. It runs on PC (in a browser or as an installed PWA) and on Android (as an APK). It tracks:

- **Salary**, entered each month (the app offers to repeat last month's amount)
- **Other income**, under user-defined categories
- **Spending**, under user-defined categories
- **Investments**: holdings, with dated contributions and a manually updated current value

The **Overview** shows the month's leftover amount and savings rate, a spent/invested/kept bar, a spending donut by category, a 6-month income vs. spending chart, and portfolio gain/loss.

The owner is not a developer. Keep instructions to them simple and click-by-click.

## 2. Live locations

| What | Where |
|---|---|
| Source code | https://github.com/lakki911/my-finances-repository (public, branch `main`) |
| Website (PC) | https://lakki911.github.io/my-finances-repository/ (GitHub Pages, deployed from `main`, folder `/`) |
| Android APK | https://github.com/lakki911/my-finances-repository/releases/latest/download/my-finances.apk |
| Google Cloud project | "My Finances" at console.cloud.google.com, owned by the user's Google account |

## 3. Tech stack and decisions

- **Plain HTML, CSS and JavaScript ES modules.** No framework and no bundler, so the repo root *is* the website. Only `android-app/` uses npm.
- **Local-first storage** in the browser's IndexedDB. This was the user's choice ("device first, sync later").
- **PWA**: `manifest.webmanifest` and `sw.js` make it installable and usable offline.
- **Android** wraps the same web files with **Capacitor 8**, built in GitHub Actions. Nobody needs Android Studio.
- **Sync** goes through the user's own **Google Drive** (free, private), using the hidden `appDataFolder`.
- **Look**: two skins, *Fresh* (light, emerald) and *Vault* (dark, gold), chosen per device in Settings. The font (Manrope) is bundled in `fonts/` so it works offline.
- Default currency is **INR**, with others selectable.

## 4. Files

| File | Purpose |
|---|---|
| `index.html` | App shell: top bar with month picker, `<main id="view">`, floating + button, bottom tab bar, `<dialog>` for forms, toast. |
| `app.js` | All UI: state, views (`dashboard`, `income`, `spending`, `investments`, `settings`), dialogs, event delegation via `data-action` attributes, skins, and the sync triggers. |
| `db.js` | IndexedDB layer: `all`, `put`, `remove` (soft delete), `exportAll`, `importAll` (merge), `wipe`. |
| `sync.js` | Google Drive sync: tokens (web vs. native), Drive REST calls, merging, duplicate-category cleanup. |
| `config.js` | `GOOGLE_CLIENT_ID`, the Web OAuth client ID. This is public by design. Leave it empty to hide sync. |
| `styles.css` | All styling. The skins are token sets under `[data-skin="fresh"]` and `[data-skin="vault"]`. Category colors are `--c0` to `--c7`. |
| `sw.js` | Service worker that caches the app shell. **Bump `VERSION` whenever files change**, and add any new file to `SHELL`. |
| `manifest.webmanifest`, `icons/` | PWA metadata and icons. |
| `fonts/manrope.woff2` | Bundled font (OFL license alongside it). |
| `android-app/` | Capacitor project: `package.json`, `capacitor.config.json`, `MainActivity.java` (required by the sign-in plugin), `release.keystore`, and `assets/` for icon and splash sources. The generated `android/` folder and `www/` are not committed; CI creates them. |
| `.github/workflows/android.yml` | Builds and signs the APK and publishes a GitHub release on every push to `main`. |
| `docs/USER-GUIDE.md` | Plain-language guide for the owner. |

## 5. Data model

There are four IndexedDB object stores (database `finance-app`, version 1), all keyed by `id`. **Every record has `id`, `updatedAt` (ISO string) and `deleted` (boolean).** Deletes are soft (tombstones), so sync can carry them across devices. `db.all()` hides deleted records.

```js
// entries
{ id, type: 'salary' | 'income' | 'expense', amount: Number, categoryId: String | null /* null for salary */,
  date: 'YYYY-MM-DD', note: String, updatedAt, deleted }

// categories
{ id, kind: 'income' | 'expense' | 'investment', name, updatedAt, deleted }

// investments (contributions are embedded)
{ id, name, categoryId, currentValue: Number | null /* null = use amount invested */,
  contributions: [{ id, date: 'YYYY-MM-DD', amount }], note, updatedAt, deleted }

// settings (single record)
{ id: 'prefs', currency: 'INR', updatedAt, deleted }
```

- On first run, default categories and prefs are seeded with `updatedAt = 1970-01-01` (`db.put(..., { seed: true })`), so data that arrives by sync always wins over the defaults.
- "Invested this month" is the sum of contributions dated in that month.
- "Left over" = salary + other income − spending − invested.
- Backup files are JSON: `{ app: 'finance-app', version: 1, exportedAt, entries, investments, categories, settings }`, including tombstones. `importAll` merges records, and the newer `updatedAt` wins for each record.
- Per-device values in `localStorage`: `skin`, `sync.enabled`, `sync.last`, and `sync.token` (web only, 1-hour access token).

## 6. Google Drive sync (`sync.js`)

- **Storage:** one file, `finance-data.json`, in Drive's `appDataFolder`. The scope is `https://www.googleapis.com/auth/drive.appdata`, so the app can only see its own folder.
- **Algorithm (`syncNow`):** get a token, find the file, download it and `db.importAll` (merge), fold duplicate categories (same kind and name) into one and repoint entries to it, then `exportAll` and upload (create the file on first sync, then PATCH the media).
- **Triggers in `app.js`:** 3 seconds after any save or delete (`scheduleSync`), on app start, and when the app becomes visible again. The **Sync now** / **Connect Google Drive** buttons run an interactive sync.
- **Tokens on the web:** Google Identity Services token client (`accounts.google.com/gsi/client`, loaded on demand). The popup needs a user click, so background syncs only run while a saved token is still valid. Otherwise the app shows "Signed out of Google. Tap Sync now".
- **Tokens on Android:** `@capgo/capacitor-social-login` (native Google sign-in) with `webClientId = GOOGLE_CLIENT_ID` and the Drive scope. Custom scopes need the modified `MainActivity.java`, which forwards `onActivityResult` to the plugin. The page must load `capacitor.js` (Capacitor's JS runtime), which CI copies into `www/`. The plugin is created with `capacitorExports.registerPlugin('SocialLogin')`.
- **Tested** against a mocked Drive with two simulated devices: an add on one appears on the other, categories don't duplicate, and deletes propagate.

## 7. Google Cloud setup (already done; for reference)

- Project "My Finances", with the **Google Drive API** enabled.
- **Google Auth Platform** is in **Testing** mode, and the user's Gmail is added as a test user. Publishing would need the Branding page (homepage and privacy policy URLs). In Testing mode, Google may ask the user to sign in again about once a week.
- **OAuth clients:**
  - Web application: `235602194612-3c4b6p48314ihkjatb7sccvojiqp3dsg.apps.googleusercontent.com`, with authorized JavaScript origin `https://lakki911.github.io`. This ID is in `config.js`.
  - Android: package `com.lakki911.myfinances`, SHA-1 `27:AE:D7:25:E2:B1:C9:CD:AF:7D:CF:78:53:27:1F:48:76:56:FF:67`.
- If the site ever moves to another domain, add that origin to the Web client.

## 8. Android build (`.github/workflows/android.yml`)

On every push to `main` (Markdown-only changes are skipped), with one build at a time:

1. `npm install` in `android-app/` (Capacitor 8, `@capacitor/assets`, `@capgo/capacitor-social-login` 8.x).
2. Copy the web files into `android-app/www/`. Drop `sw.js`, add `capacitor.js`, and inject `<script src="capacitor.js">` before `app.js`.
3. `npx cap add android`, copy in `MainActivity.java`, generate icons and splash with `capacitor-assets`, and set `versionCode` to the run number and `versionName` to `1.<run>`.
4. `./gradlew assembleRelease`, then `zipalign` and `apksigner sign` with `android-app/release.keystore`, then `apksigner verify`.
5. Publish a GitHub release `v1.<run>` with the asset `my-finances.apk`, marked as latest.

**Signing key:** `android-app/release.keystore`, alias `myfinances`, store and key password `myfinances-apk`. It is committed on purpose, so every build has the same signature: updates install over the old app without losing data, and Google sign-in keeps working, because it is tied to the SHA-1 above. **Never replace it.** If you do, the Android OAuth client's SHA-1 must change, and users must uninstall first, which loses unsynced data. The key is public because the repo is public. That's acceptable for a sideloaded personal app, but move it to GitHub secrets if that ever matters.

Lessons from the first builds:
- Without the explicit `apksigner` step, the released APK was unsigned, and Android said "package appears to be invalid".
- The sign-in plugin needs AGP 8.9 or newer, which is why the project uses Capacitor 8 rather than 7.
- `window.Capacitor.registerPlugin` doesn't exist unless `capacitor.js` is loaded.

## 9. Working on it

- **Run locally:** `python -m http.server 8000` in the repo root, then open http://localhost:8000. Opening from `file://` won't work because ES modules need http.
- **Release:** commit and push to `main`. Pages redeploys in about 1 minute and the APK in about 5 minutes. Remember to bump `VERSION` in `sw.js`.
- **Code style:** small pure helpers, template-string views, everything escaped with `esc()`, and `data-action` buttons handled in one delegated click listener. Every write goes through `save()` / `drop()` in `app.js`, which also schedules a sync.
- **Adding a store or field:** keep `id`, `updatedAt` and `deleted`, and add new stores to `STORES` in `db.js`. Adding a store requires bumping `DB_VERSION` and handling `onupgradeneeded`.

## 10. Known limits and ideas

- Investment contributions live inside the investment record, so if two devices edit the same holding at the same time, the later save wins.
- Some screens still use `confirm()` / `prompt()` (deleting, new category, wipe). These work in browsers and in the Capacitor WebView, but in-app dialogs would look nicer.
- **Export backup** downloads a file, which works on PC but may not in the Android app. Use Drive sync or the PC to export.
- Ideas: budgets per category with alerts, recurring expenses, search and filters, CSV export, charts per category over time, and a privacy page so the Google app can be published (which removes the weekly re-sign-in).

## 11. History

- **2026-10-21:** v1 built (PWA with IndexedDB). Hosted on GitHub Pages. Android APK pipeline added. Google Drive sync added and Google Cloud configured. Fixed APK signing and Capacitor runtime loading.
- **2026-10-22:** Redesign: hero card, donut chart, category avatars, floating nav, bundled font, and the Fresh/Vault skins with a Look switch. This guide and the user guide were written.
