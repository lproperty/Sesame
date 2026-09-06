import test from "node:test";
import assert from "node:assert/strict";
import { OwnerPortal } from "../lib/portal.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";
import {
  AppError,
  createUpstream,
  WRITE_OPERATIONS,
} from "../lib/upstream.mjs";
import {
  singaporeDate,
  validateDate,
  normalizeSlot,
  identifier,
  cents,
  safeImage,
} from "../lib/model.mjs";

const FIXED_NOW = Date.parse("2026-09-05T08:00:00Z");
const DAY = "2026-09-06";
const credentials = { phoneOrEmail: "demo", cipher: "demo" };

async function setup(options = {}) {
  const clock = { value: FIXED_NOW };
  const now = () => clock.value;
  const demo = createDemoUpstream({ now });
  const calls = [];
  const upstream = async (op, body, context) => {
    calls.push({ op, body, context });
    if (options.override) {
      const result = await options.override(op, body, context, demo);
      if (result !== undefined) return result;
    }
    return demo(op, body, context);
  };
  const portal = new OwnerPortal({ upstream, now, ...options });
  const session = await portal.login(credentials);
  const previewBody = {
    facilityId: "demo-facility-1",
    slotId: `demo-facility-1-${DAY}-0`,
    date: DAY,
    quantity: 1,
  };
  return {
    portal,
    session,
    demo,
    calls,
    clock,
    previewBody,
    preview: () => portal.preview(session, previewBody),
    writes: () => calls.filter((c) => WRITE_OPERATIONS.has(c.op)),
  };
}

const matches = (code) => (error) => error.code === code;

async function reserve(f) {
  const quote = await f.preview();
  return f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
}

test("existing reservations recover their payment order after sign-in without inserting or charging again", async () => {
  const f = await setup();
  const result = await reserve(f);
  // Native booking lists may omit the order reference. Recover it from the
  // authenticated order list using makeId, not a client-provided reference.
  delete f.demo.bookings[0].orderNo;
  const session = await f.portal.login(credentials);
  const before = f.writes().length;
  const payment = await f.portal.bookingPayment(session, result.bookingId);
  assert.equal(payment.orderNo, result.orderNo);
  assert.equal(payment.status, "pending");
  assert.equal(payment.booking.receipt, undefined);
  assert.equal(
    (await f.portal.resumePayment(session, result.bookingId, { confirm: true }))
      .orderNo,
    result.orderNo,
  );
  assert.equal(f.writes().length, before);
  f.demo.orders.get(result.orderNo).status = 2;
  assert.equal(
    (await f.portal.bookingPayment(session, result.bookingId)).status,
    "paid",
  );
  await assert.rejects(
    f.portal.cancelReservation(session, result.bookingId, { confirm: true }),
    matches("BOOKING_NOT_PENDING"),
  );
  assert.equal(f.writes().length, before);
});

test("payment setup uses the existing reservation's price and ID and is only performed once", async () => {
  const f = await setup();
  const result = await reserve(f);
  delete f.demo.bookings[0].orderNo;
  f.demo.orders.clear();
  const session = await f.portal.login(credentials);
  assert.equal(
    (await f.portal.bookingPayment(session, result.bookingId)).status,
    "not_started",
  );
  const before = f.writes().length;
  const body = {
    confirm: true,
    makeId: "foreign",
    orderNo: "foreign",
    price: 0,
    unitId: "foreign",
    transAmount: 0,
  };
  const payment = await f.portal.resumePayment(session, result.bookingId, body);
  assert.equal(payment.status, "pending");
  await f.portal.resumePayment(session, result.bookingId, body);
  const writes = f.writes().slice(before);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].op, "createOrder");
  assert.equal(writes[0].body.makeId, result.bookingId);
  assert.equal(writes[0].body.price, 11635);
  assert.equal(writes[0].body.transAmount, 11635);
  assert.equal(writes[0].body.unitId, session.unit.unitId);
  assert.equal(writes[0].body.transType, "LOCAL_CASH");
});

