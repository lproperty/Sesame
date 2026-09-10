import { OwnerPortal } from "../lib/portal.mjs";
import { createUpstream, AppError, API_BASE } from "../lib/upstream.mjs";
import { identifier, normalizeUnit, requiredString } from "../lib/model.mjs";

export const SESSION_STORAGE_KEY = "sesame-owner-session-v2";
export const LEGACY_SESSION_STORAGE_KEY = "sesame-owner-session-v1";

function browserStorage(name) {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

// Keep only the issued estate session, never the password. The durable record
// survives closing a tab/app; estate authentication remains authoritative.
export function createLiveRequest({
  fetchImpl = fetch,
  now = Date.now,
  readOnly = false,
  payment,
  storage = browserStorage("localStorage"),
  legacyStorage = browserStorage("sessionStorage"),
  eventTarget = globalThis,
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
  let storageUnavailable = !storage;
  const configuration = () => ({
    ...portal.configuration(),
    browserClient: true,
  });
  const sessionView = () => ({
    ...portal.sessionView(session),
    browserClient: true,
    loginPersistence:
      session?.persisted && !storageUnavailable ? "device" : "memory",
  });
  const readSaved = () => {
    try {
      const value = storage?.getItem(SESSION_STORAGE_KEY) ?? null;
      storageUnavailable = !storage;
      return value;
    } catch {
      storageUnavailable = true;
      return undefined;
    }
  };
  const parseSaved = (value) => {
    try {
      return typeof value === "string" && value.length <= 64_000
        ? JSON.parse(value)
        : null;
    } catch {
      return null;
    }
  };
  const clearLegacy = () => {
    try {
      legacyStorage?.removeItem(LEGACY_SESSION_STORAGE_KEY);
    } catch {}
  };
  const isSameLogin = (record) =>
    record?.version === 2 &&
    record.apiBase === API_BASE &&
    !record.signedOut &&
    record.sessionId === session?.rememberId &&
    record.token === session?.token;
  const markSignedOut = (expectedRaw) => {
    if (readSaved() !== expectedRaw) return;
    try {
      // A credential-free tombstone stops an old tab's v1 login from being
      // migrated back after explicit logout or estate invalidation.
      storage?.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({ version: 2, apiBase: API_BASE, signedOut: true }),
      );
    } catch {
      // Quota failures can prevent writes while still allowing removal. Do
      // not leave an older account as the apparent saved login after a switch.
      try {
        if (readSaved() === expectedRaw)
          storage?.removeItem(SESSION_STORAGE_KEY);
      } catch {}
      storageUnavailable = true;
    }
    clearLegacy();
  };
  const saveSession = ({ force = false, expectedRaw } = {}) => {
    if (!session) return false;
    const current = readSaved();
    if (
      force
        ? current !== expectedRaw
        : current !== undefined && !isSameLogin(parseSaved(current))
    )
      return false;
    try {
      if (!storage) return false;
      storage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({
          version: 2,
          apiBase: API_BASE,
          sessionId: session.rememberId,
          token: session.token,
          user: { id: session.user.id, name: session.user.name },
          units: session.units.map(normalizeUnit),
          unitId: session.unit?.unitId ?? null,
          projectId: session.unit?.projectId ?? null,
        }),
      );
      session.persisted = true;
      storageUnavailable = false;
      clearLegacy();
      return true;
    } catch {
      storageUnavailable = true;
      return false;
    }
  };
  const dropSession = () => {
    if (session) session.token = "";
    session = null;
    epoch++;
  };
  const forget = () => {
    const current = readSaved();
    // A delayed 401/disposal from one tab must not erase another tab's login.
    if (
      session &&
      (current === undefined ||
        isSameLogin(parseSaved(current)) ||
        (!session.persisted &&
          (current === null || current === session.replacedSnapshot)))
    )
      markSignedOut(current);
    clearLegacy();
    dropSession();
  };
  const synchronizeLogin = (notify = false) => {
    if (!session?.persisted) return true;
    const current = readSaved();
    if (current === undefined || isSameLogin(parseSaved(current))) return true;
    dropSession();
    clearLegacy();
    if (notify) {
      try {
        const EventType = eventTarget.Event || globalThis.Event;
        eventTarget.dispatchEvent?.(new EventType("sesame-session-ended"));
      } catch {}
    }
    return false;
  };
  const hydrate = (record, legacy = false) => {
    if (
      !record ||
      record.apiBase !== API_BASE ||
      record.signedOut ||
      record.version !== (legacy ? 1 : 2) ||
      !Array.isArray(record.units) ||
      record.units.length > 100 ||
      record.units.some((unit) => unit?.userType !== 0)
    )
      throw new Error("Invalid saved session.");
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
    return {
      token: requiredString(record.token, "session token", 16_000),
      rememberId: legacy
        ? crypto.randomUUID()
        : identifier(record.sessionId, "saved login"),
      user: {
        id: identifier(record.user?.id, "owner"),
        name: requiredString(record.user?.name, "owner name"),
      },
      units,
      unit,
      csrf: crypto.randomUUID(),
      persisted: !legacy,
      // Closing/reopening never replays submissions or restores stale quotes.
      quotes: new Map(),
      facilities: new Map(),
    };
  };
  const restoreSession = () => {
    const current = readSaved();
    if (current != null) {
      const record = parseSaved(current);
      if (record?.signedOut) {
        clearLegacy();
        return;
      }
      try {
        session = hydrate(record);
        clearLegacy();
      } catch {
        markSignedOut(current);
      }
      return;
    }
    let legacy;
    try {
      legacy = legacyStorage?.getItem(LEGACY_SESSION_STORAGE_KEY);
    } catch {}
    if (!legacy) return;
    try {
      // The old 2h/12h fields were Sesame timers, not estate expiry metadata.
      // Migrate the existing token and let the estate decide whether it is valid.
      session = hydrate(parseSaved(legacy), true);
      if (
        !saveSession({ force: true, expectedRaw: current }) &&
        readSaved() !== current
      )
        dropSession();
    } catch {
      clearLegacy();
    }
  };
  const requireSession = () => {
    synchronizeLogin();
    if (!session)
      throw new AppError(
        "Sign in to your owner account to continue.",
        401,
        "SIGN_IN_REQUIRED",
      );
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
      const loginSnapshot = readSaved();
      const loginEpoch = ++epoch;
      try {
        const result = await portal.login(body);
        if (loginEpoch !== epoch || readSaved() !== loginSnapshot) {
          result.token = "";
          throw new AppError("Sign-in was interrupted. Please try again.", 409);
        }
        if (session) session.token = "";
        session = Object.assign(result, {
          rememberId: crypto.randomUUID(),
          persisted: false,
        });
        loginAttempts = [];
        if (!saveSession({ force: true, expectedRaw: loginSnapshot })) {
          session.replacedSnapshot = loginSnapshot;
          markSignedOut(loginSnapshot);
        }
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
      /^\/api\/bookings\/([a-zA-Z0-9_-]+)\/(payment|cancel|qr)$/.exec(
        url.pathname,
      );
    if (reservation) {
      if (method === "GET" && reservation[2] === "qr")
        return portal.bookingAccess(active, reservation[1]);
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
      if (!["/api/login", "/api/logout"].includes(path)) synchronizeLogin();
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
  const onStorage = (event) => {
    if (event.key != null && event.key !== SESSION_STORAGE_KEY) return;
    if (event.storageArea && event.storageArea !== storage) return;
    synchronizeLogin(true);
  };
  eventTarget.addEventListener?.("storage", onStorage);
  const detach = () => eventTarget.removeEventListener?.("storage", onStorage);
  request.dispose = () => {
    detach();
    forget();
  };
  // The durable record was saved on login/unit choice. A closing stale tab
  // must never write an old token back over logout or another account.
  request.suspend = () => {
    detach();
    dropSession();
  };
  restoreSession();
  return request;
}
