import test from "node:test";
import assert from "node:assert/strict";
import { OwnerPortal } from "../lib/portal.mjs";
import { AppError } from "../lib/errors.mjs";

const NOW = Date.parse("2026-09-10T13:00:00Z");
const BOOKING = "1234567890123456789";
const OTHER_BOOKING = "1234567890123456790";
const UNIT = "9876543210987654321";
const PROJECT = "1111111111111111111";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n2kAAAAASUVORK5CYII=";
const matches = (code) => (error) => error?.code === code;

function booking(changes = {}) {
  return {
    id: BOOKING,
    facilityId: "2222222222222222222",
    facilityDetailId: "3333333333333333333",
    facilityName: "Tennis Court (Off-Peak)",
    unitId: UNIT,
    projectId: PROJECT,
    status: 1,
    pricing: 0,
    paidTotal: 0,
    bookingNum: 1,
    startTime: "2026.09.11 10:00:00",
    endTime: "2026.09.11 11:00:00",
    ...changes,
  };
}

function historicalBooking(changes = {}) {
  return booking({
    startTime: "2026.09.10 15:00:00",
    endTime: "2026.09.10 16:00:00",
    ...changes,
  });
}

function order(changes = {}) {
  return {
    requestNo: "SYNTHETIC-FREE-ORDER",
    makeId: BOOKING,
    orderType: 0,
    status: 2,
    unitId: UNIT,
    projectId: PROJECT,
    price: 0,
    transAmount: 0,
    tipsAmount: 0,
    ...changes,
  };
}

function fixture(options = {}) {
  const unit = { unitId: UNIT, projectId: PROJECT, userType: 0 };
  const secondUnit = { ...unit, unitId: "9876543210987654322" };
  const session = {
    token: "synthetic-session-token",
    user: { id: "4444444444444444444", name: "Example owner" },
    units: [unit, secondUnit],
    unit,
    quotes: new Map(),
    facilities: new Map(),
  };
  const state = {
    current: options.current ?? [booking()],
    history: options.history ?? [],
    unpaid: options.unpaid ?? [],
    orders: options.orders ?? [order()],
  };
  const calls = [];
  const upstream = async (op, body, context) => {
    calls.push(structuredClone({ op, body, context }));
    const overridden = await options.override?.(
      op,
      body,
      context,
      state,
      calls,
    );
    if (overridden !== undefined) return overridden;
    if (op === "bookings")
      return structuredClone(
        body.status === 0
          ? state.unpaid
          : body.type === 1
            ? state.history
            : state.current,
      );
    if (op === "orders")
      return {
        list: structuredClone(state.orders),
        total: state.orders.length,
      };
    if (op === "orderStatus")
      return {
        data:
          state.orders.find((row) => row.requestNo === body.orderNo)?.status ??
          1,
      };
    if (op === "cancelBooking") {
      state.current = state.current.filter((row) => row.id !== body.id);
      state.unpaid = state.unpaid.filter((row) => row.id !== body.id);
      state.history = state.history.filter((row) => row.id !== body.id);
      return {};
    }
    if (op === "qrConfig") return { value: 10 };
    if (op === "bookingQr") return [PNG];
    throw new Error(`Unexpected test operation: ${op}`);
  };
  const portal = new OwnerPortal({
    upstream,
    now: () => NOW,
    readOnly: options.readOnly,
  });
  return {
    portal,
    session,
    secondUnit,
    state,
    calls,
    writes: () => calls.filter((call) => call.op === "cancelBooking"),
    cancel: (body = { confirm: true }) =>
      portal.cancelReservation(session, BOOKING, body),
    access: () => portal.bookingAccess(session, BOOKING),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("confirmed free tennis cancels only its authenticated booking after verifying removal", async () => {
  const f = fixture({ current: [booking(), booking({ id: OTHER_BOOKING })] });
  const view = await f.portal.bookingPayment(f.session, BOOKING);
  assert.equal(view.status, "free");
  assert.equal(view.canCancel, true);
  assert.deepEqual(
    await f.cancel({
      confirm: true,
      unitId: "foreign",
      projectId: "foreign",
      price: 0,
    }),
    {
      status: "cancelled",
      bookingId: BOOKING,
    },
  );
  assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0].body, { id: BOOKING, projectId: PROJECT });
  assert.equal(f.writes()[0].context.unitId, UNIT);
  assert.equal(f.writes()[0].context.token, f.session.token);
  assert.deepEqual(
    f.state.current.map((row) => row.id),
    [OTHER_BOOKING],
  );
  const writeIndex = f.calls.findIndex((call) => call.op === "cancelBooking");
  assert.deepEqual(
    f.calls.slice(writeIndex + 1).map((call) => call.body),
    [{ status: 1, type: 0 }, { status: 0 }, { status: 1, type: 1 }],
  );
  // Cancelling a reservation does not fabricate a refund or change the order.
  assert.equal(f.state.orders[0].status, 2);
});

