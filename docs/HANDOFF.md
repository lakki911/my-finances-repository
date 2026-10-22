# My Finances: developer handoff

This file is the complete context for anyone (a person or an AI assistant) continuing development. Read it first.

## 1. What the app is

A personal finance tracker for a family. Each person registers with email and password and keeps their own records; admins can see everyone's records and family totals. It runs on PC (in a browser or as an installed PWA) and on Android (as an APK).

| Tab | Contents |
|---|---|
| Overview | Month hero (left over, savings rate), quick-add buttons, "heads up" insights, due soon (bills, debts, policies), budgets, spending donut, 6-month chart, portfolio. |
| Income, Spending | Entries for the month; spending by category and by payment method. |
| Invest | Holdings with contributions, XIRR, asset allocation donut, mutual fund NAV updates. |
| Plan | Sub-views: budgets (with rollover), bills & recurring, goals, lent & borrowed, loans (EMI schedule, prepayments), insurance & FDs. |
| Reports | Sub-views: year (FY Apr–Mar or calendar), monthly summary, trends by category, net worth, tax estimate (India, old vs new regime), export (Excel/CSV). |
| Family | Sub-views: shared family budgets and goals, split expenses; admins and co-admins also get Members (family totals, per-member view, recent activity, roles). |
| Top bar | Month picker, Search (all records with filters), Settings. |

Settings: account (sync, change password, sign out), security (PIN app lock with fingerprint in the APK, idle sign-out, signed-in devices), quick-add buttons, look (Fresh / Vault / Auto) and language (English / Hindi), categories with sub-categories, currency, backup.

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
- **PWA**: `manifest.webmanifest` (with Add spending / Add income shortcuts, `?add=expense|income`) and `sw.js` make it installable and usable offline.
- **Android** wraps the same web files with **Capacitor 8**, built in GitHub Actions. Nobody needs Android Studio.
- **Accounts and cloud data** use **Firebase**: Authentication (email/password) and Firestore, both called through their **REST APIs** with plain `fetch`. No Firebase SDK.
- **Outside data:** mutual fund NAVs from `api.mfapi.in` (free AMFI data); currency rates from `api.frankfurter.app` (free ECB rates). Both are optional; failures fall back to manual values. In the APK, `getJSON` falls back to Capacitor's native HTTP if the browser fetch is blocked.
- **Look**: skins *Fresh* (light, emerald) and *Vault* (dark, gold), plus *Auto* (follows `prefers-color-scheme`), chosen per device. Manrope font bundled in `fonts/`.
- **Hindi**: `i18n.js` swaps visible text after each render using a dictionary (plus a few regex patterns). Strings not in the dictionary stay English. Dates use the `hi-IN` locale.
- Default currency is **INR**.

## 4. Files

All JavaScript files must stay in the repo root: the APK build copies `../*.js`.

| File | Purpose |
|---|---|
| `index.html` | App shell: top bar (month picker, search and settings buttons), `<main id="view">`, floating + button, tab bar, `<dialog>`, toast. |
| `app.js` | All UI (~2,500 lines): state, views per tab and sub-view, dialogs, event delegation via `data-action`, recurring posting, budgets, insights, family sharing, idle sign-out. |
| `db.js` | IndexedDB layer (`DB_VERSION` 2): `all`, `get`, `put`, `remove` (soft delete), `exportAll`, `importAll` (merge), `wipe`, `readLegacy`. `STORES` lists every store. |
| `auth.js` | Firebase Authentication REST: register (+ verification email), login, password reset, change password, token refresh, `isAdmin()`. Session in `localStorage['auth.session']`. |
| `cloud.js` | Firestore REST: `syncNow` (own data), `family()` (admin/co-admin reads everyone), shared family space (`roles`, `setRole`, `getShared`, `mergeShared`, `publishTotals`, `people`), receipts, devices. |
| `finance.js` | Pure maths: `xirr`, `emi`, `schedule` (loan amortisation with prepayments), `incomeTax` (India, Budget 2025 slabs, old vs new regime). |
| `exporter.js` | CSV, a small hand-written XLSX writer (stored zip), and `saveFile` (download on PC; Filesystem + Share plugins in the APK). |
| `lock.js` | PIN app lock (salted SHA-256 in `localStorage['lock']`), biometric unlock via `@capgo/capacitor-native-biometric`, relock after 1 minute in the background. |
| `i18n.js` | Hindi dictionary and `translate(root)`. Add entries to `HI` to translate more text. |
| `config.js` | `FIREBASE` (`apiKey`, `projectId`; public by design) and `ADMIN_EMAILS` (UI only; the real check is in the rules). |
| `firestore.rules` | Security rules. **The copy in force is the one pasted into Firebase console → Firestore → Rules**; keep the two the same. |
| `styles.css` | All styling. Skins are token sets under `[data-skin]`. |
| `sw.js` | Service worker. **Bump `VERSION` on every change** (now `v10`) and add new files to `SHELL`. |
| `android-app/` | Capacitor project (`package.json` with core, android, filesystem, share, native-biometric; `capacitor.config.json`; `release.keystore`; `assets/`). `android/` and `www/` are generated in CI. |
| `.github/workflows/android.yml` | Builds and signs the APK and publishes a GitHub release on every push to `main`. |
| `docs/USER-GUIDE.md` | Plain-language guide for the owner, including the family sharing setup steps. |