test("an order on a later page is recovered without creating a duplicate payment", async () => {
  const pages = [];
  const f = await setup({
    override: async (op, body, context, demo) => {
      if (op !== "orders") return undefined;
      pages.push(body.pageIndex);
      return body.pageIndex === 1
        ? {
            list: Array.from({ length: 50 }, (_, i) => ({
              makeId: `other-${i}`,
              orderType: 0,
            })),
            total: 51,
          }
        : { list: [...demo.orders.values()], total: 51 };
    },
  });
  const result = await reserve(f);
  delete f.demo.bookings[0].orderNo;
  const session = await f.portal.login(credentials);
  const before = f.writes().length;
  assert.equal(
    (await f.portal.resumePayment(session, result.bookingId, { confirm: true }))
      .orderNo,
    result.orderNo,
  );
  assert.deepEqual(pages, [1, 2]);
  assert.equal(f.writes().length, before);
});

test("recovering an order after a lost setup response unlocks later bookings", async () => {
  const f = await setup({
    override: async (op, body, context, demo) => {
      if (op === "createOrder") {
        await demo(op, body, context);
        throw new AppError("Response lost.", 502, "UPSTREAM_UNREACHABLE");
      }
    },
  });
  const result = await reserve(f);
  assert.equal(result.status, "order_unconfirmed");
  const scope = f.portal.scope(f.session);
  assert.equal(f.portal.actions.get(scope).uncertain, true);
  assert.equal(
    (await f.portal.bookingPayment(f.session, result.bookingId)).status,
    "pending",
  );
  assert.equal(f.portal.actions.get(scope).uncertain, false);
  assert.equal(f.writes().filter((c) => c.op === "createOrder").length, 1);
});

test("expired payment orders can be renewed without recreating the booking or reusing the expired reference", async () => {
  const f = await setup();
  const result = await reserve(f);
  f.demo.orders.get(result.orderNo).status = 4;
  assert.equal(
    (await f.portal.bookingPayment(f.session, result.bookingId)).status,
    "expired",
  );
  const payment = await f.portal.resumePayment(f.session, result.bookingId, {
    confirm: true,
  });
  assert.notEqual(payment.orderNo, result.orderNo);
  // Simulate a stale booking list still carrying the old reference.
  f.demo.bookings[0].orderNo = result.orderNo;
  assert.equal(
    (await f.portal.bookingPayment(f.session, result.bookingId)).orderNo,
    payment.orderNo,
  );
  await f.portal.resumePayment(f.session, result.bookingId, { confirm: true });
  assert.equal(f.writes().filter((c) => c.op === "insertBooking").length, 1);
  assert.equal(f.writes().filter((c) => c.op === "createOrder").length, 2);
});

test("cancellation verifies the selected unit and pending state, then releases the slot and clears cached receipts", async () => {
  const f = await setup();
  const result = await reserve(f);
  await assert.rejects(
    f.portal.cancelReservation(f.session, result.bookingId, {}),
    matches("CONFIRMATION_REQUIRED"),
  );
  f.portal.switchUnit(f.session, "demo-unit-2");
  await assert.rejects(
    f.portal.cancelReservation(f.session, result.bookingId, { confirm: true }),
    matches("BOOKING_NOT_FOUND"),
  );
  await assert.rejects(
    f.portal.bookingPayment(f.session, result.bookingId),
    matches("BOOKING_NOT_FOUND"),
  );
  assert.equal(f.writes().filter((c) => c.op === "cancelBooking").length, 0);
  f.portal.switchUnit(f.session, "demo-unit-1");
  assert.equal(
    (
      await f.portal.cancelReservation(f.session, result.bookingId, {
        confirm: true,
        projectId: "foreign",
      })
    ).status,
    "cancelled",
  );
  assert.deepEqual(f.writes().at(-1).body, {
    id: result.bookingId,
    projectId: "demo-project",
  });
  assert.equal((await f.portal.bookings(f.session, "unpaid")).length, 0);
  const availability = await f.portal.availability(
    f.session,
    f.previewBody.facilityId,
    DAY,
  );
  assert.equal(availability.slots[0].enabled, true);
  const replacement = await reserve(f);
  assert.notEqual(replacement.bookingId, result.bookingId);
  await assert.rejects(
    f.portal.cancelReservation(f.session, result.bookingId, { confirm: true }),
    matches("BOOKING_NOT_FOUND"),
  );
});

