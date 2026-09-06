import { AppError } from "./errors.mjs";
import { SITE_CONFIG } from "./config.mjs";

export const TIME_ZONE = "Asia/Singapore";
// The live facility regulations specify four weeks in advance.
export const BOOKING_WINDOW_DAYS = 28;
export const QUOTE_TTL_MS = 5 * 60_000;

export function singaporeDate(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

export function addDays(date, days) {
  const value = new Date(date + "T00:00:00Z");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function bookingWindow(now = Date.now()) {
  const today = singaporeDate(now);
  return {
    today,
    lastDate: addDays(today, BOOKING_WINDOW_DAYS),
    timeZone: TIME_ZONE,
  };
}

export function validateDate(date, now = Date.now()) {
  const range = bookingWindow(now);
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    date < range.today ||
    date > range.lastDate
  ) {
    throw new AppError(
      "Choose a date within the next four weeks.",
      400,
      "INVALID_DATE",
    );
  }
  return date;
}

export function requiredString(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new AppError(`Enter a valid ${label}.`);
  }
  return value.trim();
}

export function identifier(value, label = "ID") {
  // Estate IDs are 19-digit strings. Never coerce them to floating-point numbers.
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new AppError(`Invalid ${label}.`, 400);
  }
  if (
    !["string", "number"].includes(typeof value) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(String(value))
  ) {
    throw new AppError(`Invalid ${label}.`, 400);
  }
  return String(value);
}

export function cents(value) {
  if (
    value == null ||
    value === "" ||
    !["string", "number"].includes(typeof value)
  )
    return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) return null;
  return Math.round(amount * 100);
}

export function safeImage(value) {
  if (typeof value !== "string") return "";
  if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.origin === SITE_CONFIG.apiOrigin &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    )
      return url.href;
  } catch {
    /* Missing or unsupported image URL. */
  }
  return "";
}

export function normalizeUnit(unit) {
  return {
    unitId: identifier(unit.unitId, "unit"),
    projectId: identifier(unit.projectId, "project"),
    unitName: String(unit.unitName ?? ""),
    buildingName: String(unit.buildingName ?? ""),
    projectName: String(unit.projectName || "Your estate"),
    userType: 0,
  };
}

export function categoryFor(name) {
  if (/tennis|golf|game/i.test(name)) return "Sport & play";
  if (/bbq|pavilion/i.test(name)) return "Outdoor dining";
  if (/karaoke|music/i.test(name)) return "Entertainment";
  return "Gathering spaces";
}

export function normalizeFacility(facility) {
  const name = String(facility.name || "Facility");
  return {
    id: identifier(facility.id, "facility"),
    name,
    category: categoryFor(name),
    image: safeImage(facility.backgroundImageUrl),
    introduction: String(facility.introduction || ""),
    regulations: String(facility.regulations || ""),
    indicativePrice: cents(facility.pricing),
    openingHours: String(facility.openTimeRange || ""),
    perOrderNum: Math.max(1, Math.floor(Number(facility.perOrderNum) || 1)),
    phone: String(facility.inquiryTelephone || ""),
  };
}

export function normalizeNotice(value) {
  return { show: Boolean(value?.show), text: String(value?.notice || "") };
}

function nonnegativeInteger(value) {
  if (
    value == null ||
    value === "" ||
    !["string", "number"].includes(typeof value)
  )
    return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function estateFlag(value) {
  if ([true, 1, "1", "true"].includes(value)) return true;
  if ([false, 0, "0", "false"].includes(value)) return false;
  return null;
}

function estateTimestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(
      value,
    )
    ? value
    : null;
}

function bookingTimestamp(value) {
  if (typeof value !== "string") return "";
  const match =
    /^(\d{4})([.-])(\d{2})\2(\d{2})([T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)$/.exec(
      value,
    );
  if (!match) return "";
  const date = `${match[1]}-${match[3]}-${match[4]}`;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== date
  )
    return "";
  // Native bookings use dotted dates. Keep the estate's wall time and any
  // supplied offset intact rather than shifting the booking across dates.
  return date + match[5];
}

export function normalizeSlot(slot, facility, now = Date.now()) {
  const date = String(slot.date || "").slice(0, 10);
  const startTime = String(slot.startTime || "").slice(0, 5);
  const endTime = String(slot.endTime || "").slice(0, 5);
  const startAt = Date.parse(`${date}T${startTime}:00+08:00`);
  const validTime =
    /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(endTime);
  const remaining =
    slot.remainingNum == null ? null : Number(slot.remainingNum);
  const candidates = [
    Number(facility.perOrderNum),
    remaining,
    Number(slot.num),
  ].filter((n) => Number.isFinite(n) && n > 0);
  const maxQuantity = Math.min(...candidates, 99);
  const price = cents(slot.pricing);
  let reason = "";
  if (Number(slot.status ?? 1) === 0) reason = "Unavailable";
  else if (!validTime || !Number.isFinite(startAt)) reason = "Time unavailable";
  else if (startAt <= now) reason = "Session has started";
  else if (Number(slot.ordered) === 1) reason = "Already booked";
  else if (
    slot.reservation === false ||
    slot.reservation === "false" ||
    slot.reservation === 0
  )
    reason = "Not available";
  else if (
    remaining !== null &&
    (!Number.isFinite(remaining) || remaining <= 0)
  )
    reason = "Fully booked";
  else if (price === null) reason = "Price unavailable";
  const capacity = nonnegativeInteger(slot.num);
  const remainingCapacity = nonnegativeInteger(slot.remainingNum);
  return {
    id: identifier(slot.id, "time slot"),
    date,
    startTime,
    endTime,
    price,
    remaining,
    maxQuantity: Math.max(1, Math.floor(maxQuantity)),
    enabled: !reason,
    reason,
    details: {
      capacity,
      remainingCapacity,
      unavailableCapacity:
        capacity !== null &&
        remainingCapacity !== null &&
        remainingCapacity <= capacity
          ? capacity - remainingCapacity
          : null,
      bookingFlag: estateFlag(slot.ordered),
      reservationAllowed: estateFlag(slot.reservation),
      scheduleEnabled: estateFlag(slot.status),
      scheduleCreatedAt: estateTimestamp(slot.gmtCreate),
      scheduleUpdatedAt: estateTimestamp(slot.gmtModified),
    },
  };
}

export function normalizeBooking(record, tab) {
  return {
    id: identifier(record.id, "booking"),
    facilityId: record.facilityId == null ? "" : String(record.facilityId),
    facilityDetailId:
      record.facilityDetailId == null ? "" : String(record.facilityDetailId),
    facilityName: String(
      record.facilityName || record.goodsDetail || "Facility booking",
    ),
    startTime: bookingTimestamp(record.startTime),
    endTime: bookingTimestamp(record.endTime),
    quantity: Number(record.bookingNum) || 1,
    amount: cents(record.paidTotal ?? record.totalpricing),
    price: cents(record.pricing),
    orderNo: String(record.orderNo || ""),
    countDown:
      record.countDown == null
        ? null
        : Math.max(0, Number(record.countDown) || 0),
    tab,
    createdAt: estateTimestamp(record.gmtCreate),
    updatedAt: estateTimestamp(record.gmtModified),
  };
}
