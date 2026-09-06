import { OwnerPortal } from "../lib/portal.mjs";
import { createUpstream, AppError } from "../lib/upstream.mjs";

const SESSION_TTL = 12 * 60 * 60_000;
const SESSION_IDLE = 2 * 60 * 60_000;

// This facade stays inside the page. Only createUpstream contacts the estate's
// fixed HTTPS API; /api/... below is an internal route, never a GitHub request.
// No password/token is saved to cookies, storage, URLs, HTML or logs.
export function createLiveRequest({
  fetchImpl = fetch,
  now = Date.now,
  readOnly = false,
  payment,
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
  const forget = () => {
    if (session) session.token = "";
    session = null;
    epoch++;
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
  return request;
}