## 5. Data model

IndexedDB `finance-app-<uid>`, version 2. **Every record has `id`, `updatedAt` (ISO string) and `deleted` (boolean).** Deletes are soft (tombstones). `db.all()` hides deleted records. The old single-user database `finance-app` is copied into the first account that signs in on a device (`localStorage['legacy.migratedTo']`).

```js
entries     { id, type: 'salary'|'income'|'expense', amount /* home currency */, categoryId, date: 'YYYY-MM-DD', note,
              method: 'upi'|'cash'|'card'|'bank'|'other'|'', tags: [..], orig: { currency, amount, rate } | null,
              receipt: bool, recurringId?, policyId? }
categories  { id, kind: 'income'|'expense'|'investment', name, parentId? /* one level of sub-categories */ }
investments { id, name, categoryId, currentValue|null, contributions: [{ id, date, amount }], note,
              assetClass, tax: '80C'|'nps'|'', schemeCode, schemeName, units, nav, navDate }
settings    { id: 'prefs', currency } · { id: 'networth', months: { 'YYYY-MM': value } } · { id: 'tax', years: { [fyStart]: {inputs} } }
budgets     { id, categoryId | 'all', amount, rollover, since: 'YYYY-MM' }
recurring   { id, name, type: 'expense'|'income'|'salary'|'investment', amount, categoryId, investmentId, method,
              day, every: 1|3|6|12, start: 'YYYY-MM', mode: 'remind'|'auto', doneThrough: 'YYYY-MM' }
goals       { id, name, target, by: 'YYYY-MM', investmentId?, saved: [{ id, date, amount }] }
debts       { id, direction: 'lent'|'borrowed', person, amount, date, due, note, repaid: [{ id, date, amount }] }
loans       { id, kind, name, principal, rate, months, start: 'YYYY-MM', emi?, prepay: [{ id, date, amount }] }
policies    { id, kind: 'life'|'term'|'health'|'vehicle'|'fd'|'other', name, provider, number, premium, cover, maturity, every, next, closed }
templates   { id, name, type, amount, categoryId, method, note, tags }   // quick-add buttons
```

- Recurring items post entries with id `<ruleId>-<YYYY-MM>` (and contributions with the same id), so two devices never double-post; a deleted entry's tombstone stops it coming back. `runRecurring()` runs after every sync.
- Budget rollover: limit = amount + positive leftover carried month to month since `since` (max 24 months).
- Loans assume EMIs are paid on schedule; `schedule()` derives balance, interest and end month.
- Default seeds use `updatedAt = 1970-01-01`, so synced data wins.
- Per-device `localStorage`: `skin`, `lang`, `auth.session`, `sync.last.<uid>`, `legacy.migratedTo`, `lock`, `lastMethod`, `fx.<CUR>.<HOME>`, `nav.lastRun`, `idleSignout`, `lastActive`, `deviceId`.

## 6. Cloud layout and sync

- `users/{uid}`: `{ name, email }`.
- `users/{uid}/data/{chunk}`: `{ json, updatedAt }`; chunk = each store name, with entries split per year (`entries-YYYY`). `syncNow` pulls all chunks, merges (newer `updatedAt` wins), folds duplicate categories, and PATCHes only changed chunks. New stores sync automatically (chunks come from `db.STORES`).
- `users/{uid}/receipts/{entryId}`: `{ image: <JPEG data URL, under ~700 KB> }`. Fetched only when viewed.
- `users/{uid}/meta/devices`: `{ json: [{ id, label, lastSeen }] }`, updated at each app start.
- `family/roles`: `{ members: map uid → 'member'|'viewer'|'coadmin'|'removed'|'none' }`, a real Firestore map because the rules read it. Only admins write it (Family → Members → Roles).
- `family/spend-<uid>`: `{ json: { uid, name, email, months: { 'YYYY-MM': { _all, <main category name>: amount } }, lastActive } }`, written by each member after every sync. Family budgets add these up; the people list for splits comes from these docs.
- `family/budgets`, `family/goals`, `family/splits`: `{ json: [records] }`, merged per record (`cloud.mergeShared`).
- Split model: `{ id, desc, amount, date, paidBy, shares: { uid: amount }, settle? }`. Balance = paid − shares; a settle-up is a split paid by the debtor with the creditor's share.

## 7. Security rules and Firebase setup