test("historical free tennis cancellation verifies history removal and preserves other records and settled orders", async () => {
  const f = fixture({
    current: [booking({ id: "future-booking" })],
    unpaid: [booking({ id: "pending-booking", status: 0 })],
    history: [historicalBooking(), historicalBooking({ id: OTHER_BOOKING })],
  });
  const previousOrders = structuredClone(f.state.orders);
  assert.deepEqual(await f.cancel(), { status: "cancelled", bookingId: BOOKING });
  assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0].body, { id: BOOKING, projectId: PROJECT });
  assert.equal(f.writes()[0].context.unitId, UNIT);
  assert.deepEqual(f.state.history.map(row => row.id), [OTHER_BOOKING]);
  assert.deepEqual(f.state.current.map(row => row.id), ["future-booking"]);
  assert.deepEqual(f.state.unpaid.map(row => row.id), ["pending-booking"]);
  assert.deepEqual(f.state.orders, previousOrders);
  const writeIndex = f.calls.findIndex(call => call.op === "cancelBooking");
  assert.deepEqual(
    f.calls.slice(writeIndex + 1).map(call => call.body),
    [{ status: 1, type: 0 }, { status: 0 }, { status: 1, type: 1 }],
  );
  assert.equal(f.calls.some(call => ["createOrder", "orderStatus", "bookingQr", "qrConfig"].includes(call.op)), false);
});

test("enabling history cancellation does not expose past bookings to entry QR or payment actions", async () => {
  const f = fixture({ current: [], history: [historicalBooking()] });
  await assert.rejects(f.access(), matches("BOOKING_NOT_FOUND"));
  await assert.rejects(f.portal.bookingPayment(f.session, BOOKING), matches("BOOKING_NOT_FOUND"));
  await assert.rejects(
    f.portal.resumePayment(f.session, BOOKING, { confirm: true }),
    matches("BOOKING_NOT_FOUND"),
  );
  assert.equal(f.calls.some(call => ["orders", "createOrder", "cancelBooking", "bookingQr", "qrConfig"].includes(call.op)), false);
  assert.equal((await f.cancel()).status, "cancelled");
});

