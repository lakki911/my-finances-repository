# My Finances: developer handoff

This file is the complete context for anyone (a person or an AI assistant) continuing development. Read it first.

## 1. What the app is

A personal finance tracker for a family. Each person registers with email and password and keeps their own records; admins can see everyone's records and family totals. It runs on PC (in a browser or as an installed PWA) and on Android (as an APK). It tracks:

- **Salary**, entered each month (the app offers to repeat last month's amount)
- **Other income**, under user-defined categories
- **Spending**, under user-defined categories
- **Investments**: holdings, with dated contributions and a manually updated current value

The **Overview** shows the month's leftover amount and savings rate, a spent/invested/kept bar, a spending donut by category, a 6-month income vs. spending chart, and portfolio gain/loss.

The **Family** tab (admins only) shows the family's combined left-over amount, income, spending, invested this month and portfolio value, a row per member, and a read-only view of any member's records.

The owner is not a developer. Keep instructions to them simple and click-by-click.

## 2. Live locations

| What | Where |
|---|---|
| Source code | https://github.com/lakki911/my-finances-repository (public, branch `main`) |
| Website (PC) | https://lakki911.github.io/my-finances-repository/ (GitHub Pages, deployed from `main`, folder `/`) |
| Android APK | https://github.com/lakki911/my-finances-repository/releases/latest/download/my-finances.apk |
| Firebase project | `my-finances-family` at console.firebase.google.com (Spark, no-cost plan, no card) |
| Admins | lakkireddysurender@gmail.com, lakki911@gmail.com |

## 3. Tech stack and decisions

- **Plain HTML, CSS and JavaScript ES modules.** No framework and no bundler, so the repo root *is* the website. Only `android-app/` uses npm.
- **Local-first storage** in the browser's IndexedDB, one database per signed-in person (`finance-app-<uid>`).
- **PWA**: `manifest.webmanifest` and `sw.js` make it installable and usable offline.
- **Android** wraps the same web files with **Capacitor 8**, built in GitHub Actions. Nobody needs Android Studio.
- **Accounts and cloud data** use **Firebase**: Authentication (email/password) and Firestore, both called through their **REST APIs** with plain `fetch`. There's no Firebase SDK, so no bundler is needed and the app still loads offline. This replaced the earlier Google Drive sync on 2026-10-22, because Drive couldn't support an admin who sees everyone's data.
- **Look**: two skins, *Fresh* (light, emerald) and *Vault* (dark, gold), chosen per device in Settings. The font (Manrope) is bundled in `fonts/` so it works offline.
- Default currency is **INR**, with others selectable.

## 4. Files

| File | Purpose |
|---|---|
| `index.html` | App shell: top bar with month picker, `<main id="view">`, floating + button, bottom tab bar, `<dialog>` for forms, toast. |
| `app.js` | All UI: state, views (`dashboard`, `income`, `spending`, `investments`, `settings`), dialogs, event delegation via `data-action` attributes, skins, and the sync triggers. |
| `db.js` | IndexedDB layer: `all`, `put`, `remove` (soft delete), `exportAll`, `importAll` (merge), `wipe`. |
| `auth.js` | Firebase Authentication REST: register (and send a verification email), login, password reset, change password (re-checks the current password, then `accounts:update`), ID-token refresh, `isAdmin()`. The session is kept in `localStorage` under `auth.session`. |
| `cloud.js` | Firestore REST sync (`syncNow`), plus `family()` for admins. |
| `config.js` | `FIREBASE` (`apiKey`, `projectId`; public by design) and `ADMIN_EMAILS` (UI only; the real check is in the rules). |
| `firestore.rules` | Security rules. **The copy that is in force is the one pasted into Firebase console → Firestore → Rules**; keep the two the same. |
| `styles.css` | All styling. The skins are token sets under `[data-skin="fresh"]` and `[data-skin="vault"]`. Category colors are `--c0` to `--c7`. |
| `sw.js` | Service worker that caches the app shell. **Bump `VERSION` whenever files change**, and add any new file to `SHELL`. |
| `manifest.webmanifest`, `icons/` | PWA metadata and icons. |
| `fonts/manrope.woff2` | Bundled font (OFL license alongside it). |
| `android-app/` | Capacitor project: `package.json`, `capacitor.config.json`, `release.keystore`, and `assets/` for icon and splash sources. The generated `android/` folder and `www/` are not committed; CI creates them. |
| `.github/workflows/android.yml` | Builds and signs the APK and publishes a GitHub release on every push to `main`. |
| `docs/USER-GUIDE.md` | Plain-language guide for the owner. |

## 5. Data model

There are four IndexedDB object stores (database `finance-app-<uid>`, version 1; the old single-user database `finance-app` is copied into the first account that signs in on that device, recorded in `localStorage['legacy.migratedTo']`), all keyed by `id`. **Every record has `id`, `updatedAt` (ISO string) and `deleted` (boolean).** Deletes are soft (tombstones), so sync can carry them across devices. `db.all()` hides deleted records.

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
- Per-device values in `localStorage`: `skin`, `auth.session`, `sync.last.<uid>`, and `legacy.migratedTo`.

## 6. Accounts and cloud sync (`auth.js`, `cloud.js`)

- **Firestore layout:** `users/{uid}` holds `{ name, email }`. `users/{uid}/data/{chunk}` holds `{ json: "<array of records>", updatedAt }`, where a chunk is `categories`, `investments`, `settings` or `entries-YYYY`. Storing a chunk as one JSON string keeps a full sync to a handful of document reads (free tier: 50,000 reads and 20,000 writes per day).
- **Algorithm (`cloud.syncNow`):** save the profile once per session, list `users/{uid}/data`, merge it into IndexedDB with `db.importAll` (newer `updatedAt` wins; tombstones carry deletes), fold duplicate categories, then PATCH only the chunks whose JSON differs from what's in the cloud.
- **Triggers in `app.js`:** 2 seconds after any save or delete (`scheduleSync`), after sign-in and app start, when the app becomes visible again, and the **Sync now** button. Signing out syncs first, and warns if that fails.
- **Admin (`cloud.family`):** lists `users` and reads every member's chunks. Firestore only allows that for a **verified** email in the rules' admin list, so a new admin must click the link in the verification email, then sign out and in again.
- **Security rules (`firestore.rules`):** an owner can read and write `users/{uid}/**`, and a verified admin can read everything. These rules were tested live on 2026-10-22 with a temporary account: own read/write was allowed; listing users, reading or writing another user, and unauthenticated reads were all refused.
- **Adding an admin:** add the email to `ADMIN_EMAILS` in `config.js` **and** to the list in the rules (in the repo and in Firebase console → Firestore → Rules → Publish).
- **Removing a member:** Firebase console → Authentication → Users → ⋮ → Disable or Delete. Their Firestore data can be deleted under Firestore → Data → users.

## 7. Firebase setup (already done; for reference)

- Project `my-finances-family`, Spark plan.
- Authentication → Email/Password enabled. Authorized domains include `lakki911.github.io` (and `localhost` by default, which also covers the Android app's `https://localhost` origin).
- Firestore in `asia-south1`, production mode, with the rules from `firestore.rules`.
- A Web app is registered; its `apiKey` and `projectId` are in `config.js`.
- An older Google Cloud project, "My Finances", with OAuth clients for Drive sync, is **no longer used** and can be deleted.

## 8. Android build (`.github/workflows/android.yml`)

On every push to `main` (Markdown-only changes are skipped), with one build at a time:

1. `npm install` in `android-app/` (Capacitor 8 and `@capacitor/assets`).
2. Copy the web files into `android-app/www/`. Drop `sw.js`, add `capacitor.js`, and inject `<script src="capacitor.js">` before `app.js`.
3. `npx cap add android`, generate icons and splash with `capacitor-assets`, and set `versionCode` to the run number and `versionName` to `1.<run>`.
4. `./gradlew assembleRelease`, then `zipalign` and `apksigner sign` with `android-app/release.keystore`, then `apksigner verify`.
5. Publish a GitHub release `v1.<run>` with the asset `my-finances.apk`, marked as latest.

**Signing key:** `android-app/release.keystore`, alias `myfinances`, store and key password `myfinances-apk`. It is committed on purpose, so every build has the same signature and updates install over the old app. **Never replace it.** If you do, users must uninstall first, which loses unsynced data. (SHA-1: `27:AE:D7:25:E2:B1:C9:CD:AF:7D:CF:78:53:27:1F:48:76:56:FF:67`.) The key is public because the repo is public. That's acceptable for a sideloaded personal app, but move it to GitHub secrets if that ever matters.

Lessons from the first builds:
- Without the explicit `apksigner` step, the released APK was unsigned, and Android said "package appears to be invalid".
- The project moved to Capacitor 8 for a Google sign-in plugin (since removed); it stays on 8.

## 9. Working on it

- **Run locally:** `python -m http.server 8000` in the repo root, then open http://localhost:8000. Opening from `file://` won't work because ES modules need http.
- **Release:** commit and push to `main`. Pages redeploys in about 1 minute and the APK in about 5 minutes. Remember to bump `VERSION` in `sw.js`.
- **Code style:** small pure helpers, template-string views, everything escaped with `esc()`, and `data-action` buttons handled in one delegated click listener. Every write goes through `save()` / `drop()` in `app.js`, which also schedules a sync.
- **Adding a store or field:** keep `id`, `updatedAt` and `deleted`, and add new stores to `STORES` in `db.js`. Adding a store requires bumping `DB_VERSION` and handling `onupgradeneeded`.

## 10. Known limits and ideas

- Investment contributions live inside the investment record, so if two devices edit the same holding at the same time, the later save wins.
- Some screens still use `confirm()` / `prompt()` (deleting, new category, wipe). These work in browsers and in the Capacitor WebView, but in-app dialogs would look nicer.
- **Export backup** downloads a file, which works on PC but may not in the Android app. Data is safe in Firebase anyway; use the PC to export a file.
- Ideas: budgets per category with alerts, recurring expenses, search and filters, CSV export, charts per category over time, and an in-app list of family members for admins to manage.

## 11. History

- **2026-10-21:** v1 built (PWA with IndexedDB). Hosted on GitHub Pages. Android APK pipeline added. Google Drive sync added and Google Cloud configured. Fixed APK signing and Capacitor runtime loading.
- **2026-10-22:** Family accounts: Firebase email login, per-person data, admin Family view, migration of existing device data. Google Drive sync and the native Google sign-in plugin were removed.
- **2026-10-22:** Change password in Settings → Account.
- **2026-10-22:** Redesign: hero card, donut chart, category avatars, floating nav, bundled font, and the Fresh/Vault skins with a Look switch. This guide and the user guide were written.
