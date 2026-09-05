# Security and hosting

## Live architecture

The GitHub Pages site at <https://lproperty.github.io/Sesame/> hosts static interface code. The browser uses Grand Dunman's existing HTTPS API for real owner authentication, facilities, reservations, orders and profile actions. No extra backend or local server is required. A simulator is available only with the explicit `?demo=1` option.

Passwords go directly to the fixed estate API origin. Its token stays inside the browser client's in-memory session and is not included in the UI's session view. Neither passwords nor tokens are saved to cookies, localStorage, sessionStorage, URLs, logs, repository files or build artifacts. Signing out or leaving the page discards the token. The interface and session are cleared before Safari can restore a previous page from its back/forward cache. Refreshing requires signing in again. Browser/password-manager features that a resident chooses to use are separate from app storage.

All estate requests use explicit authentication headers, `credentials: omit`, `mode: cors`, `cache: no-store`, `referrerPolicy: no-referrer` and `redirect: error`. The adapter has a fixed endpoint allowlist; query parameters cannot select an API origin or proxy destination. The estate currently allows the Pages origin through its CORS responses. Since browser cookies are omitted, wildcard CORS origins do not require credentialed-cookie access. Future estate API or CORS changes can affect the app.

## Browser protections and boundaries

- The HTML CSP allows API connections only to `https://granddunman.intelliving.app`. Scripts and styles are same-origin, and images are restricted to the site and estate origin. Inline scripts/styles, form navigations, workers, object embeds and base URL changes are blocked.
- The bootstrap refuses to show sign-in or booking controls inside a frame or an insecure context. GitHub Pages cannot configure custom `frame-ancestors`, `X-Frame-Options`, COOP or Permissions-Policy response headers; the JavaScript guard is not claimed to provide those headers.
- Sessions expire after two hours of inactivity or twelve hours total. State is per tab, and failed or stale requests cannot replace a newer session.
- No service worker, third-party analytics or third-party fonts are installed. GitHub may keep normal hosting access logs, including IP addresses; see its [Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- API text is escaped. Facility rich text is reconstructed with a small tag allowlist and no attributes. Untrusted scripts, SVG, forms, links and embedded content are removed.
- Tokens are accessible to the browser's own JavaScript and developer tools. HTTPS and CSP reduce exposure; memory-only storage does not make an XSS-compromised browser safe.

**The estate server is the security authority.** It must enforce token validity, unit ownership, pricing, booking quotas and capacity. Frontend validation is not a substitute for server authorization. No claim is made that an untested estate control is secure simply because the interface checks it.

The client restricts units to activated owner associations, preserves string IDs and integer cents, requires profile completion when reported by the estate, and refreshes the price, availability and terms before final confirmation. Duplicate confirmations in the current client share a single attempt. A timed-out insertion is never automatically retried; a failed order retains the reservation reference. These duplicate guards live in memory and reset on page reload. Check estate booking records after an uncertain result. The frontend cannot guarantee exactly-once submissions across browser crashes or multiple tabs without upstream idempotency support.

## GitHub hosting guidance

GitHub's [Pages usage guidance](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) says Pages sites should not be used for sensitive transactions such as sending passwords. This is distinct from the technical ability to run a static API client. This deployment uses Pages as explicitly requested, with credentials transmitted directly to the estate API and the protections above. A static host intended for authenticated applications would avoid this hosting-policy concern and offer more control over response headers; it would not require a new estate backend.

## Publication and deployment

The build copies and verifies an explicit file allowlist. The Node server, credentials files, environment files, diagnostics, reports, APK research and dependency directories are excluded from the website artifact. The live API adapter and the APK-sourced payment QR are included because the hosted client uses them. No private account data is compiled into either.

Module and asset URLs include a build fingerprint so new releases do not mix with cached modules. Every module dependency is checked against the allowlist and expected version format. The publication audit checks tracked paths, common credential patterns and, for the approved local publication check, exact local credential values without logging them. Scanners are an additional safeguard, not proof that every conceivable secret has been detected.

GitHub Actions are pinned to full commit hashes. The workflow installs locked test dependencies without lifecycle scripts, audits the source, tests it, builds and verifies the artifact, and uploads only `dist`. Pull requests have no deployment permissions. Only `main` in `lproperty/Sesame` may deploy, and the `github-pages` environment permits only that branch. Build access is read-only; only the deployment job receives `pages: write` and `id-token: write`. Checkout does not save Git credentials, and no personal access token or repository secret is embedded in the site.

HTTPS is enforced by GitHub for the default `github.io` domain. Secret scanning, push protection, dependency security updates and private vulnerability reporting are enabled. Dependabot proposes updates to test dependencies and workflow actions.

## Optional local server and reporting

The original Node server remains a loopback-only development option with opaque HttpOnly/SameSite cookies, origin and CSRF checks, and server-held estate tokens. It shares the same booking workflows. It is not required for the hosted site and is not configured as an internet-facing, distributed production backend.

Automated tests use an isolated simulated estate. Live verification was limited to authentication and reads; no real booking, payment, email or profile mutation was performed. Report vulnerabilities through GitHub's private reporting feature. Do not post credentials, tokens or resident records in public issues.
