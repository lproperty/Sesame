# Security and hosting

## Live architecture

The GitHub Pages site at <https://lproperty.github.io/Sesame/> hosts static interface code. The browser uses the estate's existing HTTPS API for real owner authentication, facilities, reservations and orders. No extra backend or local server is required. A simulator is available only with the explicit `?demo=1` option.

Passwords go directly to the fixed estate API origin and are never saved by the app. The estate token and a minimal owner/unit session snapshot are saved in sessionStorage so sign-in survives refreshes within the same tab. The token is not included in the UI's session view or saved to cookies, localStorage, IndexedDB, URLs, logs, repository files or build artifacts. Same-origin JavaScript and anyone with access to the unlocked browser can access tab storage; this is session persistence, not encryption. The stored session is bound to the configured estate API and its selected unit is validated against its owner associations on restoration. It retains the original twelve-hour absolute and two-hour idle limits. Explicit sign-out, local expiry, or an estate session-expired response clears it. Temporary connection failures do not discard sign-in. Browsers normally discard sessionStorage when the tab closes, though browser tab restoration may recover it within those expiry limits.

Leaving the page clears its in-memory authentication and private interface, including before Safari restores a page from its back/forward cache, while keeping the tab's saved session for the next load. Restoration generates fresh CSRF state, rebuilds empty booking/facility caches, and never replays submissions. If browser storage is blocked or corrupt, sign-in still works in memory. The separate, opt-in saved entry pass is described below. Browser/password-manager features that a resident chooses to use are separate from app storage.

All estate requests use explicit authentication headers, `credentials: omit`, `mode: cors`, `cache: no-store`, `referrerPolicy: no-referrer` and `redirect: error`. The adapter has a fixed endpoint allowlist; query parameters cannot select an API origin or proxy destination. The estate currently allows the Pages origin through its CORS responses. Since browser cookies are omitted, wildcard CORS origins do not require credentialed-cookie access. Future estate API or CORS changes can affect the app.

## Resident entry QR and optional device storage

The resident QR follows the native `pages/QR-access` payload: authenticated owner ID, activated unit ID and a current millisecond timestamp, with quotes removed as in the native app. The native format has no visible signature. The QR is an access credential; the reader/estate backend must verify identity, current unit access and freshness. This client cannot add cryptographic authenticity to that existing reader protocol, and physical-reader acceptance is unverified.

New passes are derived only from the signed-in owner's activated associations. By default the pass exists only in memory. **Keep my entry pass on this device** explicitly opts into storing just the owner ID and the selected unit's ID/project/display labels. It does not store a password, API token, email, phone number or booking records. The pass data is encrypted with AES-GCM; its randomly generated, non-extractable 256-bit key and random IV remain in the browser's IndexedDB. Ciphertext and key are written atomically, with no app-imposed expiry. Existing seven-day records remain usable. Tampered records are rejected and deleted. Saving and forgetting are serialized so a delayed save cannot undo sign-out.

Encryption protects the stored bytes against casual inspection or unauthenticated modification; it does not protect against someone using the unlocked browser, compromised same-origin JavaScript or malicious content hosted elsewhere under the same GitHub Pages origin. Such code can use the key to decrypt even though it cannot export it. The interface explains that device-access tradeoff before enabling quick entry. Removing the former expiry does not change reader authorization. Estate access revocations remain the reader/backend's responsibility.

The saved pass opens the QR screen without an API login and cannot authorize facility bookings. Signing out or forgetting removes the stored ciphertext/key. A new login with a different owner or without the saved unit's activated association invalidates it. The public build never contains a personal QR or saved-pass record. Codes are generated locally with the pinned, vendored QR encoder; no QR content is sent to a QR-generation service. Generation sends no unlock or smart-lock command.

QRs refresh every ten seconds, are removed while the page is hidden and are regenerated on return. The page requests a screen wake lock only while its QR is visible, when supported. All gate validation still happens at the estate's reader/backend.

## Browser protections and boundaries

