import { AppError } from "./errors.mjs";
import { SITE_CONFIG } from "./config.mjs";
export { AppError } from "./errors.mjs";

export const API_BASE = SITE_CONFIG.apiOrigin + "/api";

// Recovered from APK modules 62cd and 9848. No arbitrary proxy paths are accepted.
export const ROUTES = Object.freeze({
  login: "/auth-service/api/login",
  units: "/home-service/unit/api/list/byOwner",
  project: "/home-service/project/find",
  facilities: "/home-service/facility/list",
  facility: "/home-service/facility/details",
  availability: "/home-service/facility/detail/list/api",
  bookings: "/home-service/booking/list",
  insertBooking: "/home-service/booking/insert",
  cancelBooking: "/home-service/booking/delete",
  createOrder: "/home-service/smartOrderInfo/createOrder",
  orders: "/home-service/smartOrderInfo/list",
  orderStatus: "/home-service/smartOrderInfo/getOrder",
});

export const WRITE_OPERATIONS = new Set([
  "insertBooking",
  "createOrder",
  "cancelBooking",
]);

function parseEstateJson(source) {
  let index = 0;
  const tokens = [];
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const invalid = () => {
    throw new SyntaxError("Invalid estate JSON response.");
  };
  const whitespace = () => {
    while (index < source.length && /[ \t\r\n]/.test(source[index])) index++;
  };
  const take = (character) => {
    whitespace();
    if (source[index] !== character) invalid();
    tokens.push(character);
    index++;
  };
  const string = () => {
    whitespace();
    if (source[index] !== '"') invalid();
    const start = index++;
    while (index < source.length) {
      const character = source[index++];
      if (character === "\\") index++;
      else if (character === '"') {
        tokens.push(source.slice(start, index));
        return;
      }
    }
    invalid();
  };
  const value = () => {
    whitespace();
    const character = source[index];
    if (character === '"') return string();
    if (character === "{" || character === "[") {
      const object = character === "{";
      const close = object ? "}" : "]";
      take(character);
      whitespace();
      if (source[index] !== close) {
        while (true) {
          if (object) {
            string();
            take(":");
          }
          value();
          whitespace();
          if (source[index] !== ",") break;
          take(",");
        }
      }
      take(close);
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        tokens.push(literal);
        index += literal.length;
        return;
      }
    }
    number.lastIndex = index;
    const match = number.exec(source);
    if (!match) invalid();
    const token = match[0];
    index = number.lastIndex;
    // Some estate DTOs emit 19-digit IDs as JSON numbers. Preserve their raw
    // integer tokens before JSON.parse can round them, including on Safari.
    tokens.push(
      !/[.eE]/.test(token) && !Number.isSafeInteger(Number(token))
        ? JSON.stringify(token)
        : token,
    );
  };
  value();
  whitespace();
  if (index !== source.length) invalid();
  // JSON.parse still validates string escapes and retains normal JSON object
  // semantics. The walker also rejects invalid unquoted object keys.
  return JSON.parse(tokens.join(""));
}

export function createUpstream({
  readOnly = false,
  fetchImpl = fetch,
  timeoutMs = 30_000,
  audit = () => {},
} = {}) {
  return async function upstream(operation, body = {}, context = {}) {
    if (!Object.hasOwn(ROUTES, operation))
      throw new AppError("Unsupported operation.", 400);
    if (readOnly && WRITE_OPERATIONS.has(operation)) {
      throw new AppError(
        "Booking submissions are disabled in this read-only server.",
        403,
        "READ_ONLY",
      );
    }
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      token: context.token || "",
      unitId: String(context.unitId ?? ""),
      userType: String(context.userType ?? ""),
    };
    audit({ operation, mutating: WRITE_OPERATIONS.has(operation) });
    let response;
    try {
      response = await fetchImpl(API_BASE + ROUTES[operation], {
        method: "POST",
        // Explicit bearer headers authenticate the estate request. Browser
        // cookies are omitted, including on CORS requests with wildcard origins.
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new AppError(
        "The estate service could not be reached. Please check your connection.",
        502,
        "UPSTREAM_UNREACHABLE",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AppError(
        "Your estate session has expired. Please sign in again.",
        401,
        "SESSION_EXPIRED",
      );
    }
    let result;
    try {
      result = parseEstateJson(await response.text());
    } catch {
      throw new AppError(
        "The estate service returned an unreadable response.",
        502,
        "UPSTREAM_RESPONSE",
      );
    }
    if (
      !result ||
      typeof result !== "object" ||
      !Object.hasOwn(result, "code")
    ) {
      throw new AppError(
        "The estate service returned an unexpected response.",
        502,
        "UPSTREAM_RESPONSE",
      );
    }
    if (Number(result.code) !== 1200) {
      const expired = [1401, 1402].includes(Number(result.code));
      throw new AppError(
        typeof result.message === "string"
          ? result.message.slice(0, 600)
          : "The estate service declined this request.",
        expired ? 401 : 422,
        expired ? "SESSION_EXPIRED" : "ESTATE_REJECTED",
      );
    }
    if (!response.ok)
      throw new AppError(
        "The estate service is temporarily unavailable.",
        502,
        "UPSTREAM_HTTP",
      );
    return result.data ?? {};
  };
}
