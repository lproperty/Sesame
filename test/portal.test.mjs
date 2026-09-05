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
    rulesAccepted: true,
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

test("preview performs only reads, requires rules, and derives price and unit from the session", async () => {
  const f = await setup();
  await assert.rejects(
    f.portal.preview(f.session, { ...f.previewBody, rulesAccepted: false }),
    matches("RULES_REQUIRED"),
  );
  const quote = await f.portal.preview(f.session, {
    ...f.previewBody,
    unitId: "foreign",
    projectId: "foreign",
    userType: 9,
    price: 1,
    amount: 1,
  });
  assert.equal(quote.unit.unitId, "demo-unit-1");
  assert.equal(quote.unitPrice, 11635);
  assert.equal(quote.amount, 11635);
  assert.equal(f.writes().length, 0);
});

test("quantity limits and a server notice must be acknowledged", async () => {
  const f = await setup();
  await assert.rejects(
    f.portal.preview(f.session, { ...f.previewBody, quantity: 2 }),
    matches("QUANTITY_UNAVAILABLE"),
  );
  const withNotice = await setup({
    override: async (op) =>
      op === "notice"
        ? { show: true, notice: "Monthly facility rules apply." }
        : undefined,
  });
  await assert.rejects(withNotice.preview(), matches("NOTICE_REQUIRED"));
  const quote = await withNotice.portal.preview(withNotice.session, {
    ...withNotice.previewBody,
    noticeAccepted: true,
  });
  assert.ok(quote.previewId);
  assert.equal(withNotice.writes().length, 0);
});

test("read-only mode rejects reservation, profile and email mutations before any upstream call", async () => {
  const f = await setup({ readOnly: true });
  const quote = await f.preview();
  const before = f.calls.length;
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("READ_ONLY"),
  );
  await assert.rejects(
    f.portal.sendCode(f.session, { email: "fake@example.com" }),
    matches("READ_ONLY"),
  );
  await assert.rejects(
    f.portal.completeProfile(f.session, { confirm: true }),
    matches("READ_ONLY"),
  );
  assert.equal(f.calls.length, before);
});

test("profile completion and explicit final confirmation are required for a live-mode write", async () => {
  const f = await setup();
  const quote = await f.preview();
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId }),
    matches("CONFIRMATION_REQUIRED"),
  );
  f.session.user.needsEmail = true;
  await assert.rejects(
    f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
    matches("PROFILE_INCOMPLETE"),
  );
  assert.equal(f.writes().length, 0);
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

test("a changed price or changed rules requires a new review and makes no reservation", async () => {
  for (const field of ["pricing", "regulations"]) {
    const f = await setup();
    const quote = await f.preview();
    f.demo.facilities[0][field] =
      field === "pricing" ? 150 : "<p>New facility rules.</p>";
    await assert.rejects(
      f.portal.commit(f.session, { previewId: quote.previewId, confirm: true }),
      matches("PREVIEW_CHANGED"),
    );
    assert.equal(f.writes().length, 0);
  }
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

test("profile completion sends the APK fields only after confirmation, and verification emails have a cooldown", async () => {
  const f = await setup({
    override: async (op) =>
      ["profileCode", "completeProfile"].includes(op) ? {} : undefined,
  });
  f.session.user.needsEmail = true;
  const fields = {
    email: "resident@example.com",
    username: "Resident",
    phone: "",
    cipher: "new-test-password",
    confirmPassword: "new-test-password",
    verification: "123456",
  };
  await assert.rejects(f.portal.completeProfile(f.session, fields));
  assert.equal(f.writes().length, 0);
  await f.portal.sendCode(f.session, { email: fields.email });
  await assert.rejects(
    f.portal.sendCode(f.session, { email: fields.email }),
    matches("CODE_COOLDOWN"),
  );
  assert.equal(
    (await f.portal.completeProfile(f.session, { ...fields, confirm: true }))
      .signInAgain,
    true,
  );
  const payload = f.writes().find((c) => c.op === "completeProfile").body;
  assert.deepEqual(payload, {
    email: fields.email,
    username: fields.username,
    phone: "",
    cipher: fields.cipher,
    verification: fields.verification,
  });
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