- The HTML CSP allows API connections only to the deployment's configured HTTPS estate origin. The build validates this as one exact origin, without credentials, paths or extra CSP directives. Scripts and styles are same-origin, and images are restricted to the site and estate origin. Inline scripts/styles, form navigations, workers, object embeds and base URL changes are blocked.
- The bootstrap refuses to show sign-in or booking controls inside a frame or an insecure context. GitHub Pages cannot configure custom `frame-ancestors`, `X-Frame-Options`, COOP or Permissions-Policy response headers; the JavaScript guard is not claimed to provide those headers.
- Sessions expire after two hours of inactivity or twelve hours total. State is per tab, and failed or stale requests cannot replace a newer session.
- No service worker, third-party analytics or third-party fonts are installed. GitHub may keep normal hosting access logs, including IP addresses; see its [Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- API text is escaped. Facility rich text is reconstructed with a small tag allowlist and no attributes. Untrusted scripts, SVG, forms, links and embedded content are removed.
- Tokens are accessible to the browser's own JavaScript and developer tools. HTTPS and CSP reduce exposure; memory-only storage does not make an XSS-compromised browser safe.

**The estate server is the security authority.** It must enforce token validity, unit ownership, pricing, booking quotas and capacity. Frontend validation is not a substitute for server authorization. No claim is made that an untested estate control is secure simply because the interface checks it.

The client restricts units to activated owner associations and preserves string IDs and integer cents. A single Book action refreshes price and availability, compares them with the displayed choice, and submits immediately. Repeated requests cannot insert the same reservation twice. Rules/notice acceptance and app-imposed profile gates are removed; no acceptance flags are sent and no verification status is fabricated. The estate API enforces its own requirements and its errors are displayed. Profile, password-change and verification-email operations have been removed from the client API allowlist. A timed-out insertion is never automatically retried; a failed order retains the reservation reference. These duplicate guards live in memory and reset on page reload. Check estate booking records after an uncertain result. The frontend cannot guarantee exactly-once submissions across browser crashes or multiple tabs without upstream idempotency support.

## GitHub hosting guidance

GitHub's [Pages usage guidance](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) says Pages sites should not be used for sensitive transactions such as sending passwords. This is distinct from the technical ability to run a static API client. This deployment uses Pages as explicitly requested, with credentials transmitted directly to the estate API and the protections above. A static host intended for authenticated applications would avoid this hosting-policy concern and offer more control over response headers; it would not require a new estate backend.

## Publication and deployment

The build copies and verifies an explicit file allowlist. The Node server, credentials files, environment files, diagnostics, reports, APK research and dependency directories are excluded from the website artifact. The live API adapter and deployment payment settings are included because the hosted client uses them. No private account data is compiled into either.

Estate identifiers are omitted from tracked source. The maintainer supplies only the API origin and payment settings through `SESAME_SITE_CONFIG`, stored in the main-only `pages-build` environment and passed only to the live build step. The builder copies an explicit set of configuration fields into generated `lib/deployment.mjs` and fingerprints them with the other assets. Public forks and pull-request checks use a reserved example origin. Deployment refuses to publish a live build without real settings. Query strings, form fields and API responses cannot change the configured API origin.

The deployed API address and payment instructions are public browser configuration, even though the input is stored as an Actions secret to keep it out of Git source. Do not put passwords, tokens or personal entry QR data in that input. Source neutralization is a discoverability measure, not access control; old commits, branches, caches and copies can retain former content.

Module and asset URLs include a build fingerprint so new releases do not mix with cached modules. Every module dependency is checked against the allowlist and expected version format. The publication audit checks tracked paths, common credential patterns and, for the approved local publication check, exact local credential values without logging them. Scanners are an additional safeguard, not proof that every conceivable secret has been detected.

The pipeline uses three separate GitHub-hosted runners:

- `verify` installs locked test dependencies without lifecycle scripts, audits source, runs tests, and checks an example build. It has no repository secrets, environment settings or deployment permissions. No dependency caches are shared with the production build.
- `build` runs only after successful verification of the same main-branch commit. It checks out that exact commit on a fresh runner, installs no npm packages, and calls the first-party builder directly. This prevents test dependencies from modifying the release files on their runner. The verified `dist` directory is packaged into a tar archive and uploaded as an immutable artifact; overwriting an existing artifact is disabled.
- `deploy` does not check out repository code or execute npm packages. Only this job receives `pages: write` and `id-token: write`, and it deploys the artifact from the successful build in the same workflow run. The `github-pages` environment permits only `main`.

Verification and build tokens have only `contents: read`; unspecified permissions are disabled. Checkout does not save Git credentials. Deployment is restricted explicitly to main-branch push or manual-dispatch events in this repository. There are no privileged pull-request or workflow-completion triggers and no self-hosted runners. No personal access token, resident password or estate API token is embedded in the site.

Each action is pinned directly to a full commit SHA, including artifact upload. There is no composite Pages uploader that can resolve a nested mutable action tag. Repository policy requires SHA pins and allows only checkout, Node setup, artifact upload and Pages deployment actions. All external fork contributors require approval before their workflows can run. The default workflow token remains read-only and cannot approve pull requests.

The main branch requires a pull request, an up-to-date successful `verify` check from GitHub Actions, and resolved review conversations. Force pushes and branch deletion are blocked, including for normal administrator pushes. This is a single-maintainer repository, so independent approval is not required: the owner must review contributions before merging. An administrator can still change repository settings; these controls do not prevent compromise of the owner's GitHub account or guarantee that all malicious source changes will be detected. Use a passkey or strong two-factor authentication and protect the owner's GitHub credentials. Dependency scans report known advisories, not whether every dependency is trustworthy.

HTTPS is enforced by GitHub for the default `github.io` domain. Secret scanning, push protection, dependency security updates and private vulnerability reporting are enabled. Dependabot proposes updates to test dependencies and workflow actions.

## Optional local server and reporting

The original Node server remains a loopback-only development option with opaque HttpOnly/SameSite cookies, origin and CSRF checks, and server-held estate tokens. It shares the same booking workflows. It is not required for the hosted site and is not configured as an internet-facing, distributed production backend.

Automated tests use an isolated simulated estate. Live verification was limited to authentication and reads; no real booking, payment, email or profile mutation was performed. Report vulnerabilities through GitHub's private reporting feature. Do not post credentials, tokens or resident records in public issues.
