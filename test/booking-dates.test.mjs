import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBooking } from "../lib/model.mjs";

function booking(startTime, endTime = startTime, tab = "unpaid") {
  return normalizeBooking({ id: "booking-date-test", startTime, endTime }, tab);
}

test("native dotted pending booking dates retain their Singapore session time", () => {
  const result = booking("2026.09.11 19:00", "2026.09.11 20:00");
  assert.equal(result.startTime, "2026-09-11 19:00");
  assert.equal(result.endTime, "2026-09-11 20:00");
  assert.equal(result.tab, "unpaid");
  assert.equal(
    new Intl.DateTimeFormat("en-SG", {
      timeZone: "Asia/Singapore",
      weekday: "long",
    }).format(new Date(`${result.startTime.slice(0, 10)}T12:00:00+08:00`)),
    "Friday",
  );
});

test("booking date normalization does not move midnight into the previous day", () => {
  const result = booking(
    "2026.10.01T00:00:00+08:00",
    "2026.10.01T01:00:00+08:00",
    "current",
  );
  assert.equal(result.startTime, "2026-10-01T00:00:00+08:00");
  assert.equal(result.endTime, "2026-10-01T01:00:00+08:00");
});

test("existing hyphen booking datetime formats are preserved", () => {
  for (const value of [
    "2026-09-11 19:00",
    "2026-09-11 19:00:00",
    "2026-09-11T19:00:00",
    "2026-09-11T19:00:00.123Z",
    "2026-09-11T19:00:00+08:00",
    "2026-09-11T19:00:00+0800",
  ]) {
    const result = booking(value, value, "history");
    assert.equal(result.startTime, value);
    assert.equal(result.endTime, value);
  }
});

test("impossible or malformed booking datetimes become safe empty values", () => {
  for (const value of [
    undefined,
    null,
    0,
    {},
    "",
    "not a date",
    "2026.09-11 19:00",
    "2026.02.29 19:00",
    "2026-04-31 19:00",
    "2026-13-01 19:00",
    "2026-09-00 19:00",
    "2026-09-11 24:00",
    "2026-09-11 19:60",
    "2026-09-11 19:00:60",
    "2026-09-11T19:00:00+08:60",
  ]) {
    const result = booking(value);
    assert.equal(result.startTime, "", `start: ${String(value)}`);
    assert.equal(result.endTime, "", `end: ${String(value)}`);
  }
  assert.equal(booking("2028.02.29 19:00").startTime, "2028-02-29 19:00");
});