test("history cancellation checks free tennis eligibility, completed times and selected-unit ownership", async (t) => {
  const cases = [
    ["paid historical booking", { pricing: 2.18, paidTotal: 2.18 }, "BOOKING_NOT_CANCELLABLE"],
    ["unknown total", { paidTotal: undefined }, "BOOKING_NOT_CANCELLABLE"],
    ["different facility", { facilityName: "Function Room" }, "BOOKING_NOT_CANCELLABLE"],
    ["ongoing session incorrectly listed in history", { startTime: "2026.09.10 20:00", endTime: "2026.09.10 22:00" }, "BOOKING_NOT_CANCELLABLE"],
    ["missing start", { startTime: undefined }, "BOOKING_NOT_CANCELLABLE"],
    ["missing end", { endTime: undefined }, "BOOKING_NOT_CANCELLABLE"],
    ["end before start", { endTime: "2026.09.10 14:00" }, "BOOKING_NOT_CANCELLABLE"],
    ["another unit", { unitId: "foreign" }, "BOOKING_NOT_FOUND"],
    ["another project", { projectId: "foreign" }, "BOOKING_NOT_FOUND"],
  ];
  for (const [label, changes, code] of cases)
    await t.test(label, async () => {
      const f = fixture({ current: [], history: [historicalBooking(changes)] });
      await assert.rejects(f.cancel(), matches(code));
      assert.equal(f.writes().length, 0);
    });
  for (const [label, changes] of [
    ["Singapore offset", { startTime: "2026-09-10T20:00:00+0800", endTime: "2026-09-10T21:00:00+0800" }],
    ["UTC offset at the completed boundary", { startTime: "2026-09-10T12:00:00Z", endTime: "2026-09-10T13:00:00Z" }],
  ])
    await t.test(label, async () => {
      const f = fixture({ current: [], history: [historicalBooking(changes)] });
      assert.equal((await f.cancel()).status, "cancelled");
    });
});

test("history cancellation rechecks linked zero-value orders and still requires explicit confirmation", async () => {
  const f = fixture({ current: [], history: [historicalBooking()] });
  await assert.rejects(f.cancel({}), matches("CONFIRMATION_REQUIRED"));
  assert.equal(f.calls.length, 0);
  const record = (await f.portal.bookings(f.session, "history"))[0];
  await f.portal.reservationOrder(f.session, f.session.unit, record);
  f.state.orders[0].tipsAmount = 1;
  await assert.rejects(f.cancel(), matches("FREE_BOOKING_UNCONFIRMED"));
  assert.equal(f.calls.filter(call => call.op === "orders").length, 2);
  assert.equal(f.writes().length, 0);
  const wrongUnit = fixture({ current: [], history: [historicalBooking()], orders: [order({ unitId: "foreign" })] });
  await assert.rejects(wrongUnit.cancel(), matches("FREE_BOOKING_UNCONFIRMED"));
  assert.equal(wrongUnit.writes().length, 0);
  const readOnly = fixture({ current: [], history: [historicalBooking()], readOnly: true });
  await assert.rejects(readOnly.cancel(), matches("READ_ONLY"));
  assert.equal(readOnly.calls.length, 0);
});

test("retained history and failed history verification never report cancellation success or repeat the write", async (t) => {
  for (const failure of ["retained", "read failed", "moved to current"])
    await t.test(failure, async () => {
      const f = fixture({
        current: [],
        history: [historicalBooking()],
        override: async (op, body, context, state, calls) => {
          if (op === "cancelBooking" && failure === "retained") return {};
          if (op === "cancelBooking" && failure === "moved to current") {
            state.current = state.history;
            state.history = [];
            return {};
          }
          if (failure === "read failed" && op === "bookings" && body.type === 1 && calls.some(call => call.op === "cancelBooking"))
            throw new AppError("Offline", 502, "UPSTREAM_UNREACHABLE");
        },
      });
      await assert.rejects(f.cancel(), matches("OUTCOME_UNCERTAIN"));
      assert.equal(f.writes().length, 1);
    });
});

