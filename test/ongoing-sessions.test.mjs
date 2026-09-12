import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSlot } from "../lib/model.mjs";
import { OwnerPortal } from "../lib/portal.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";
import { WRITE_OPERATIONS } from "../lib/upstream.mjs";

const DATE = "2026-09-12";
const START = Date.parse(`${DATE}T09:00:00+08:00`);
const END = Date.parse(`${DATE}T10:00:00+08:00`);
const slot = {
  id: "slot", date: DATE, startTime: "09:00", endTime: "10:00",
  pricing: 5, num: 1, status: 1, ordered: 0, remainingNum: 1, reservation: true,
};

test("available sessions can be booked from their start until just before their end", () => {
  for (const [now, enabled, inProgress] of [
    [START - 1, true, false], [START, true, true],
    [START + 30 * 60_000, true, true], [END - 1, true, true],
    [END, false, false], [END + 1, false, false],
  ]) {
    const result = normalizeSlot(slot, { perOrderNum: 8 }, now);
    assert.equal(result.enabled, enabled);
    assert.equal(result.inProgress, inProgress);
    assert.equal(result.price, 500, "The original slot price is never prorated");
    if (now >= END) assert.equal(result.reason, "Session has ended");
  }
});

test("started sessions still enforce estate availability and valid end times", () => {
  for (const patch of [
    { status: 0 }, { ordered: 1 }, { remainingNum: 0 },
    { reservation: false }, { reservation: "false" }, { pricing: null },
    { endTime: "99:00" }, { endTime: "09:00" }, { endTime: "08:00" },
  ]) {
    const result = normalizeSlot({ ...slot, ...patch }, { perOrderNum: 8 }, START + 1);
    assert.equal(result.enabled, false, JSON.stringify(patch));
    assert.equal(result.inProgress, false);
  }
});

async function fixture(facilityId = "demo-facility-6", index = 1) {
  const clock = { value: START + 30 * 60_000 };
  const demo = createDemoUpstream({ now: () => clock.value });
  const calls = [];
  const portal = new OwnerPortal({ now: () => clock.value, demo: true,
    upstream: (operation, body, context) => {
      calls.push(operation);
      return demo(operation, body, context);
    },
  });
  const session = await portal.login({ phoneOrEmail: "demo", cipher: "demo" });
  const availability = await portal.availability(session, facilityId, DATE);
  const selected = availability.slots[index];
  assert.equal(selected.inProgress, true);
  const body = {
    facilityId, slotId: selected.id, date: DATE, quantity: 1, confirm: true,
    expectedAmount: selected.price, expectedUnitId: session.unit.unitId,
    expectedStartTime: selected.startTime, expectedEndTime: selected.endTime,
  };
  return { clock, demo, calls, portal, session, body };
}

test("booking an ongoing free session yields a confirmed booking and QR only until it ends", async () => {
  const f = await fixture();
  const result = await f.portal.book(f.session, f.body);
  assert.equal(result.status, "confirmed_free");
  assert.equal(result.amount, 0);
  const access = await f.portal.bookingAccess(f.session, result.bookingId);
  assert.match(access.images[0].src, /^data:image\/png;base64,/);
  assert.equal(access.booking.endTime.slice(11, 16), "10:00");
  const qrReads = f.calls.filter(op => op === "bookingQr").length;
  f.clock.value = END;
  await assert.rejects(f.portal.bookingAccess(f.session, result.bookingId));
  assert.equal(f.calls.filter(op => op === "bookingQr").length, qrReads);
  assert.deepEqual(f.calls.filter(op => WRITE_OPERATIONS.has(op)), ["insertBooking", "createOrder"]);
});

test("a session ending after availability validation is blocked before insertion", async () => {
  const f = await fixture();
  f.clock.value = END - 1;
  const commit = f.portal.commit.bind(f.portal);
  f.portal.commit = (...args) => {
    f.clock.value = END;
    return commit(...args);
  };
  await assert.rejects(f.portal.book(f.session, f.body), e => e.code === "SLOT_UNAVAILABLE");
  assert.equal(f.calls.filter(op => WRITE_OPERATIONS.has(op)).length, 0);
});

test("an ongoing paid session keeps its full charge and requires confirmation before QR access", async () => {
  const f = await fixture("demo-facility-1", 0);
  const result = await f.portal.book(f.session, f.body);
  assert.equal(result.amount, 11635);
  assert.equal(result.status, "payment_pending");
  await assert.rejects(f.portal.bookingAccess(f.session, result.bookingId), e => e.code === "BOOKING_NOT_CONFIRMED");
  assert.equal(f.calls.includes("bookingQr"), false);
});
