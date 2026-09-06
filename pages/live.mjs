import { OwnerPortal } from "../lib/portal.mjs";
import { createUpstream, AppError, API_BASE } from "../lib/upstream.mjs";
import { identifier, normalizeUnit, requiredString } from "../lib/model.mjs";

const SESSION_TTL = 12 * 60 * 60_000;
const SESSION_IDLE = 2 * 60 * 60_000;
export const SESSION_STORAGE_KEY = "sesame-owner-session-v1";

function browserSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

// This facade stays inside the page. Only createUpstream contacts the estate's
// fixed HTTPS API; /api/... below is an internal route, never a GitHub request.
// Tab-scoped sessionStorage keeps sign-in across reloads. Passwords are never
// stored, and the bearer token is never included in UI responses or logs.
export function createLiveRequest({
  fetchImpl = fetch,
  now = Date.now,
  readOnly = false,
  payment,
  storage = browserSessionStorage(),
} = {}) {
  const portal = new OwnerPortal({
    upstream: createUpstream({ fetchImpl, readOnly }),
    now,
    readOnly,
    payment,
  });
  let session = null;
  let epoch = 0;
  let signingIn = false;
  let mutationCount = 0;
  let loginAttempts = [];
  const configuration = () => ({
    ...portal.configuration(),
    browserClient: true,
  });
  const sessionView = () => ({
    ...portal.sessionView(session),
    browserClient: true,
  });
  const clearSavedSession = () => {
    try {
      storage?.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Browsers can deny storage; in-memory sign-in must still work.
    }
  };
  const saveSession = () => {
    if (!session) return;
    try {
      storage?.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          version: 1,
          apiBase: API_BASE,
          token: session.token,
          user: { id: session.user.id, name: session.user.name },
          units: session.units.map(normalizeUnit),
          unitId: session.unit?.unitId ?? null,
          projectId: session.unit?.projectId ?? null,
          expiresAt: session.expiresAt,
          lastSeen: session.lastSeen,
        }),
      );
    } catch {
      clearSavedSession();
    }
  };
  const restoreSession = () => {
    try {
      const saved = storage?.getItem(SESSION_STORAGE_KEY);
      if (!saved) return;
      if (saved.length > 64_000) throw new Error("Invalid saved session.");
      const record = JSON.parse(saved);
      const time = now();
      if (
        record?.version !== 1 ||
        record.apiBase !== API_BASE ||
        !Number.isFinite(record.expiresAt) ||
        !Number.isFinite(record.lastSeen) ||
        record.expiresAt <= time ||
        record.expiresAt > time + SESSION_TTL ||
        record.lastSeen > time ||
        record.lastSeen + SESSION_IDLE <= time ||
        !Array.isArray(record.units) ||
        record.units.length > 100 ||
        record.units.some((unit) => unit?.userType !== 0)
      )
        throw new Error("Invalid or expired saved session.");
      const units = record.units.map(normalizeUnit);
      const unit =
        record.unitId === null && record.projectId === null
          ? null
          : units.find(
              (candidate) =>
                candidate.unitId === record.unitId &&
                candidate.projectId === record.projectId,
            );
      if (unit === undefined || (!unit && units.length))
        throw new Error("Invalid saved unit.");
      session = {
        token: requiredString(record.token, "session token", 16_000),
        user: {
          id: identifier(record.user?.id, "owner"),
          name: requiredString(record.user?.name, "owner name"),
        },
        units,
        unit,
        csrf: crypto.randomUUID(),
        expiresAt: record.expiresAt,
        lastSeen: record.lastSeen,
        // Re-read booking data after reload; never replay saved submissions.
        quotes: new Map(),
        facilities: new Map(),
      };
    } catch {
      session = null;
      clearSavedSession();
    }
  };
  const dropSession = () => {
    if (session) session.token = "";
    session = null;
    epoch++;
  };
  const forget = () => {
    clearSavedSession();
    dropSession();
  };
  const requireSession = () => {
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
      forget();
      throw new AppError(
        "Your session has expired. Please sign in again.",
        401,
        "SESSION_EXPIRED",
      );
    }
    session.lastSeen = now();
    saveSession();
    return session;
  };
  const noMutationInProgress = () => {
    if (mutationCount)
      throw new AppError(
        "Wait for the current submission to finish.",
        409,
        "SUBMISSION_IN_PROGRESS",
      );
  };
  const mutation = async (callback) => {
    mutationCount++;
    try {
      return await callback();
    } finally {
      mutationCount--;
    }
  };
  const route = async (path, init) => {
    if (typeof path !== "string" || !path.startsWith("/api/"))
      throw new AppError(
        "Unsupported application request.",
        403,
        "ROUTE_NOT_ALLOWED",
      );
    const url = new URL(path, "https://sesame.invalid");
    if (
      url.origin !== "https://sesame.invalid" ||
      !url.pathname.startsWith("/api/")
    )
      throw new AppError(
        "Unsupported application request.",
        403,
        "ROUTE_NOT_ALLOWED",
      );
    const method = init.method || "GET";
    if (!["GET", "POST"].includes(method))
      throw new AppError("Method not allowed.", 405);
    const headers = new Headers(init.headers);
    let body;
    if (method === "POST") {
      if (
        !headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new AppError("Use JSON for this request.", 415);
      if (typeof init.body !== "string" || init.body.length > 16_384)
        throw new AppError("Request is too large or invalid.", 413);
      try {
        body = JSON.parse(init.body);
      } catch {
        throw new AppError("Invalid JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new AppError("Expected a JSON object.");
    }
    const action = `${method} ${url.pathname}`;
    if (action === "GET /api/config") return configuration();
    if (action === "POST /api/login") {
      noMutationInProgress();
      if (signingIn) throw new AppError("Sign-in is already in progress.", 409);
      loginAttempts = loginAttempts.filter(
        (time) => time > now() - 15 * 60_000,
      );
      if (loginAttempts.length >= 10)
        throw new AppError(
          "Too many attempts. Wait 15 minutes before trying again.",
          429,
          "LOGIN_COOLDOWN",
        );
      loginAttempts.push(now());
      signingIn = true;
      const loginEpoch = ++epoch;
      try {
        const result = await portal.login(body);
        if (loginEpoch !== epoch) {
          result.token = "";
          throw new AppError("Sign-in was interrupted. Please try again.", 409);
        }
        if (session) session.token = "";
        session = Object.assign(result, {
          expiresAt: now() + SESSION_TTL,
          lastSeen: now(),
        });
        loginAttempts = [];
        clearSavedSession();
        saveSession();
        return sessionView();
      } finally {
        body.cipher = "";
        signingIn = false;
      }
    }
    const active = requireSession();
    if (action === "GET /api/session") return sessionView();
    if (method === "POST" && headers.get("x-csrf-token") !== active.csrf)
      throw new AppError(
        "Refresh the page and sign in again.",
        403,
        "CSRF_INVALID",
      );
    if (action === "POST /api/logout") {
      noMutationInProgress();
      forget();
      return { signedOut: true };
    }
    if (action === "POST /api/unit") {
      noMutationInProgress();
      portal.switchUnit(active, body.unitId);
      saveSession();
      return sessionView();
    }
    if (action === "GET /api/facilities") return portal.facilities(active);
    const availability =
      /^\/api\/facilities\/([a-zA-Z0-9_-]+)\/availability$/.exec(url.pathname);
    if (method === "GET" && availability)
      return portal.availability(
        active,
        availability[1],
        url.searchParams.get("date"),
      );
    const facility = /^\/api\/facilities\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (method === "GET" && facility)
      return portal.facility(active, facility[1]);
    if (action === "GET /api/bookings")
      return portal.bookings(active, url.searchParams.get("tab") || "current");
    if (action === "POST /api/bookings")
      return mutation(() => portal.book(active, body));
    if (action === "POST /api/bookings/preview")
      return portal.preview(active, body);
    if (action === "POST /api/bookings/commit")
      return mutation(() => portal.commit(active, body));
    const reservation =
      /^\/api\/bookings\/([a-zA-Z0-9_-]+)\/(payment|cancel)$/.exec(
        url.pathname,
      );
    if (reservation) {
      if (method === "GET" && reservation[2] === "payment")
        return portal.bookingPayment(active, reservation[1]);
      if (method === "POST" && reservation[2] === "payment")
        return mutation(() =>
          portal.resumePayment(active, reservation[1], body),
        );
      if (method === "POST" && reservation[2] === "cancel")
        return mutation(() =>
          portal.cancelReservation(active, reservation[1], body),
        );
    }
    const payment = /^\/api\/payments\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (method === "GET" && payment)
      return portal.paymentStatus(active, payment[1]);
    throw new AppError("That page or action was not found.", 404, "NOT_FOUND");
  };
  const request = async (path, init = {}) => {
    const requestEpoch = epoch;
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    try {
      const value = await route(path, init);
      if (
        requestEpoch !== epoch &&
        !["/api/login", "/api/logout"].includes(path)
      )
        throw new AppError(
          "Your session changed. Try the current view again.",
          409,
          "SESSION_CHANGED",
        );
      return json(value);
    } catch (error) {
      if (
        requestEpoch !== epoch &&
        session &&
        !["/api/login", "/api/logout"].includes(path)
      )
        return json(
          {
            error: {
              code: "SESSION_CHANGED",
              message: "Your session changed. Try the current view again.",
            },
          },
          409,
        );
      if (error.code === "SESSION_EXPIRED" && requestEpoch === epoch) forget();
      return json(
        {
          error: {
            code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
            message:
              error instanceof AppError
                ? error.message
                : "Something went wrong. Please try again.",
            ...(error instanceof AppError && error.details
              ? { details: error.details }
              : {}),
          },
        },
        error instanceof AppError ? error.status : 500,
      );
    }
  };
  request.dispose = forget;
  request.suspend = () => {
    saveSession();
    dropSession();
  };
  restoreSession();
  return request;
}