test("zero-valued decimal strings remain valid but nonzero and malformed order money fail closed", async (t) => {
  const valid = fixture({
    orders: [order({ price: "0.00", transAmount: "0", tipsAmount: "0" })],
  });
  assert.equal((await valid.cancel()).status, "cancelled");
  const cases = [
    ["positive price", { price: 218 }],
    ["positive total", { transAmount: 218 }],
    ["positive fee", { tipsAmount: 1 }],
    ["missing price", { price: undefined }],
    ["null total", { transAmount: null }],
    ["empty price", { price: "" }],
    ["whitespace total", { transAmount: " " }],
    ["boolean price", { price: false }],
    ["array total", { transAmount: [] }],
    ["array price", { price: [0] }],
    ["empty fee", { tipsAmount: "" }],
    ["nonfinite total", { transAmount: Infinity }],
  ];
  for (const [label, change] of cases)
    await t.test(label, async () => {
      const f = fixture({ orders: [order(change)] });
      await assert.rejects(f.cancel(), matches("FREE_BOOKING_UNCONFIRMED"));
      assert.equal(f.writes().length, 0);
    });
});

test("free cancellation refreshes even a previously verified zero-value order cache", async () => {
  const f = fixture();
  const row = await f.portal.reservation(f.session, BOOKING, f.session.unit);
  const cached = await f.portal.reservationOrder(
    f.session,
    f.session.unit,
    row,
  );
  assert.equal(cached.verifiedZeroValue, true);
  f.state.orders[0].transAmount = 218;
  await assert.rejects(f.cancel(), matches("FREE_BOOKING_UNCONFIRMED"));
  assert.equal(f.calls.filter((call) => call.op === "orders").length, 2);
  assert.equal(f.writes().length, 0);
});

test("free cancellation requires exact order linkage, scope and settled status", async (t) => {
  const cases = [
    ["another reservation", [order({ makeId: OTHER_BOOKING })]],
    ["another order type", [order({ orderType: 1 })]],
    ["another unit", [order({ unitId: "foreign" })]],
    ["another project", [order({ projectId: "foreign" })]],
    ["missing unit", [order({ unitId: undefined })]],
    ["missing project", [order({ projectId: undefined })]],
    ["not settled", [order({ status: 1 })]],
    ["no linked order", []],
    [
      "additional charged order",
      [
        order(),
        order({ requestNo: "OTHER", status: 1, price: 218, transAmount: 218 }),
      ],
    ],
  ];
  for (const [label, orders] of cases)
    await t.test(label, async () => {
      const f = fixture({ orders });
      await assert.rejects(f.cancel(), matches("FREE_BOOKING_UNCONFIRMED"));
      assert.equal(f.writes().length, 0);
    });
});

test("paid, unknown-price, started and other free facilities remain outside current-booking cancellation", async (t) => {
  for (const [label, changes] of [
    ["paid tennis", { pricing: 2.18, paidTotal: 2.18 }],
    ["missing total", { paidTotal: undefined }],
    ["different facility", { facilityName: "Function Room" }],
    [
      "started tennis",
      { startTime: "2026.09.10 20:00:00", endTime: "2026.09.10 22:00:00" },
    ],
  ])
    await t.test(label, async () => {
      const f = fixture({ current: [booking(changes)] });
      await assert.rejects(f.cancel(), matches("BOOKING_NOT_PENDING"));
      assert.equal(f.writes().length, 0);
    });
});

test("ordinary unpaid cancellation is preserved but a newly settled payment blocks it", async () => {
  const options = {
    current: [],
    unpaid: [booking({ status: 0, pricing: 2.18, paidTotal: 2.18 })],
    orders: [order({ status: 1, price: 218, transAmount: 218 })],
  };
  const f = fixture(options);
  assert.equal((await f.cancel()).status, "cancelled");
  assert.equal(f.writes().length, 1);
  const paid = fixture({
    ...options,
    orders: [order({ status: 2, price: 218, transAmount: 218 })],
  });
  await assert.rejects(paid.cancel(), matches("BOOKING_NOT_PENDING"));
  assert.equal(paid.writes().length, 0);
});

