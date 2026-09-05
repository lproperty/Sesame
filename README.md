# Sesame · Grand Dunman

A mobile-friendly resident entry QR and live facility-booking portal for Grand Dunman.

**Website:** <https://lproperty.github.io/Sesame/>

**Source:** <https://github.com/lproperty/Sesame>

Open the website and sign in with your existing Intelliving **owner** account. Your browser connects directly to the estate's existing HTTPS API. You do not need to run a local server or arrange another backend. Sesame is an independent resident portal.

## Open straight to your entry QR

Sign in once and **My QR** is the first screen. It displays a large resident entry code, refreshes it every 10 seconds and regenerates it when you return to the app. No facility-list request is needed to show it. An active profile form or booking review is preserved when switching back from Mail or SMS.

For subsequent openings without another login, tap **Keep my entry pass on this device** once. This opt-in saves the minimum entry identity in encrypted browser storage for **seven days**. Anyone able to open Sesame on that device can show the pass, so enable it only on your own device. Your password and booking API token are not saved. Signing out, **Forget saved entry pass**, expiry, or signing in as a different owner removes the saved pass.

The QR uses the resident format found in Intelliving: the authenticated owner ID, an activated owner-unit ID and the current millisecond timestamp. It is generated locally, with no third-party QR service and no door/unlock command. QR decoding and payload compatibility are tested; acceptance by a physical estate reader has not been tested.

The app still needs a connection to load its code. An already loaded QR screen can refresh locally, and saved-pass display does not make an estate API request. A saved entry pass does not sign you in for facility booking.

## Booking facilities

1. Open **Facilities**, sign in if needed, and choose one of your activated owner units.
2. Complete the profile prompt if the estate reports a missing email or temporary password. Verification codes are sent only when you request them; profile changes require confirmation.
3. Browse facilities, choose a Singapore-time date and an available session, and read the facility rules and any notice.
4. Review the price, time, quantity and unit. **Confirm booking** sends the reservation and creates its payment order.
5. Follow the estate's bank-transfer instructions and use **My bookings** to view upcoming, unpaid or historical reservations.

A review does not reserve a slot. The app refreshes availability, prices and rules before confirmation. Double-clicking does not send duplicate reservations. If a submission has an uncertain outcome, check your bookings or the official app before trying again; no automatic retry is sent.

Booking sign-in lasts only in the current tab. Refreshing or leaving the page requires signing in again for booking; the optional saved entry pass can still display your QR. Tokens and passwords are not written to cookies, localStorage, sessionStorage, IndexedDB, URLs or public files. Booking records remain on the estate's server. Client-side duplicate guards reset on page reload and cannot replace the estate's server-side controls.

## iPhone

The interface includes bottom navigation, large touch targets, 16px form controls, a scrollable date selector and native dialogs. It accounts for the notch, landscape cutouts, Safari's viewport and the home indicator. Pinch zoom and reduced-motion preferences remain available.

In Safari, use **Share → Add to Home Screen** for a standalone shortcut. The app requires internet access and installs no service worker. All schedule times are Singapore time.

## Development

Node.js 22 or later is required for development:

```powershell
npm ci --ignore-scripts
npm run check
npm run build:pages
npm run preview:pages
```

Open **http://127.0.0.1:3213/Sesame/**. The Pages build is live by default. Add `?demo=1` explicitly for the optional simulator; its welcome screen has no credential fields and all its reservations are simulated.

The original loopback server remains available with `npm start` at **http://127.0.0.1:3210**. `npm run start:readonly` blocks estate mutations, and `npm run demo` starts the original local simulator at port 3211 using `demo / demo`. These development servers are not needed to use the hosted website. Optional settings are in [.env.example](.env.example).

## Publishing and security

A successful push to `main` runs the tests and publication audit, builds an explicit list of public files, and deploys only `dist`. Pull requests cannot deploy. Actions use pinned commit hashes, minimal permissions and a short-lived GitHub deployment identity. The `github-pages` environment is limited to `main`; HTTPS, secret scanning and push protection are enabled.

The content security policy permits API connections only to the estate's HTTPS origin. Inline scripts, inline styles, form navigations, workers and arbitrary base URLs are blocked. Credentials use explicit authentication headers with browser cookies omitted. The bootstrap refuses embedded or insecure use, and navigating away clears the session. Versioned asset and module URLs prevent a new deployment from mixing with cached code.

The estate API remains the authority for authentication, ownership, capacity, prices and booking quotas. Browser checks improve safety and usability; users can modify their own JavaScript. GitHub Pages also cannot set arbitrary response headers. See [SECURITY.md](SECURITY.md) for these boundaries and GitHub's published guidance about password transactions.

Before a manual publication, run `npm run audit:publication` in the staged Git checkout. Never commit credentials, resident records, local reports, environment files or APK research.

## Validation

The 59 automated checks cover QR decoding with an independent decoder, native payload compatibility, first-screen routing, encrypted saved-pass restoration, tamper/expiry rejection, forgetting/sign-out, account changes and Singapore date rollover. They also cover the browser client, built module graph, booking/payment flows against a mocked estate API, profile gates, sanitization, session expiry, origin/CSRF protection, stale reviews, duplicate confirmations and ambiguous failures.

Authenticated live login, facility details, availability, booking-list reads and CORS response headers were also checked without making reservations, orders, payments, verification-email requests or profile changes. A physical iPhone/browser rendering check was unavailable; DOM tests do not validate native layout or Safari's browser enforcement.

## Files

| File                                           | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `public/app.js`, `public/styles.css`           | Desktop and iPhone interface                                |
| `public/entry-pass.js`, `public/pass-store.js` | Resident QR generation and opt-in encrypted device storage  |
| `pages/entry.js`, `pages/live.mjs`             | Hosted bootstrap, memory-only sessions and live API routing |
| `lib/portal.mjs`                               | Shared owner, booking and profile workflows                 |
| `lib/upstream.mjs`                             | Fixed HTTPS estate endpoints and authentication headers     |
| `lib/model.mjs`                                | IDs, dates, money, availability and response validation     |
| `pages/runtime.mjs`, `lib/demo.mjs`            | Optional simulator                                          |
| `server.mjs`                                   | Optional loopback development server                        |
| `scripts/build-pages.mjs`                      | Allowlisted, versioned build and verification               |
| `.github/workflows/pages.yml`                  | Validation and restricted deployment                        |

Photograph, payment QR and icon provenance is recorded in [ASSETS.md](ASSETS.md). The site includes no third-party analytics or fonts.
