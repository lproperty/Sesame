# Sesame

Entry QR and facility bookings, with as few steps as possible.

**App:** <https://lproperty.github.io/Sesame/>

**Source:** <https://github.com/lproperty/Sesame>

## Entry QR

Sign in once and **My QR** appears first. Tap **Keep my entry pass on this device** to open straight to it next time. The saved pass has **no app-imposed expiry**, including passes saved by older versions. It stays until you forget it, sign out, clear the site's data, or sign in with a different owner/unit association.

The pass is encrypted in this browser. It saves the minimum entry identity, not your password or booking-session token. Use it only on a personal device. The QR contains the owner ID, unit ID and a fresh timestamp, and refreshes every ten seconds using the native app's format. Physical reader acceptance has not been tested.

## Book a facility

1. Open **Facilities** and choose a facility.
2. Choose a date and time.
3. Tap **Book · S$price**.

On iPhone and other narrow screens, the chosen time and the **Book** button stay pinned above the tab bar, so you never scroll past every slot to find them. Sessions that have already ended are tucked behind **Show N ended sessions**; when every session on a date has ended, a button opens the next day. The time list refreshes behind the booking result, so a time you just booked is no longer offered when you close it.

There are no acceptance checkboxes, separate review popup, profile-completion gate, or email/password verification screens. Facility information and rules are optional reading below the booking controls. Nothing is marked accepted or verified on your behalf. If the estate API rejects a request, its error is displayed.

The Book button checks the current time, price, availability and selected unit once, then submits the reservation and payment order. It prevents duplicate submissions. Paid bookings show payment instructions; zero-value bookings show that no payment is required, and **Confirmed · Free** once the estate returns a current booking. Existing bookings are in **My bookings**. If the result is uncertain, check those records before retrying.

**Add to calendar** in the booking result, and in **View details** for upcoming and pending bookings, downloads a calendar event with a reminder an hour before. It opens in Apple Calendar, Google Calendar or Outlook and contains only the facility, time and booking reference. **Copy** buttons beside the UEN, bank account and booking/order references help when paying by bank transfer and sending proof of payment.

Sessions that have started but have not ended can also be selected when the estate reports availability. They are labelled **In progress**; the original end time and full listed price still apply. Ended sessions remain unavailable, including if a session ends before you submit. After the estate confirms the booking, its **Entry QR** is available until the session ends. The estate can reject a late booking; live acceptance of bookings made after the start time has not been verified.

In **My bookings → Pending payment → View details**, use **Complete payment** to reopen payment instructions, **Check payment** to get the estate's latest status, or **Cancel reservation** to release an unpaid booking. These actions work after signing in again and reuse the existing reservation. Cancelling asks you to confirm the selected booking; paid reservations cannot be cancelled here. Bank transfers and PayNow UEN payments still need confirmation from estate management, so sending payment does not immediately change the booking status.

Confirmed **free tennis** bookings also offer **Cancel reservation** before the session starts. In **My bookings → History**, completed free tennis bookings offer **Cancel booking**, both on the booking row and in **View details**. The historical confirmation explains that cancellation removes the past record and does not undo past use or guarantee a monthly quota credit. Paid historical bookings remain excluded.

Sesame checks the selected unit's booking and its linked zero-value order again, then asks the estate to cancel it. It confirms success only after the booking disappears from the current, unpaid and historical lists, and records the result in Activity. The estate can still reject a request; a timeout or unverifiable result is shown as uncertain. A settled zero-value order may remain in order history. An authorized live test confirmed usable monthly quota restoration after cancelling a future free off-peak tennis booking; restoration after historical cancellation remains unverified.

## Booking entry QR

In **My bookings → Upcoming**, tap **Entry QR**, or open a booking's details and choose **Show entry QR**. These are the estate's images for that confirmed booking and selected unit. Sesame fetches them from the native booking QR endpoint and refreshes at the estate's configured interval (ten seconds by default). Codes are removed when the dialog closes, the page is hidden, the account/unit changes, or the booking is cancelled. Returning to the open dialog requests a fresh code.

Booking entry QR images are held only in the active page. They are never added to the saved resident pass, activity log, export, or browser storage. A connection and a valid booking session are required. Pending, ended and missing bookings do not receive a QR through Sesame. The estate and its readers determine when the credential can open the facility; physical reader acceptance has not been tested here.

## Activity log

Open **Activity** for this account and unit's booking observations and actions. The log records booking/cancellation attempts as **unconfirmed** before submission, then records success or failure when the result is known. It preserves the original attempt time and separates device observation times from estate-provided order times. Disappearance from a list alone never creates a cancellation event.