test("a settled zero-value order does not promote an unpaid reservation to confirmed access", async () => {
  const f = fixture({
    current: [],
    unpaid: [booking({ status: 0 })],
    orders: [order({ status: 2 })],
  });
  const payment = await f.portal.bookingPayment(f.session, BOOKING);
  assert.equal(payment.status, "free");
  assert.equal(payment.booking.tab, "unpaid");
  assert.equal(payment.canCancel, false);

  const resumed = await f.portal.resumePayment(f.session, BOOKING, {
    confirm: true,
  });
  assert.equal(resumed.status, "free");
  assert.equal(resumed.booking.tab, "unpaid");
  assert.equal(resumed.canCancel, false);
  await assert.rejects(f.access(), matches("BOOKING_NOT_CONFIRMED"));
  await assert.rejects(f.cancel(), matches("BOOKING_NOT_PENDING"));
  assert.equal(
    f.calls.some((call) =>
      ["createOrder", "cancelBooking", "bookingQr", "qrConfig"].includes(
        call.op,
      ),
    ),
    false,
  );

  // Access and free cancellation become available only after a subsequent
  // authenticated booking-list read actually places the record in current.
  f.state.unpaid = [];
  f.state.current = [booking()];
  const confirmed = await f.portal.bookingPayment(f.session, BOOKING);
  assert.equal(confirmed.status, "free");
  assert.equal(confirmed.booking.tab, "current");
  assert.equal(confirmed.canCancel, true);
  assert.deepEqual((await f.access()).images, [
    { src: PNG, label: "Entry code 1" },
  ]);
  assert.equal((await f.cancel()).status, "cancelled");
  assert.equal(f.writes().length, 1);
});

test("foreign bookings, unconfirmed actions and read-only mode never send cancellation", async (t) => {
  for (const [label, current] of [
    ["different unit", [booking({ unitId: "foreign" })]],
    ["different project", [booking({ projectId: "foreign" })]],
    ["missing booking", []],
  ])
    await t.test(label, async () => {
      const f = fixture({ current });
      await assert.rejects(f.cancel(), matches("BOOKING_NOT_FOUND"));
      assert.equal(f.writes().length, 0);
    });
  const f = fixture();
  await assert.rejects(
    f.cancel({ confirm: false }),
    matches("CONFIRMATION_REQUIRED"),
  );
  assert.equal(f.calls.length, 0);
  const readOnly = fixture({ readOnly: true });
  await assert.rejects(readOnly.cancel(), matches("READ_ONLY"));
  assert.equal(readOnly.calls.length, 0);
});

test("retained records or failed verification produce uncertainty, never false success or an automatic retry", async (t) => {
  await t.test("still current", async () => {
    const f = fixture({
      override: async (op) => (op === "cancelBooking" ? {} : undefined),
    });
    await assert.rejects(f.cancel(), matches("OUTCOME_UNCERTAIN"));
    assert.equal(f.writes().length, 1);
  });
  await t.test("moved to unpaid", async () => {
    const f = fixture({
      override: async (op, body, context, state) => {
        if (op !== "cancelBooking") return undefined;
        state.unpaid = state.current;
        state.current = [];
        return {};
      },
    });
    await assert.rejects(f.cancel(), matches("OUTCOME_UNCERTAIN"));
    assert.equal(f.writes().length, 1);
  });
  await t.test("verification disconnected", async () => {
    const f = fixture({
      override: async (op, body, context, state, calls) => {
        if (
          op === "bookings" &&
          calls.some((call) => call.op === "cancelBooking")
        )
          throw new AppError("Offline", 502, "UPSTREAM_UNREACHABLE");
      },
    });
    await assert.rejects(f.cancel(), matches("OUTCOME_UNCERTAIN"));
    assert.equal(f.writes().length, 1);
  });
  await t.test("write timeout", async () => {
    const f = fixture({
      override: async (op) => {
        if (op === "cancelBooking")
          throw new AppError("Timeout", 502, "UPSTREAM_UNREACHABLE");
      },
    });
    await assert.rejects(f.cancel(), matches("OUTCOME_UNCERTAIN"));
    assert.equal(f.writes().length, 1);
  });
  await t.test("estate policy rejection", async () => {
    const f = fixture({
      override: async (op) => {
        if (op === "cancelBooking")
          throw new AppError("Cancellation is closed", 422, "ESTATE_REJECTED");
      },
    });
    await assert.rejects(f.cancel(), matches("ESTATE_REJECTED"));
    assert.equal(f.writes().length, 1);
  });
});