test("read-only mode permits payment checks and blocks payment setup and cancellation before upstream work", async () => {
  const f = await setup();
  const result = await reserve(f);
  f.portal.readOnly = true;
  assert.equal(
    (await f.portal.bookingPayment(f.session, result.bookingId)).status,
    "pending",
  );
  const before = f.calls.length;
  await assert.rejects(
    f.portal.resumePayment(f.session, result.bookingId, { confirm: true }),
    matches("READ_ONLY"),
  );
  await assert.rejects(
    f.portal.cancelReservation(f.session, result.bookingId, { confirm: true }),
    matches("READ_ONLY"),
  );
  assert.equal(f.calls.length, before);
});

test("malformed payment status cannot be interpreted as unpaid or allow cancellation", async () => {
  for (const value of [null, {}, "unexpected", 9]) {
    const f = await setup({
      override: async (op) =>
        op === "orderStatus" ? { data: value } : undefined,
    });
    const result = await reserve(f);
    await assert.rejects(
      f.portal.bookingPayment(f.session, result.bookingId),
      matches("UPSTREAM_RESPONSE"),
    );
    await assert.rejects(
      f.portal.cancelReservation(f.session, result.bookingId, {
        confirm: true,
      }),
      matches("UPSTREAM_RESPONSE"),
    );
    assert.equal(f.writes().filter((c) => c.op === "cancelBooking").length, 0);
  }
});

test("ambiguous payment renewal cannot create more orders on retry", async () => {
  let timeout = false;
  const f = await setup({
    override: async (op) => {
      if (timeout && op === "createOrder")
        throw new AppError("Timeout", 502, "UPSTREAM_UNREACHABLE");
    },
  });
  const result = await reserve(f);
  f.demo.orders.get(result.orderNo).status = 4;
  timeout = true;
  await assert.rejects(
    f.portal.resumePayment(f.session, result.bookingId, { confirm: true }),
    matches("OUTCOME_UNCERTAIN"),
  );
  await assert.rejects(
    f.portal.resumePayment(f.session, result.bookingId, { confirm: true }),
    matches("OUTCOME_UNCERTAIN"),
  );
  assert.equal(f.writes().filter((c) => c.op === "createOrder").length, 2);
  assert.equal(f.demo.bookings.length, 1);
});

test("cancellation and payment cannot race, and estate errors do not remove reservations", async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await setup({
    override: async (op) => {
      if (op === "cancelBooking") {
        entered();
        await gate;
        throw new AppError("Cancellation declined.", 422, "ESTATE_REJECTED");
      }
    },
  });
  const result = await reserve(f);
  const cancellation = f.portal.cancelReservation(f.session, result.bookingId, {
    confirm: true,
  });
  const rejected = assert.rejects(cancellation, matches("ESTATE_REJECTED"));
  await started;
  assert.throws(
    () => f.portal.switchUnit(f.session, "demo-unit-2"),
    matches("BOOKING_IN_PROGRESS"),
  );
  await assert.rejects(
    f.portal.resumePayment(f.session, result.bookingId, { confirm: true }),
    matches("BOOKING_IN_PROGRESS"),
  );
  await assert.rejects(
    f.portal.cancelReservation(f.session, result.bookingId, { confirm: true }),
    matches("BOOKING_IN_PROGRESS"),
  );
  release();
  await rejected;
  assert.equal(f.demo.bookings.length, 1);
  assert.equal(f.writes().filter((c) => c.op === "cancelBooking").length, 1);
});

test("slot inspection exposes capacity and schedule metadata without forwarding resident identity", () => {
  const slot = normalizeSlot(
    {
      id: "occupied-slot",
      date: DAY,
      startTime: "09:00",
      endTime: "10:00",
      pricing: 2,
      num: 1,
      remainingNum: 0,
      status: 1,
      ordered: 1,
      reservation: null,
      gmtCreate: "2026-08-28 13:07:34",
      gmtModified: "2026-09-01T09:58:00",
      ownerName: "Private Resident",
      unitName: "#99-99",
      email: "private@example.com",
      booking: { ownerId: "private-owner-id", unitId: "private-unit-id" },
    },
    { perOrderNum: 1 },
    FIXED_NOW,
  );
  assert.equal(slot.enabled, false);
  assert.deepEqual(slot.details, {
    capacity: 1,
    remainingCapacity: 0,
    unavailableCapacity: 1,
    bookingFlag: true,
    reservationAllowed: null,
    scheduleEnabled: true,
    scheduleCreatedAt: "2026-08-28 13:07:34",
    scheduleUpdatedAt: "2026-09-01T09:58:00",
  });
  const output = JSON.stringify(slot);
  for (const privateValue of [
    "Private Resident",
    "#99-99",
    "private@example.com",
    "private-owner-id",
    "private-unit-id",
  ])
    assert.equal(output.includes(privateValue), false);
});

