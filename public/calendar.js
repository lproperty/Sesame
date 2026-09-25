// A single-event iCalendar file (RFC 5545) for a facility booking, with a
// reminder an hour before. It holds only the facility, the time and the
// booking reference: no unit, account, payment or entry QR data.

export const CALENDAR_REMINDER_MINUTES = 60;

// Estate booking times are Singapore wall time unless they carry an offset.
export function bookingInstant(value) {
  const time = String(value || "")
    .replace(" ", "T")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time)) return NaN;
  return Date.parse(
    time + (/(?:Z|[+-]\d{2}:\d{2})$/.test(time) ? "" : "+08:00"),
  );
}

const utc = (time) =>
  new Date(time)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const text = (value) =>
  String(value)
    .replace(/[\\;,]/g, (character) => "\\" + character)
    .replace(/\r?\n/g, "\\n");

// Content lines longer than 75 octets continue on lines starting with a space.
function fold(line) {
  const encoder = new TextEncoder();
  const lines = [];
  let current = "";
  let size = 0;
  for (const character of line) {
    const length = encoder.encode(character).length;
    if (size + length > (lines.length ? 74 : 75)) {
      lines.push(current);
      current = "";
      size = 0;
    }
    current += character;
    size += length;
  }
  lines.push(current);
  return lines.join("\r\n ");
}

export function bookingCalendar(booking, { now = Date.now() } = {}) {
  const start = bookingInstant(booking?.startTime);
  const end = bookingInstant(booking?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new Error("This booking has no valid time to add to a calendar.");
  const id = String(booking.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  const title = String(booking.facilityName || "Facility booking");
  const notes = [
    id ? `Booking reference ${id}` : "",
    booking.tab === "unpaid"
      ? "Payment pending. Check My bookings in Sesame for its status."
      : "",
  ].filter(Boolean);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sesame//Resident portal//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:sesame-booking-${id || utc(start)}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${text(title)}`,
    ...(notes.length ? [`DESCRIPTION:${text(notes.join("\n"))}`] : []),
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${text(title)}`,
    `TRIGGER:-PT${CALENDAR_REMINDER_MINUTES}M`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export function calendarFileName(booking) {
  const name =
    String(booking?.facilityName || "booking")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "booking";
  const date = String(booking?.startTime || "").slice(0, 10);
  return `sesame-${name}${/^\d{4}-\d{2}-\d{2}$/.test(date) ? "-" + date : ""}.ics`;
}
