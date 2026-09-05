# Security and hosting

## GitHub Pages

The public website at <https://lproperty.github.io/Sesame/> is a **demonstration**, with synthetic identities and reservations. It is not an official estate service and cannot sign in to a real account, book an estate facility, send verification codes or collect payments.

- The Pages entry point installs an in-memory simulator before starting the interface. The public welcome screen contains no username or password inputs.
- The HTML Content Security Policy blocks network API connections (`connect-src 'none'`), form submissions, workers, inline scripts, inline styles, object embeds and base URL changes. Scripts, styles and images load only from the site's own origin.
- No cookies, localStorage, sessionStorage, service workers, analytics or third-party fonts are used by the demo. Each page load starts a separate simulation; exiting the demo clears its data.
- The build copies an explicit list of reviewed files. It excludes the real API client, Node server, credentials, environment files, diagnostics, logs, APK research and real payment QR. Verification rejects unexpected files, symlinks, server-only imports and unapproved module dependencies.
- The public repository contains the local server's source and its estate asset provenance. Public source code must never contain resident credentials, tokens or private records. The publication audit checks tracked paths and common credential patterns; GitHub secret scanning and push protection provide an additional check. These checks do not prove the absence of every possible secret.

GitHub Pages serves static files and does not run the Node server. It also does not support setting arbitrary response headers. In particular, `frame-ancestors`, `X-Frame-Options`, HSTS and Permissions Policy cannot be configured with HTML meta tags. This project does not claim that its Pages meta policy supplies those header protections. The public demo contains no sensitive account or payment actions for an embedded page to invoke. HTTPS is enforced through the GitHub Pages setting and verified after deployment.

GitHub may retain normal hosting access logs, including visitor IP addresses; see the [GitHub Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Deployment

The Pages workflow uses full commit hashes for all GitHub Actions, installs the lockfile without package lifecycle scripts, runs the tests and publication audit, and uploads only the verified `dist` directory. Pull requests run validation without deployment permissions. Only the `main` branch of `lproperty/Sesame` can reach the deployment job. The `github-pages` environment is restricted to that branch.

Workflow permissions default to none. The build receives read-only repository access. Only the deployment job receives `pages: write` and `id-token: write`; it uses GitHub's short-lived identity and needs no personal access token or repository secret. Checkout does not persist Git credentials. Dependency and action updates are proposed by Dependabot.

## Local live app

The existing Node server is intended for trusted, local use on `127.0.0.1`. It uses a fixed HTTPS upstream origin with TLS verification, keeps estate tokens on the server, and returns opaque HttpOnly, SameSite session cookies. Mutations require a matching origin and CSRF token. Owner role, activated units, quantity, prices, rules and confirmation come from validated server state. Sessions expire after two hours of inactivity or twelve hours total. No request credentials, upstream responses or resident tokens are logged.

The `COOKIE_SECURE` option is for a trusted HTTPS setup; turning it on alone does not make the local server a production deployment. Sessions and duplicate-submission guards are in memory and are lost on restart.

**Live remote use needs separate backend hosting.** Prefer serving the live UI and API together on a trusted HTTPS origin, with secure host-only cookies, proxy/host validation, appropriate rate limits, and durable session and reservation safeguards. Do not expose the loopback server with an arbitrary public tunnel, add a permissive CORS proxy, put real tokens in browser storage, or compile secrets into the Pages artifact. A separate cross-site cookie API is also unreliable on iPhone Safari because of third-party cookie restrictions.

## Verification and reporting

Automated tests exercise private-file protection, origin and CSRF enforcement, session expiry, owner/unit restrictions, stale reviews, duplicate confirmations, unknown booking outcomes, rich-text sanitization and the isolated Pages simulation. They never make live estate bookings or profile changes. DOM tests do not constitute a physical iPhone/Safari layout check.

Report vulnerabilities through GitHub's private vulnerability reporting feature when available. Do not include passwords, tokens or resident records in public issues.