test("unknown or inconsistent capacity is not presented as an inferred booking count", () => {
  const slot = normalizeSlot(
    {
      id: "slot",
      date: DAY,
      startTime: "09:00",
      endTime: "10:00",
      pricing: 2,
      num: 1,
      remainingNum: 2,
    },
    { perOrderNum: 1 },
    FIXED_NOW,
  );
  assert.equal(slot.details.unavailableCapacity, null);
  assert.equal(slot.details.bookingFlag, null);
  assert.equal(slot.details.scheduleCreatedAt, null);
});

test("booking detail attribution requires a verified selected unit and excludes foreign unit records", async () => {
  const fixture = await setup({
    override: async (operation) =>
      operation === "bookings"
        ? [
            {
              id: "own",
              facilityId: "demo-facility-1",
              facilityDetailId: "slot",
              unitId: "demo-unit-1",
              gmtCreate: "2026-09-01 12:00:00",
              ownerName: "Do not forward",
            },
            {
              id: "unverified",
              facilityId: "demo-facility-1",
              facilityDetailId: "slot",
            },
            {
              id: "foreign",
              facilityId: "demo-facility-1",
              facilityDetailId: "slot",
              unitId: "foreign-unit",
              ownerName: "Other Resident",
            },
          ]
        : undefined,
  });
  const records = await fixture.portal.bookings(fixture.session, "current");
  assert.equal(records.length, 2);
  assert.equal(
    records.find((record) => record.id === "own").unit.unitId,
    "demo-unit-1",
  );
  assert.equal(
    records.find((record) => record.id === "own").createdAt,
    "2026-09-01 12:00:00",
  );
  assert.equal(records.find((record) => record.id === "unverified").unit, null);
  assert.equal(JSON.stringify(records).includes("Do not forward"), false);
  assert.equal(JSON.stringify(records).includes("Other Resident"), false);
  assert.equal(fixture.writes().length, 0);
});

test("Singapore date and real calendar dates are enforced independently of machine timezone", () => {
  assert.equal(singaporeDate(Date.parse("2026-09-05T16:01:00Z")), "2026-09-06");
  assert.equal(validateDate("2026-10-03", FIXED_NOW), "2026-10-03");
  for (const date of [
    "2026-09-04",
    "2026-10-04",
    "2026-02-30",
    "2026-09-06T00:00:00Z",
    "invalid",
  ]) {
    assert.throws(() => validateDate(date, FIXED_NOW), matches("INVALID_DATE"));
  }
});

test("large estate IDs retain their exact digits and invalid prices fail closed", () => {
  assert.equal(identifier("2079461293025193986"), "2079461293025193986");
  assert.throws(() => identifier(2079461293025193986));
  assert.equal(cents(116.35), 11635);
  assert.equal(cents("0.29"), 29);
  assert.equal(cents(0), 0);
  for (const value of [null, "", "NaN", -1, Infinity, {}])
    assert.equal(cents(value), null);
  assert.equal(safeImage("https://evil.example/picture.png"), "");
  assert.equal(safeImage("javascript:alert(1)"), "");
  assert.equal(safeImage("/assets/estate.jpg"), "/assets/estate.jpg");
});

test("all unavailable slot flags and elapsed sessions prevent selection", () => {
  const base = {
    id: "slot",
    date: DAY,
    startTime: "09:00",
    endTime: "10:00",
    pricing: 5,
    status: 1,
    remainingNum: 2,
    ordered: 0,
    reservation: null,
    num: 2,
  };
  const facility = { perOrderNum: 2 };
  assert.equal(normalizeSlot(base, facility, FIXED_NOW).enabled, true);
  for (const patch of [
    { status: 0 },
    { status: "0" },
    { ordered: 1 },
    { ordered: "1" },
    { reservation: false },
    { reservation: "false" },
    { remainingNum: 0 },
    { remainingNum: -1 },
    { pricing: null },
    { startTime: "99:00" },
    { date: "2026-09-05", startTime: "15:00" },
  ]) {
    assert.equal(
      normalizeSlot({ ...base, ...patch }, facility, FIXED_NOW).enabled,
      false,
      JSON.stringify(patch),
    );
  }
});