- Rules (in `firestore.rules`):
  - Owners read and write `users/{uid}/**` unless their role is `removed`.
  - Admins (verified email in the list) and co-admins can read every user.
  - Anyone signed in can read `family/roles`, and only admins can write it.
  - Members, viewers and co-admins can read `family/*`. Members and co-admins can write shared docs, and each member writes only their own `spend-<uid>`.
- **Status on 2026-10-22:** the family-sharing rules are in the repo. Until the owner pastes them into the console, family sharing shows a "needs the updated security rules" message, while receipts and the device list fail quietly. The admin's Members view still works under the old rules. The steps are in the user guide under "Family sharing setup".
- **Adding an admin:** add the email to `ADMIN_EMAILS` in `config.js` **and** to the list in the rules (in the repo and in the console).
- Project `my-finances-family`, Spark plan. Auth: Email/Password enabled; authorised domains include `lakki911.github.io` and `localhost` (covers the APK's `https://localhost`). Firestore is in `asia-south1`.
- An older Google Cloud project, "My Finances", with OAuth clients for Drive sync, is **no longer used** and can be deleted.

## 8. Android build (`.github/workflows/android.yml`)

On every push to `main` (Markdown-only changes skipped), one build at a time:

1. `npm install` in `android-app/` (Capacitor 8, `@capacitor/filesystem`, `@capacitor/share`, `@capgo/capacitor-native-biometric`, `@capacitor/assets`).
2. Copy the web files into `www/`, drop `sw.js`, add `capacitor.js` and inject it before `app.js`. Plugins are reached with `window.Capacitor.registerPlugin(name)` (no bundler).
3. `npx cap add android`, generate icons, set `versionCode`/`versionName` from the run number, `cap sync`, `./gradlew assembleRelease`.
4. `zipalign`, `apksigner sign` with `android-app/release.keystore`, `apksigner verify`.
5. Publish release `v1.<run>` with asset `my-finances.apk`, marked latest.

**Signing key:** `android-app/release.keystore`, alias `myfinances`, passwords `myfinances-apk`. Committed on purpose so updates install over the old app. **Never replace it.** (SHA-1 `27:AE:D7:25:E2:B1:C9:CD:AF:7D:CF:78:53:27:1F:48:76:56:FF:67`.)

## 9. Working on it

- **Run locally:** `python -m http.server 8000` in the repo root, then open http://localhost:8000.
- **Release:** commit and push to `main`. Pages redeploys in about 1 minute and the APK in about 5. Bump `VERSION` in `sw.js`.
- **Code style:** small helpers, template-string views, everything escaped with `esc()`, `data-action` buttons in one delegated click listener, sub-views via `subnav(group, options)` with `state[group + 'View']`. Every write goes through `save()` / `drop()` (own data) or `saveShared()` / `dropShared()` (family space).
- **Adding a store:** add it to `STORES` in `db.js`, bump `DB_VERSION` (the upgrade creates missing stores), and keep `id`/`updatedAt`/`deleted`.
- **Testing:** Playwright with a mocked Firebase/mfapi backend (routes on `identitytoolkit`, `securetoken`, `firestore`, `api.mfapi.in`) was used for every batch. Block service workers in tests (`serviceWorkers: 'block'`) so routes apply.

## 10. Known limits and ideas

- Hindi covers labels in the dictionary only; longer messages stay English.
- Tax estimate: individuals below 60, Budget 2025 slabs, surcharge simplified, no capital-gains rules.
- Net worth history starts from the first month the app recorded it; it excludes bank balances and property unless added as holdings.
- Family budgets match categories by main category **name** across members.
- Live prices are for mutual funds only (stocks need a paid data source).
- Bank linking and reading bank SMS were left out on purpose (owner's decision: no bank access).
- Ideas: push notifications for bills (`@capacitor/local-notifications`), stock prices, per-member family charts, more Hindi.

## 11. History

| Date | Change |
|---|---|
| 2026-10-22 | Family sharing (family budgets, goals, split expenses, roles, activity), other currencies, Auto look, Hindi, idle sign-out, device list, receipt photos. New `firestore.rules` to be pasted by the owner. |
| 2026-10-22 | Asset allocation, XIRR, mutual fund NAV, loans, insurance and FDs, net worth, trends, tax estimate, monthly summary. |
| 2026-10-22 | Savings goals, budget rollover, spending alerts, sub-categories, tags, lending and borrowing, quick-add buttons and home-screen shortcuts. |
| 2026-10-22 | Budgets, bills and recurring items, search, payment method, yearly report, Excel/CSV export, app lock. Plan and Reports tabs; search and settings moved to the top bar. |
| 2026-10-22 | Change password. |
| 2026-10-22 | Family accounts: Firebase email login, per-person data, admin Family view. Drive sync removed. |
| 2026-10-22 | Redesign: Fresh/Vault skins, donut chart, floating nav, bundled font. |
| 2026-10-21 | v1 (PWA with IndexedDB), GitHub Pages, Android APK pipeline, Google Drive sync (since removed). |
