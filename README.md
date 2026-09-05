# Sesame · Grand Dunman

A mobile-friendly resident portal and a public facility-booking demonstration.

**Website:** <https://lproperty.github.io/Sesame/>

**Source:** <https://github.com/lproperty/Sesame>

The GitHub Pages website uses sample residents, units and reservations. It is a community-built demonstration, not an official estate service. It does not accept real account passwords, create estate bookings, send verification emails or collect payments. Open the demo without signing in; refresh the page or exit the demo to clear its simulated data.

The full live client is included for trusted local use. GitHub Pages serves static files and cannot run its private Node.js server. Live remote login and booking require separate HTTPS backend hosting; see [SECURITY.md](SECURITY.md).

## iPhone

The interface supports narrow screens, landscape cutouts, Safari's changing viewport and the home indicator. It includes persistent bottom navigation, touch targets of at least 44 pixels, 16px form controls to avoid focus zoom, a scrollable date selector, responsive booking details and native modal dialogs. Pinch zoom remains available and reduced-motion preferences are respected.

To add it to an iPhone Home Screen, open the website in Safari, tap **Share**, then **Add to Home Screen**. The site includes app icons and a standalone manifest. It needs a network connection to load; it does not install a service worker or cache private account data.

## Run the live app locally

Install Node.js 22 or later and run from the app directory:

```powershell
npm start
```

Open **http://127.0.0.1:3210** and use your existing Intelliving **owner** account. There are no runtime package dependencies. Normal startup never reads a credentials file.

For live viewing with estate mutations blocked:

```powershell
npm run start:readonly
```

For the original local simulator at **http://127.0.0.1:3211**, using `demo / demo`:

```powershell
npm run demo
```

Optional settings are documented in [.env.example](.env.example). The server binds to loopback; it is not configured for public multi-user hosting. Do not change this into a public deployment merely by opening a port.

The live app supports activated owner units, facility search, Singapore-time availability, session details, rules and notice acknowledgement, booking review, explicit confirmation, booking history and the estate's bank-transfer flow. Account completion is required when the estate reports missing email or a temporary password. Email codes and profile changes require explicit user actions. A review does not reserve a slot. Ambiguous submissions are not automatically retried.

## Build the GitHub Pages website

```powershell
npm ci --ignore-scripts
npm run check
npm run build:pages
npm run preview:pages
```

Open **http://127.0.0.1:3213/Sesame/**. This preview uses the same repository subpath as GitHub Pages. The build creates and verifies `dist` from an explicit allowlist; it never copies the whole workspace.

The GitHub workflow validates pull requests. A successful push to `main` builds the demo and deploys it to Pages. Actions are pinned to commit hashes, checkout credentials are not persisted, the deploy job uses a short-lived GitHub identity, and no repository secrets or personal access tokens are embedded in the website. The `github-pages` environment allows deployments only from `main`, and HTTPS is enforced. Dependabot proposes updates for test dependencies and workflow actions.

To audit staged or tracked public source before a manual publication:

```powershell
npm run audit:publication
```

## Validation

The 42 automated tests cover the live client's origin/CSRF checks, sessions, owner and unit restrictions, authoritative prices, stale reviews, duplicate submissions, ambiguous failures and sanitized rich text. Pages tests exercise sample checkout, mobile navigation, subpath-safe assets and sign-out, no credential fields, no network requests, isolated sessions and the artifact security boundary.

The tests use synthetic data and an isolated local simulator; they do not make real estate bookings, send verification emails, change passwords or make payments. DOM tests do not render a screen. A connected browser or physical iPhone was unavailable for visual validation during this update.

## Files

| File                                  | Purpose                                             |
| ------------------------------------- | --------------------------------------------------- |
| `public/app.js`, `public/styles.css`  | Shared desktop and iPhone interface                 |
| `public/site.webmanifest`             | Home Screen setup with repository-relative paths    |
| `pages/entry.js`, `pages/runtime.mjs` | Isolated browser demonstration                      |
| `server.mjs`                          | Loopback HTTP server, sessions and security headers |
| `lib/portal.mjs`, `lib/upstream.mjs`  | Live owner workflows and fixed HTTPS API adapter    |
| `lib/model.mjs`, `lib/demo.mjs`       | Data normalization and synthetic examples           |
| `scripts/build-pages.mjs`             | Allowlisted static build and verification           |
| `.github/workflows/pages.yml`         | Validation and restricted Pages deployment          |

Photograph and icon provenance is recorded in [ASSETS.md](ASSETS.md). No third-party analytics, fonts or image-generation services are used. See [SECURITY.md](SECURITY.md) for deployment boundaries, provider limitations and vulnerability reporting.