test("login fixes the Owner role and exposes only activated owner associations", async () => {
  const f = await setup();
  assert.deepEqual(f.calls[0].body, {
    phoneOrEmail: "demo",
    cipher: "demo",
    identity: "Owner",
    type: 0,
    api: "",
  });
  const view = f.portal.sessionView(f.session);
  assert.equal(view.unit.userType, 0);
  assert.equal(view.token, undefined);
  assert.equal(JSON.stringify(view).includes("local-demo-token"), false);
  const wrongUnits = await setup({
    override: async (op) =>
      op === "units"
        ? [
            {
              unitId: "tenant",
              projectId: "p",
              userType: 1,
              activation: 1,
              status: 0,
            },
            {
              unitId: "inactive",
              projectId: "p",
              userType: 0,
              activation: 0,
              status: 0,
            },
            {
              unitId: "pending",
              projectId: "p",
              userType: 0,
              activation: 1,
              status: 1,
            },
          ]
        : undefined,
  });
  assert.equal(wrongUnits.session.units.length, 0);
  assert.equal(wrongUnits.session.unit, null);
});

test("foreign unit and facility selections never reach booking insertion", async () => {
  const f = await setup();
  assert.throws(
    () => f.portal.switchUnit(f.session, "foreign-unit"),
    matches("UNIT_NOT_ALLOWED"),
  );
  await assert.rejects(
    f.portal.preview(f.session, {
      ...f.previewBody,
      facilityId: "foreign-facility",
    }),
    matches("FACILITY_NOT_FOUND"),
  );
  assert.equal(f.writes().length, 0);
});

test("booking preparation ignores acceptance flags and derives price and unit from the session", async () => {
  const f = await setup();
  const quote = await f.portal.preview(f.session, {
    ...f.previewBody,
    rulesAccepted: false,
    noticeAccepted: false,
    unitId: "foreign",
    projectId: "foreign",
    userType: 9,
    price: 1,
    amount: 1,
  });
  assert.equal(quote.unit.unitId, "demo-unit-1");
  assert.equal(quote.amount, 11635);
  assert.equal(f.writes().length, 0);
  assert.equal(
    f.calls.some((call) => call.op === "notice"),
    false,
  );
});

test("booking quantity cannot exceed the available session limit", async () => {
  const f = await setup();
  await assert.rejects(
    f.portal.preview(f.session, { ...f.previewBody, quantity: 2 }),
    matches("QUANTITY_UNAVAILABLE"),
  );
});

test("read-only mode rejects reservations before any upstream call", async () => {
  const f = await setup({ readOnly: true });
  const quote = await f.preview();
  const before = f.calls.length;
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("READ_ONLY"),
  );
  await assert.rejects(
    f.portal.book(f.session, { confirm: true }),
    matches("READ_ONLY"),
  );
  assert.equal(f.calls.length, before);
});

test("booking requires explicit submission but not app-imposed profile completion", async () => {
  const f = await setup();
  const quote = await f.preview();
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId }),
    matches("CONFIRMATION_REQUIRED"),
  );
  f.session.user.needsEmail = true;
  const result = await f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
  assert.equal(result.status, "payment_pending");
});

test("successful checkout sends the recovered insertion/order payloads once, using integer cents", async () => {
  const f = await setup();
  const quote = await f.preview();
  const result = await f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
    unitId: "foreign",
    price: 0,
  });
  assert.equal(result.status, "payment_pending");
  const [insert, order] = f.writes();
  assert.equal(f.writes().length, 2);
  assert.deepEqual(insert.body, {
    facilityId: "demo-facility-1",
    facilityDetailId: `demo-facility-1-${DAY}-0`,
    bookingNum: 1,
    goodsDetail: "Jewel Function Room 1",
    orderDesc: `${DAY} 09:00-15:00`,
    unitId: "demo-unit-1",
  });
  assert.equal(order.body.makeId, result.bookingId);
  assert.equal(order.body.price, 11635);
  assert.equal(order.body.transAmount, 11635);
  assert.equal(order.body.transType, "LOCAL_CASH");
  assert.equal(order.body.unitId, insert.context.unitId);
  assert.equal(order.body.projectId, "demo-project");
  assert.equal(order.context.token, "local-demo-token");
  const bookings = await f.portal.bookings(f.session, "unpaid");
  assert.equal(bookings[0].receipt.orderNo, result.orderNo);
});

