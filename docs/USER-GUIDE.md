# My Finances: how to use it

## Where to open it

| Device | How |
|---|---|
| PC | Open **https://lakki911.github.io/my-finances-repository/** in Chrome. Bookmark it, or click the install icon in the address bar to get a desktop app. |
| Android phone | Install the app from **https://github.com/lakki911/my-finances-repository/releases/latest/download/my-finances.apk** (allow "install from this source" when asked). |

## Signing in

- The first time, tap **Create an account** and enter your name, email and a password (at least 6 characters). Everyone in the family makes their own account.
- You stay signed in on that device. Sign in with the same email on your other devices to see the same data.
- Forgot your password? Tap **Forgot password?** on the sign-in screen and follow the email.
- Each person sees only their own records. Admins (lakkireddysurender@gmail.com and lakki911@gmail.com) also get a **Family** tab with everyone's totals, and can tap a person to see their records.
- **Admins:** click the link in the "verify your email" message once, then sign out and back in. The Family tab needs this.

## Every day

- Tap the round **+** button to add an entry. Choose **Salary**, **Other income** or **Spending**, enter the amount, pick a category, and tap **Save**.
- Tap any entry to edit or delete it.
- Use **‹ Oct 2026 ›** at the top to move between months.
- **Overview** shows what's left over this month, where the money went, and the last 6 months.
- **Invest** lists your holdings. Tap one to record a new contribution (for example, a monthly SIP) or update its current value.

## Settings

- **Look:** pick **Fresh** (light) or **Vault** (dark). Each device remembers its own choice.
- **Account:** shows who's signed in and when data last synced. **Sync now** syncs straight away. **Change password** asks for your current password, then the new one twice. **Sign out** saves your changes to the cloud first.
- **Categories:** add your own, or remove ones you don't use.
- **Currency:** INR by default.
- **Backup:** **Export backup** saves a file with all your data; **Import backup** merges one back in. Do an export now and then for safekeeping.

## If something looks wrong

| You see | Do this |
|---|---|
| "Offline. Changes are saved on this device…" | Nothing to do. It syncs when you're back online. |
| The Family tab says "Verify your email address first" | Open the verification email, click the link, then sign out and back in. |
| A family member forgot their password | They tap **Forgot password?** on the sign-in screen. |
| The PC site still looks old after an update | Refresh the page twice. |
| A new APK won't install | Delete the old `my-finances.apk` from Downloads and download it again. |
| Phone and PC show different data | Make sure both are signed in with the same email, then tap **Settings → Sync now** on each. |

## Getting changes made

Ask an AI assistant (or a developer) to work on the GitHub repository **lakki911/my-finances-repository**, and point them to `docs/HANDOFF.md`. When the change is pushed to the `main` branch, the website updates automatically and a new APK appears at the same download link within about 5 minutes.
