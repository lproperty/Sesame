import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, extname, sep } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createUpstream, AppError } from "./lib/upstream.mjs";
import { OwnerPortal } from "./lib/portal.mjs";
import { createDemoUpstream } from "./lib/demo.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, "public");
const SESSION_TTL = 12 * 60 * 60_000;
const SESSION_IDLE = 2 * 60 * 60_000;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://granddunman.intelliving.app; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cache-control": "no-store",
};

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    ...HEADERS,
    "content-type": MIME[".json"] || "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  if (
    !req.headers["content-type"]?.toLowerCase().startsWith("application/json")
  ) {
    throw new AppError("Use JSON for this request.", 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new AppError("Request is too large.", 413);
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("Invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AppError("Expected a JSON object.");
  return body;
}

function equalSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createApplication({
  readOnly = false,
  demo = false,
  upstream,
  now = Date.now,
  secureCookie = false,
} = {}) {
  const portal = new OwnerPortal({
    upstream:
      upstream ??
      (demo ? createDemoUpstream({ now }) : createUpstream({ readOnly })),
    readOnly,
    demo,
    now,
  });
  const sessions = new Map();
  const loginAttempts = new Map();
  const cookieName = demo ? "gd_demo_session" : "gd_owner_session";
  const cookie = (id, clear = false) =>
    `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : SESSION_TTL / 1000}${secureCookie ? "; Secure" : ""}`;
  const getSessionId = (req) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
  const findSession = (req) => {
    const id = getSessionId(req);
    const session = sessions.get(id);
    if (!session)
      throw new AppError(
        "Sign in to your owner account to continue.",
        401,
        "SIGN_IN_REQUIRED",
      );
    if (
      session.expiresAt <= now() ||
      session.lastSeen + SESSION_IDLE <= now()
    ) {
      sessions.delete(id);
      throw new AppError(
        "Your session has expired. Please sign in again.",
        401,
        "SESSION_EXPIRED",
      );
    }
    session.lastSeen = now();
    return session;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || "";
      const allowedHosts = [
        `127.0.0.1:${req.socket.localPort}`,
        `localhost:${req.socket.localPort}`,
        `[::1]:${req.socket.localPort}`,
      ];
      if (!allowedHosts.includes(host))
        throw new AppError(
          "Use this app through its local address.",
          403,
          "HOST_NOT_ALLOWED",
        );
      const url = new URL(req.url, `http://${host}`);
      if (req.method === "GET" && url.pathname === "/api/health")
        return json(res, 200, { ok: true, readOnly, demo });
      if (url.pathname.startsWith("/api/")) {
        if (req.headers["sec-fetch-site"] === "cross-site")
          throw new AppError(
            "Cross-site requests are not accepted.",
            403,
            "ORIGIN_NOT_ALLOWED",
          );
        if (
          req.headers.origin &&
          ![`http://${host}`, `https://${host}`].includes(req.headers.origin)
        ) {
          throw new AppError(
            "This request did not come from this app.",
            403,
            "ORIGIN_NOT_ALLOWED",
          );
        }
        if (req.method === "GET" && url.pathname === "/api/config")
          return json(res, 200, portal.configuration());
        if (req.method === "POST" && url.pathname === "/api/login") {
          const ip = req.socket.remoteAddress || "local";
          const attempts = (loginAttempts.get(ip) || []).filter(
            (time) => time > now() - 15 * 60_000,
          );
          if (attempts.length >= 10)
            throw new AppError(
              "Too many login attempts. Please wait 15 minutes.",
              429,
              "LOGIN_COOLDOWN",
            );
          attempts.push(now());
          loginAttempts.set(ip, attempts);
          const body = await readJson(req);
          const session = await portal.login(body);
          body.cipher = "";
          loginAttempts.delete(ip);
          if (sessions.size >= 100)
            throw new AppError(
              "Too many active sessions. Restart the local server.",
              503,
            );
          sessions.delete(getSessionId(req));
          const id = randomBytes(32).toString("base64url");
          Object.assign(session, {
            createdAt: now(),
            expiresAt: now() + SESSION_TTL,
            lastSeen: now(),
          });
          sessions.set(id, session);
          return json(res, 200, portal.sessionView(session), {
            "set-cookie": cookie(id),
          });
        }
        const session = findSession(req);
        if (req.method === "GET" && url.pathname === "/api/session")
          return json(res, 200, portal.sessionView(session));
        let body;
        if (req.method === "POST") {
          if (!equalSecret(req.headers["x-csrf-token"], session.csrf))
            throw new AppError(
              "Refresh the page and try again.",
              403,
              "CSRF_INVALID",
            );
          body = await readJson(req);
        }
        if (req.method === "POST" && url.pathname === "/api/logout") {
          sessions.delete(getSessionId(req));
          return json(
            res,
            200,
            { signedOut: true },
            { "set-cookie": cookie("", true) },
          );
        }
        if (req.method === "POST" && url.pathname === "/api/unit")
          return json(res, 200, portal.switchUnit(session, body.unitId));
        if (req.method === "GET" && url.pathname === "/api/facilities")
          return json(res, 200, await portal.facilities(session));
        const availabilityMatch =
          /^\/api\/facilities\/([a-zA-Z0-9_-]+)\/availability$/.exec(
            url.pathname,
          );
        if (req.method === "GET" && availabilityMatch) {
          return json(
            res,
            200,
            await portal.availability(
              session,
              availabilityMatch[1],
              url.searchParams.get("date"),
            ),
          );
        }
        const facilityMatch = /^\/api\/facilities\/([a-zA-Z0-9_-]+)$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && facilityMatch)
          return json(
            res,
            200,
            await portal.facility(session, facilityMatch[1]),
          );
        if (req.method === "GET" && url.pathname === "/api/bookings")
          return json(
            res,
            200,
            await portal.bookings(
              session,
              url.searchParams.get("tab") || "current",
            ),
          );
        if (req.method === "POST" && url.pathname === "/api/bookings/preview")
          return json(res, 200, await portal.preview(session, body));
        if (req.method === "POST" && url.pathname === "/api/bookings")
          return json(res, 200, await portal.book(session, body));
        if (req.method === "POST" && url.pathname === "/api/bookings/commit")
          return json(res, 200, await portal.commit(session, body));
        const paymentMatch = /^\/api\/payments\/([a-zA-Z0-9_-]+)$/.exec(
          url.pathname,
        );
        if (req.method === "GET" && paymentMatch)
          return json(
            res,
            200,
            await portal.paymentStatus(session, paymentMatch[1]),
          );
        throw new AppError(
          "That page or action was not found.",
          404,
          "NOT_FOUND",
        );
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw new AppError("Method not allowed.", 405);
      const path =
        url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const file = resolve(publicRoot, "." + path);
      if (
        !file.startsWith(publicRoot + sep) ||
        !Object.hasOwn(MIME, extname(file))
      )
        throw new AppError("File not found.", 404, "NOT_FOUND");
      let data;
      try {
        data = await readFile(file);
      } catch {
        throw new AppError("File not found.", 404, "NOT_FOUND");
      }
      res.writeHead(200, { ...HEADERS, "content-type": MIME[extname(file)] });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const known = error instanceof AppError;
      if (known && ["SESSION_EXPIRED"].includes(error.code))
        sessions.delete(getSessionId(req));
      // Never log request bodies, upstream responses, tokens or credentials.
      if (!known)
        console.error("An internal request error occurred:", error.name);
      json(res, known ? error.status : 500, {
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known
            ? error.message
            : "Something went wrong. Please try again.",
          ...(known && error.details ? { details: error.details } : {}),
        },
      });
    }
  });
  server.requestTimeout = 75_000;
  server.headersTimeout = 10_000;
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions)
      if (session.expiresAt < now() || session.lastSeen + SESSION_IDLE < now())
        sessions.delete(id);
    for (const [ip, attempts] of loginAttempts)
      if (!attempts.some((t) => t > now() - 15 * 60_000))
        loginAttempts.delete(ip);
  }, 60_000);
  cleanup.unref();
  server.on("close", () => clearInterval(cleanup));
  return { server, portal, sessions };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const demo = args.includes("--demo");
  const readOnly =
    args.includes("--read-only") || process.env.READ_ONLY === "true";
  const port = Number(
    args.find((a) => a.startsWith("--port="))?.slice(7) ||
      process.env.PORT ||
      3210,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535.");
  const { server } = createApplication({
    readOnly,
    demo,
    secureCookie: process.env.COOKIE_SECURE === "true",
  });
  server.on("error", (error) => {
    console.error(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Set PORT to another local port.`
        : "Unable to start the local server.",
    );
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Grand Dunman owner portal: http://127.0.0.1:${port}`);
    console.log(
      demo
        ? "Offline demonstration. No estate requests or real bookings."
        : readOnly
          ? "Read-only mode. Login and viewing are enabled; all estate mutations are blocked."
          : "Live mode. A booking is sent only after you explicitly confirm the final review.",
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      server.close();
      server.closeIdleConnections();
    });
}