test("parallel double clicks and a repeated request return one reservation and one order", async () => {
  const f = await setup();
  const quote = await f.preview();
  const body = { previewId: quote.previewId, confirm: true };
  const [first, second] = await Promise.all([
    f.portal.commit(f.session, body),
    f.portal.commit(f.session, body),
  ]);
  const third = await f.portal.commit(f.session, body);
  assert.equal(first.bookingId, second.bookingId);
  assert.equal(third.bookingId, first.bookingId);
  assert.equal(f.writes().length, 2);
});

test("unit switching and a second session are blocked while an insertion is in flight", async () => {
  let release;
  let inserted;
  const started = new Promise((resolve) => {
    inserted = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await setup({
    override: async (op) => {
      if (op === "insertBooking") {
        inserted();
        await gate;
      }
    },
  });
  const otherSession = await f.portal.login(credentials);
  const [quote, otherQuote] = await Promise.all([
    f.preview(),
    f.portal.preview(otherSession, f.previewBody),
  ]);
  const pending = f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
  await started;
  assert.throws(
    () => f.portal.switchUnit(f.session, "demo-unit-2"),
    matches("BOOKING_IN_PROGRESS"),
  );
  await assert.rejects(
    f.portal.commit(otherSession, {
      previewId: otherQuote.previewId,
      confirm: true,
    }),
    matches("BOOKING_IN_PROGRESS"),
  );
  release();
  await pending;
  assert.equal(f.writes().length, 2);
});

test("the final availability check prevents a stale slot from being booked", async () => {
  let taken = false;
  const f = await setup({
    override: async (op, body, context, demo) => {
      if (op === "availability" && taken)
        return (await demo(op, body, context)).map((s) => ({
          ...s,
          remainingNum: 0,
        }));
    },
  });
  const quote = await f.preview();
  taken = true;
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("SLOT_UNAVAILABLE"),
  );
  assert.equal(f.writes().length, 0);
});

test("a changed price prevents a booking but changed rules do not add a gate", async () => {
  const f = await setup();
  const quote = await f.preview();
  f.demo.facilities[0].pricing = 150;
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("PREVIEW_CHANGED"),
  );
  assert.equal(f.writes().length, 0);
  const g = await setup();
  const other = await g.preview();
  g.demo.facilities[0].regulations = "Changed rules";
  assert.equal(
    (
      await g.portal.commit(g.session, {
        previewId: other.previewId,
        confirm: true,
      })
    ).status,
    "payment_pending",
  );
});

test("a changed start time with the same slot ID still requires a new review", async () => {
  let changed = false;
  const f = await setup({
    override: async (op, body, context, demo) => {
      if (op === "availability" && changed)
        return (await demo(op, body, context)).map((s) => ({
          ...s,
          startTime: "10:00",
        }));
    },
  });
  const quote = await f.preview();
  changed = true;
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("PREVIEW_CHANGED"),
  );
  assert.equal(f.writes().length, 0);
});

test("expired reviews and changed unit context cannot be submitted", async () => {
  const f = await setup();
  const quote = await f.preview();
  f.clock.value += 6 * 60_000;
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("PREVIEW_EXPIRED"),
  );
  f.clock.value = FIXED_NOW;
  f.portal.switchUnit(f.session, "demo-unit-2");
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("PREVIEW_NOT_FOUND"),
  );
  assert.equal(f.writes().length, 0);
});

test("the estate maxShow limit prevents payment order creation", async () => {
  const f = await setup({
    override: async (op) =>
      op === "insertBooking"
        ? { maxShow: true, notice: "Monthly limit reached." }
        : undefined,
  });
  const quote = await f.preview();
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("BOOKING_LIMIT"),
  );
  assert.equal(f.writes().filter((c) => c.op === "createOrder").length, 0);
});

