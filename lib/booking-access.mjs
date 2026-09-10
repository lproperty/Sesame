import { SITE_CONFIG, normalizeSiteConfig } from "./config.mjs";
import { AppError } from "./errors.mjs";
import { identifier } from "./model.mjs";

const PNG_PREFIX = "data:image/png;base64,";
const MAX_IMAGES = 16;
const MAX_IMAGE_LENGTH = 1_048_576;
const MAX_TOTAL_LENGTH = 4_194_304;

function invalidImages() {
  return new AppError(
    "The estate returned an unreadable booking entry code. Please try again.",
    502,
    "UPSTREAM_RESPONSE",
  );
}

function validPng(source) {
  const encoded = source.slice(PNG_PREFIX.length);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    return false;
  let bytes;
  try {
    // atob/btoa are available in browsers and Node; this module ships to both.
    bytes = atob(encoded);
    if (btoa(bytes) !== encoded) return false;
  } catch {
    return false;
  }
  if (
    bytes.length < 45 ||
    bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
    bytes.slice(8, 16) !== "\x00\x00\x00\x0dIHDR" ||
    bytes.slice(-12) !== "\x00\x00\x00\x00IEND\xae\x42\x60\x82"
  )
    return false;
  const uint32 = (offset) =>
    bytes.charCodeAt(offset) * 16_777_216 +
    bytes.charCodeAt(offset + 1) * 65_536 +
    bytes.charCodeAt(offset + 2) * 256 +
    bytes.charCodeAt(offset + 3);
  const width = uint32(16);
  const height = uint32(20);
  return width > 0 && height > 0 && width <= 2048 && height <= 2048;
}

function validImageSource(source, apiOrigin) {
  if (source.startsWith(PNG_PREFIX)) return validPng(source);
  if (
    source.length > 8192 ||
    !source.startsWith("https://") ||
    /[\u0000-\u0020<>"'\\]/.test(source)
  )
    return false;
  try {
    const url = new URL(source);
    return (
      url.protocol === "https:" &&
      url.origin === apiOrigin &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

// Native booking access receives an array of image sources. These are already
// server-issued codes: never encode them as new QR text or derive resident IDs.
export function normalizeBookingAccessImages(
  raw,
  { apiOrigin = SITE_CONFIG.apiOrigin } = {},
) {
  const origin = normalizeSiteConfig({ apiOrigin }).apiOrigin;
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) throw invalidImages();
  let totalLength = 0;
  const images = [];
  for (const source of raw) {
    if (typeof source !== "string") throw invalidImages();
    totalLength += source.length;
    if (
      !source.length ||
      source.length > MAX_IMAGE_LENGTH ||
      totalLength > MAX_TOTAL_LENGTH ||
      !validImageSource(source, origin)
    )
      throw invalidImages();
    images.push({ src: source, label: `Entry code ${images.length + 1}` });
  }
  return images;
}

export function normalizeBookingQrRefreshMs(config) {
  const value = config?.value;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))
  )
    return 10_000;
  const seconds = Number(value);
  // Bounds prevent a bad configuration from creating a tight request loop or
  // leaving a displayed code without refresh for an unreasonable duration.
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 3600
    ? Math.round(seconds * 1000)
    : 10_000;
}

// The caller first resolves bookingId from the selected unit's current records.
// This helper only reads codes; it neither persists them nor manages UI timers.
export async function loadBookingAccess({
  upstream,
  context,
  bookingId,
  now = Date.now,
}) {
  if (typeof context?.token !== "string" || !context.token)
    throw new AppError(
      "Sign in again to show your booking entry code.",
      401,
      "SESSION_EXPIRED",
    );
  const id = identifier(bookingId, "booking");
  const scoped = {
    token: context.token,
    unitId: identifier(context.unitId, "unit"),
    userType: context.userType,
  };
  let config;
  try {
    config = await upstream("qrConfig", { code: "001" }, { ...scoped });
  } catch (error) {
    if (error?.code === "SESSION_EXPIRED") throw error;
    // QR availability does not depend on a successful optional config read.
  }
  const raw = await upstream(
    "bookingQr",
    { unitId: scoped.unitId, bookingId: id },
    { ...scoped },
  );
  const images = normalizeBookingAccessImages(raw);
  const updatedAt = typeof now === "function" ? now() : now;
  if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0)
    throw new AppError(
      "The device clock is unavailable.",
      503,
      "CLOCK_UNAVAILABLE",
    );
  return {
    images,
    refreshMs: normalizeBookingQrRefreshMs(config),
    updatedAt,
  };
}