The log is encrypted in this browser's IndexedDB and survives reloads and sign-out. It is scoped to the owner, project and unit, contains no passwords, tokens or QR images, and is not synced to other devices or household accounts. If persistent storage is unavailable, the UI says that the log only lasts for the current tab. The demo uses this temporary mode deliberately.

Use the month selector to view observed bookings by facility-use month and recorded actions by action month, all in Singapore time. These totals are not an authoritative quota balance or complete historical cancellation audit. **Export log** downloads the available records as JSON; **Clear this unit's log** asks for confirmation and removes only this browser's selected account/unit records. It does not cancel estate bookings. The log has no time-based expiry; it retains up to 5,000 booking observations and 10,000 action records per scope and reports any older records omitted by those limits.

## Stay signed in

Sign in once and Sesame keeps the issued estate session and selected unit in this browser across refreshes, closed tabs, and app/browser restarts. Sesame has no two-hour idle or twelve-hour login expiry. It never saves your password. Existing tab-only logins migrate automatically when available.

Use **Sign out** to remove the saved login. Clearing site data, using a different browser/storage container, or the estate expiring/revoking the session can require another sign-in. Network interruptions do not erase it. The estate has no verified passwordless renewal endpoint, so Sesame does not pretend to renew an expired token. When site storage is blocked, the app explains that sign-in only lasts in the current tab.

The browser connects directly to the estate's HTTPS API; no extra backend or local server is required. The optional loopback server also keeps its cookie across browser restarts and no longer has the short session timers, but restarting that development server clears its in-memory sessions. Account maintenance and password resets remain in the estate app. The saved resident entry pass is independent of the booking session.

## iPhone

Use Safari's **Share → Add to Home Screen**. The app opens on My QR and uses large touch targets and controls sized for iPhone. If you switch to another app for less than ten minutes while choosing a booking time, Sesame keeps your facility, date and selected time instead; any other return opens on My QR. Facilities are listed as compact rows, and the sign-in form fits on screen without scrolling. It needs a connection to load; an already loaded QR screen refreshes locally. All booking times are Singapore time.

## Development

Node.js 22 or later:

```powershell
npm ci --ignore-scripts
npm run check
npm run build:pages
npm run preview:pages
```

Preview at <http://127.0.0.1:3213/Sesame/?demo=1> for sample data. A checkout has a nonfunctional example API origin until deployment settings are provided. The optional loopback server still runs with `npm start`; `npm run start:readonly` blocks estate mutations and `npm run demo` uses `demo / demo` on port 3211.

## Deployment settings

Estate-specific values stay outside tracked source. Configure the main-only `pages-build` environment's `SESAME_SITE_CONFIG` Actions secret as a JSON object with `apiOrigin` and `payment`. The origin must be one plain HTTPS origin. Payment fields are `payee`, `uen`, `bankName`, `bankAccount`, `email`, and `qrText` (the original payment QR payload). Never include resident credentials, API tokens or personal entry QR data.

For local live development, put the same JSON on a `SESAME_SITE_CONFIG` line in the ignored `.env` file. Build with `node --env-file=.env scripts/build-pages.mjs --live`. The public `lib/deployment.mjs` remains empty; only its generated copy in `dist` receives the approved settings. Pull-request checks use example settings and receive no deployment secret.

These settings are excluded from searchable Git source, but the website necessarily exposes its API address and payment instructions to browsers. They are not runtime secrets. Removing names does not prevent people from viewing or copying public code, and earlier commits, branches or cached pages can retain old content.

Changes enter `main` through a pull request with the required `verify` check. Tests run without secrets or deployment permissions. A separate fresh runner builds the allowlisted `dist` artifact without installing npm dependencies or sharing caches, then a third job deploys it. HTTPS, restricted deployment permissions and secret scanning remain enabled. `npm run audit:publication` checks tracked public files before manual publication.

The automated tests use simulated estate data and cover booking/access ownership, future and historical free-tennis cancellation, paid-booking protections, uncertain results, QR refresh cleanup, encrypted activity persistence/export, calendar export and copy buttons, ended-session and app-switch behaviour, date/month handling, and the existing login/entry-pass flows. Separate authorized live checks confirmed future free-tennis cancellation and slot release, removal of one historical free-tennis record, and future-cancellation quota restoration. A read-only check confirmed the estate returns PNG booking QR images with a ten-second interval. Automated checks do not make live reservations, cancellations, payments, emails or profile changes. Physical iPhone rendering and reader acceptance remain unverified.

See [SECURITY.md](SECURITY.md) for security boundaries and [ASSETS.md](ASSETS.md) for image and QR-encoder provenance. The public source contains no personal credentials or entry QR.
