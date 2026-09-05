# Sesame · Grand Dunman

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

There are no acceptance checkboxes, separate review popup, profile-completion gate, or email/password verification screens. Facility information and rules are optional reading below the booking controls. Nothing is marked accepted or verified on your behalf. If the estate API rejects a request, its error is displayed.

The Book button checks the current time, price, availability and selected unit once, then submits the reservation and payment order. It prevents duplicate submissions. Payment instructions appear after booking; existing bookings are in **My bookings**. If the result is uncertain, check those records before retrying.

The browser connects directly to the estate's HTTPS API. You do not need another backend or a local server. Booking requires your normal owner login; account maintenance and password resets can be done in Intelliving. The booking session stays in memory and is cleared when the page is left or refreshed. Your saved entry QR remains available independently.

## iPhone

Use Safari's **Share → Add to Home Screen**. The app opens on My QR and uses large touch targets and controls sized for iPhone. It needs a connection to load; an already loaded QR screen refreshes locally. All booking times are Singapore time.

## Development

Node.js 22 or later:

```powershell
npm ci --ignore-scripts
npm run check
npm run build:pages
npm run preview:pages
```

Preview at <http://127.0.0.1:3213/Sesame/>. Add `?demo=1` for sample data. The optional loopback server still runs with `npm start`; `npm run start:readonly` blocks estate mutations and `npm run demo` uses `demo / demo` on port 3211.

Pushes to `main` validate, build and publish the allowlisted `dist` artifact. HTTPS, restricted deployment permissions and secret scanning remain enabled. `npm run audit:publication` checks tracked public files before manual publication.

The 60 automated tests cover the simplified booking flow, price/ownership/duplicate protections, API errors, QR decoding, indefinite saved-pass compatibility and private-data handling. Real login and read-only availability were previously verified; no real bookings, payments, emails or profile changes were made during testing. Physical iPhone rendering and reader acceptance are unverified.

See [SECURITY.md](SECURITY.md) for security boundaries and [ASSETS.md](ASSETS.md) for image and QR-encoder provenance. The public source contains no personal credentials or entry QR.
