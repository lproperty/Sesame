import test from "node:test";
import assert from "node:assert/strict";
import {
  bookingCalendar,
  bookingInstant,
  calendarFileName,
} from "../public/calendar.js";

const NOW = Date.parse("2026-09-05T08:00:00Z");

const unfold = (ics) => ics.replace(/\r\n /g, "");
const field = (ics, name) =>
  unfold(ics)
    .split("\r\n")
    .find((line) => line.startsWith(name + ":"))
    ?.slice(name.length + 1);

test("Singapore booking times become UTC calendar times with a reminder", () => {
  const ics = bookingCalendar(
    {
      id: "1234567890123456789",
      facilityName: "Tennis Court (Off-Peak)",
      startTime: "2026-09-06 09:00:00",
      endTime: "2026-09-06 10:00:00",
      tab: "current",
    },
    { now: NOW },
  );
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.doesNotMatch(
    ics.replace(/\r\n/g, ""),
    /\n/,
    "every line ends in CRLF",
  );
  assert.equal(field(ics, "DTSTART"), "20260906T010000Z");
  assert.equal(field(ics, "DTEND"), "20260906T020000Z");
  assert.equal(field(ics, "DTSTAMP"), "20260905T080000Z");
  assert.equal(field(ics, "UID"), "sesame-booking-1234567890123456789");
  assert.equal(field(ics, "SUMMARY"), "Tennis Court (Off-Peak)");
  assert.equal(
    field(ics, "DESCRIPTION"),
    "Booking reference 1234567890123456789",
  );
  assert.equal(field(ics, "TRIGGER"), "-PT60M");
  assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY\r\n/);
});

test("explicit offsets, missing seconds and pending notes are handled", () => {
  assert.equal(
    bookingInstant("2026-09-06T09:00:00+0800"),
    Date.parse("2026-09-06T01:00:00Z"),
  );
  assert.equal(
    bookingInstant("2026-09-06T01:00:00Z"),
    Date.parse("2026-09-06T01:00:00Z"),
  );
  assert.equal(
    bookingInstant("2026-09-06 17:00"),
    Date.parse("2026-09-06T09:00:00Z"),
  );
  assert.ok(Number.isNaN(bookingInstant("")));
  assert.ok(Number.isNaN(bookingInstant("tomorrow")));
  const ics = bookingCalendar(
    {
      id: "pending-1",
      facilityName: "Room",
      startTime: "2026-09-06 17:00:00",
      endTime: "2026-09-06 22:00:00",
      tab: "unpaid",
    },
    { now: NOW },
  );
  assert.equal(
    field(ics, "DESCRIPTION"),
    "Booking reference pending-1\\nPayment pending. Check My bookings in Sesame for its status.",
  );
});

test("calendar text is escaped and long lines are folded at 75 octets", () => {
  const name = "BBQ Pavilion; Garden, Level 2 \\ East — " + "é".repeat(40);
  const ics = bookingCalendar(
    {
      id: "x<y>",
      facilityName: name,
      startTime: "2026-09-06 17:00:00",
      endTime: "2026-09-06 22:00:00",
    },
    { now: NOW },
  );
  const encoder = new TextEncoder();
  for (const line of ics.split("\r\n"))
    assert.ok(encoder.encode(line).length <= 75, `folded: ${line}`);
  assert.equal(
    field(ics, "SUMMARY"),
    "BBQ Pavilion\\; Garden\\, Level 2 \\\\ East — " + "é".repeat(40),
  );
  assert.equal(
    field(ics, "UID"),
    "sesame-booking-xy",
    "IDs are reduced to safe characters",
  );
});

test("bookings without a valid time cannot be exported", () => {
  for (const [startTime, endTime] of [
    ["", "2026-09-06 10:00:00"],
    ["2026-09-06 10:00:00", "2026-09-06 09:00:00"],
    ["not a date", "also not"],
  ])
    assert.throws(
      () => bookingCalendar({ id: "1", startTime, endTime }, { now: NOW }),
      /no valid time/,
    );
});

test("calendar file names are short and safe", () => {
  assert.equal(
    calendarFileName({
      facilityName: "Tennis Court (Off-Peak)",
      startTime: "2026-09-06 09:00:00",
    }),
    "sesame-tennis-court-off-peak-2026-09-06.ics",
  );
  assert.equal(
    calendarFileName({ facilityName: "../../" }),
    "sesame-booking.ics",
  );
});