test("an ambiguous insertion timeout is never retried and blocks further unit submissions", async () => {
  const f = await setup({
    override: async (op) => {
      if (op === "insertBooking")
        throw new AppError("Connection lost.", 502, "UPSTREAM_UNREACHABLE");
    },
  });
  const quote = await f.preview();
  const result = await f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
  assert.equal(result.status, "outcome_unknown");
  assert.equal(
    (
      await f.portal.commit(f.session, {
        previewId: quote.previewId,
        confirm: true,
      })
    ).status,
    "outcome_unknown",
  );
  const next = await f.preview();
  await assert.rejects(
    f.portal.commit(f.session, { previewId: next.previewId, confirm: true }),
    matches("OUTCOME_UNCERTAIN"),
  );
  assert.equal(f.writes().length, 1);
});

test("a failed order preserves the created reservation and repeated confirmation never inserts again", async () => {
  const f = await setup({
    override: async (op) => {
      if (op === "createOrder")
        throw new AppError("Timeout.", 502, "UPSTREAM_UNREACHABLE");
    },
  });
  const quote = await f.preview();
  const result = await f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
  assert.equal(result.status, "order_unconfirmed");
  assert.ok(result.bookingId);
  await f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
  assert.equal(f.writes().filter((c) => c.op === "insertBooking").length, 1);
  assert.equal(f.writes().filter((c) => c.op === "createOrder").length, 1);
});

test("an unreadable reservation ID is treated as uncertain without another insertion", async () => {
  const f = await setup({
    override: async (op) =>
      op === "insertBooking" ? { id: 2079461293025193986 } : undefined,
  });
  const quote = await f.preview();
  const result = await f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
  assert.equal(result.status, "outcome_unknown");
  await f.portal.commit(f.session, {
    previewId: quote.previewId,
    confirm: true,
  });
  assert.equal(f.writes().length, 1);
});

test("upstream client uses APK headers and refuses every mutation in read-only mode", async () => {
  const sent = [];
  const api = createUpstream({
    readOnly: true,
    fetchImpl: async (url, options) => {
      sent.push({ url, options });
      return new Response(JSON.stringify({ code: 1200, data: [] }), {
        status: 200,
      });
    },
  });
  await api(
    "facilities",
    { projectId: "123", status: 1 },
    { token: "secret-test-token", unitId: "456", userType: 0 },
  );
  assert.equal(sent[0].options.headers.token, "secret-test-token");
  assert.equal(sent[0].options.headers.unitId, "456");
  assert.equal(sent[0].options.headers.userType, "0");
  assert.equal(sent[0].options.headers.authorization, undefined);
  assert.equal(sent[0].options.redirect, "error");
  for (const operation of WRITE_OPERATIONS)
    await assert.rejects(api(operation), matches("READ_ONLY"));
  assert.equal(sent.length, 1);
});

test("upstream application errors and invalid JSON are not mistaken for success", async () => {
  for (const code of [1401, 1402, 1500]) {
    const api = createUpstream({
      fetchImpl: async () =>
        new Response(JSON.stringify({ code, message: "Declined." })),
    });
    await assert.rejects(
      api("facilities"),
      matches(code === 1500 ? "ESTATE_REJECTED" : "SESSION_EXPIRED"),
    );
  }
  const api = createUpstream({
    fetchImpl: async () => new Response("<html>Temporary error</html>"),
  });
  await assert.rejects(api("facilities"), matches("UPSTREAM_RESPONSE"));
});

test("one Book action checks availability once and repeated requests do not insert again", async () => {
  const f = await setup();
  const quoted = await f.preview();
  const body = {
    ...f.previewBody,
    confirm: true,
    expectedAmount: quoted.amount,
    expectedUnitId: quoted.unit.unitId,
    expectedStartTime: quoted.startTime,
    expectedEndTime: quoted.endTime,
  };
  const before = f.calls.length;
  const first = await f.portal.book(f.session, body);
  const second = await f.portal.book(f.session, body);
  assert.equal(second.bookingId, first.bookingId);
  assert.equal(
    f.calls.slice(before).filter((call) => call.op === "availability").length,
    1,
  );
  assert.equal(
    f.writes().filter((call) => call.op === "insertBooking").length,
    1,
  );
  assert.equal(
    f.writes().filter((call) => call.op === "createOrder").length,
    1,
  );
  assert.equal(
    f
      .writes()
      .some(
        (call) => "rulesAccepted" in call.body || "noticeAccepted" in call.body,
      ),
    false,
  );
});
