# My Finances

Live app: https://lakki911.github.io/my-finances-repository/

A personal finance app that runs in any browser on PC and installs on Android as an app. Works offline. Data stays on your device.

## What it tracks
- **Salary** each month (one tap to repeat last month's amount)
- **Other income** under your own categories
- **Spending** under your own categories
- **Investments**: holdings, contributions over time, current value, gain/loss
- **Overview**: monthly totals, what's left over, 6-month trend, spending by category, portfolio

## Run it
It must be served over http(s) (opening `index.html` directly from disk won't work).

- **On your PC, quickly:** in this folder run `python -m http.server 8000`, then open http://localhost:8000
- **On your phone:** host the folder on any static HTTPS host (GitHub Pages, Netlify, Cloudflare Pages). Open the link in Chrome on Android and choose **Install app** / **Add to Home screen**.

## Your data
Stored in the browser's IndexedDB on each device. Use **Settings → Export backup** regularly, and **Import backup** on another device to move data. Imports merge: the newer version of each record wins.

Every record has an `id`, `updatedAt` and a `deleted` flag, so cloud sync can be added later without changing the data format.

## Files
`index.html`, `styles.css`, `app.js` (UI), `db.js` (storage), `sw.js` (offline cache; bump `VERSION` after changing files), `manifest.webmanifest`, `icons/`.

## Later: real APK
Wrap this folder with Capacitor (`npx cap add android`) to build an `.apk` without changing the app code.