test("duplicate cancellation and unit switching are blocked while a reservation mutation is pending", async () => {
  const started = deferred();
  const finish = deferred();
  const f = fixture({
    override: async (op) => {
      if (op === "cancelBooking") {
        started.resolve();
        await finish.promise;
      }
    },
  });
  const first = f.cancel();
  await started.promise;
  try {
    await assert.rejects(f.cancel(), matches("BOOKING_IN_PROGRESS"));
    assert.throws(
      () => f.portal.switchUnit(f.session, f.secondUnit.unitId),
      matches("BOOKING_IN_PROGRESS"),
    );
  } finally {
    finish.resolve();
  }
  assert.equal((await first).status, "cancelled");
  assert.equal(f.writes().length, 1);
});

test("booking access uses the current selected-unit record and exact long identifiers", async () => {
  const f = fixture();
  const result = await f.access();
  assert.equal(result.booking.id, BOOKING);
  assert.deepEqual(result.images, [{ src: PNG, label: "Entry code 1" }]);
  assert.equal(result.refreshMs, 10_000);
  assert.equal(result.updatedAt, NOW);
  assert.deepEqual(
    f.calls.filter((call) => ["qrConfig", "bookingQr"].includes(call.op)),
    [
      {
        op: "qrConfig",
        body: { code: "001" },
        context: { token: f.session.token, unitId: UNIT, userType: 0 },
      },
      {
        op: "bookingQr",
        body: { unitId: UNIT, bookingId: BOOKING },
        context: { token: f.session.token, unitId: UNIT, userType: 0 },
      },
    ],
  );
  assert.equal(f.writes().length, 0);
});

test("unpaid, ended, malformed-time, missing and foreign bookings cannot request access codes", async (t) => {
  const cases = [
    [
      "unpaid",
      { current: [], unpaid: [booking({ status: 0 })] },
      "BOOKING_NOT_CONFIRMED",
    ],
    [
      "ended",
      { current: [booking({ endTime: "2026.09.10 21:00:00" })] },
      "BOOKING_ENDED",
    ],
    [
      "invalid end time",
      { current: [booking({ endTime: "not-a-date" })] },
      "BOOKING_ENDED",
    ],
    ["missing", { current: [] }, "BOOKING_NOT_FOUND"],
    [
      "foreign unit",
      { current: [booking({ unitId: "foreign" })] },
      "BOOKING_NOT_FOUND",
    ],
    [
      "foreign project",
      { current: [booking({ projectId: "foreign" })] },
      "BOOKING_NOT_FOUND",
    ],
  ];
  for (const [label, options, code] of cases)
    await t.test(label, async () => {
      const f = fixture(options);
      await assert.rejects(f.access(), matches(code));
      assert.equal(
        f.calls.some((call) => ["qrConfig", "bookingQr"].includes(call.op)),
        false,
      );
    });
});

test("a QR response arriving after a unit switch is rejected rather than shown for the new unit", async () => {
  const started = deferred();
  const finish = deferred();
  const f = fixture({
    override: async (op) => {
      if (op === "bookingQr") {
        started.resolve();
        await finish.promise;
      }
    },
  });
  const pending = f.access();
  await started.promise;
  f.portal.switchUnit(f.session, f.secondUnit.unitId);
  finish.resolve();
  await assert.rejects(pending, matches("UNIT_CHANGED"));
  const call = f.calls.find((item) => item.op === "bookingQr");
  assert.equal(call.body.unitId, UNIT);
  assert.equal(call.context.unitId, UNIT);
});
