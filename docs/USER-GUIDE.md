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
- Each person sees only their own records. Admins (lakkireddysurender@gmail.com and lakki911@gmail.com) also see everyone's records in the **Family** tab.
- **Admins:** click the link in the "verify your email" message once, then sign out and back in. The Family tab needs this.

## The screens

| Where | What it's for |
|---|---|
| **Overview** | The month at a glance: what's left over, quick-add buttons, warnings, bills due soon, budgets, where the money went, and the last 6 months. |
| **Income** and **Spending** | Your entries for the month. Tap one to change or delete it. |
| **Invest** | Holdings, returns per year (XIRR), asset allocation, and mutual fund values from the daily NAV. |
| **Plan** | Budgets, bills and recurring items, savings goals, money lent and borrowed, loans, and insurance and FDs. |
| **Reports** | The year (April to March or January to December), monthly summary, trends, net worth, income tax estimate, and Excel or CSV export. |
| **Family** | Family budgets and goals, and split expenses. Admins and co-admins also see each member's records, recent activity and roles. |
| 🔍 and ⚙ at the top | Search all your records, and Settings. |

## Every day

- Tap the round **+** button to add an entry. Choose **Salary**, **Other income** or **Spending**, enter the amount, pick a category, and tap **Save**.
- You can also set the payment method (UPI, cash, card…), add tags like `#goa-trip`, attach a **receipt photo**, and pick another **currency** (enter the rate, and the app saves the amount in rupees).
- Tick **Also save as a quick-add button** for things you buy often. They appear on the Overview, and one tap adds them for today (with **Undo**).
- On Android, long-press the app icon for **Add spending** and **Add income** shortcuts.
- Use **‹ Oct 2026 ›** at the top to move between months.

## Planning

- **Budgets:** set a monthly limit for a category or for all spending. Bars turn amber at 80% and red when you go over, and the app warns you as you add spending. Turn on **Carry over what's left** to add unspent money to next month.
- **Bills & recurring:** add rent, EMIs, SIPs and subscriptions. Choose **Remind me** (it shows under Due soon, and you tap **Paid**) or **Add automatically** (it's recorded on the due day). The Plan tab shows a red number when something is due within 3 days.
- **Goals:** set a target and a date, and the app tells you how much to put aside each month. You can count a holding towards a goal.
- **Lent & borrowed:** keep track of money lent to or borrowed from people, with a due date and repayments.
- **Loans:** enter the amount, interest and tenure to see the EMI, what's left, the interest so far and the end date. Add part-prepayments to see the new end date.
- **Insurance & FDs:** get reminders before premiums are due and deposits mature. **Paid** records the premium as spending.

## Investments

- Open a holding to record a contribution (for example a monthly SIP) or change its current value.
- **Money you already have** (savings, cash set aside, an old FD): add it as a holding with **Amount invested now**. Use the type **Savings / cash** for spare cash. When you take money out, open the holding, enter the amount and tap **Withdraw**.
- **Mutual funds:** open the holding, tap **Mutual fund? Update its value from the daily NAV**, search for your fund, and enter the units you hold (from your fund statement). The value then updates once a day.
- Mark tax-saving holdings as **80C** or **NPS** so the tax estimate picks them up.

## Reports

- **Monthly summary:** a short write-up of any month. In the first week of a month, the Overview shows last month in short.
- **Tax:** compares the new and old tax regimes for the financial year. Enter your gross salary from Form 16; most other figures are worked out from your records. It's an estimate; check with your CA before filing.
- **Net worth:** investments plus money lent, minus loans and money borrowed. The app records it each month so the chart grows over time.
- **Export:** download a period as an Excel file (entries, investments, holdings and a monthly summary) or a CSV file. On the phone, it opens the share menu so you can save it to Drive or send it.

## Family sharing

- The admin adds each person under **Family → Members → Roles**: **Member** (shares family budgets, goals and split expenses), **Viewer** (can see them but not change them), **Co-admin** (also sees everyone's records), or **Removed** (can no longer sync).
- **Family budgets** add up everyone's spending in a main category with the same name, for example Groceries.
- **Split expenses:** record a shared bill and who paid. The app shows who owes whom, and **Settle up** records a repayment.

### Family sharing setup (admin, one time)

Family sharing, receipt photos and the device list need updated security rules in Firebase:

1. Open **console.firebase.google.com** and choose the project **my-finances-family**.
2. Go to **Firestore Database → Rules**.
3. Replace everything there with the contents of `firestore.rules` from the repository (https://github.com/lakki911/my-finances-repository/blob/main/firestore.rules), then click **Publish**.

## Settings

- **Account:** who's signed in and when data last synced. **Sync now**, **Change password** and **Sign out** (which saves your changes to the cloud first).
- **Security:** **App lock** asks for a PIN (and fingerprint in the Android app) when the app opens. **Sign out when idle** signs you out after a set time. **Signed-in devices** lists where your account was used; change your password to sign out everywhere else.
- **Quick-add buttons:** remove the ones you no longer need.
- **Look:** **Fresh** (light), **Vault** (dark) or **Auto** (follows your phone's dark mode). **Language:** English or हिन्दी (main labels are translated; some messages stay in English).
- **Categories:** add your own, including sub-categories (for example Food & dining › Swiggy).
- **Currency** and **Backup** (export a full backup file, or import one).

## If something looks wrong

| You see | Do this |
|---|---|
| "Offline. Changes are saved on this device…" | Nothing to do. It syncs when you're back online. |
| The Family tab says "Verify your email address first" | Open the verification email, click the link, then sign out and back in. |
| "Family sharing needs the updated security rules" | The admin follows **Family sharing setup** above. |
| Someone can't see the Family tab | The admin adds them under Family → Members → Roles. They then reopen the app. |
| Forgot the app lock PIN | Tap **Forgot PIN?** and sign in again with your password. |
| A family member forgot their password | They tap **Forgot password?** on the sign-in screen. |
| The PC site still looks old after an update | Refresh the page twice. |
| A new APK won't install | Delete the old `my-finances.apk` from Downloads and download it again. |
| Phone and PC show different data | Make sure both are signed in with the same email, then tap **Settings → Sync now** on each. |
| A fund's value doesn't update | Check the fund and units in the holding, then tap **Update NAVs** in Invest. |

## Getting changes made

Ask an AI assistant (or a developer) to work on the GitHub repository **lakki911/my-finances-repository**, and point them to `docs/HANDOFF.md`. When the change is pushed to the `main` branch, the website updates automatically and a new APK appears at the same download link within about 5 minutes.
