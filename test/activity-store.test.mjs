import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  ACTIVITY_DATABASE,
  ACTIVITY_LIMITS,
  activityScopeFromSession,
  createActivityStore,
  summarizeActivity,
} from "../public/activity-store.js";

const unit = {
  unitId: "9876543210987654321",
  projectId: "1111111111111111111",
  userType: 0,
};
const session = { user: { id: "1234567890123456789" }, units: [unit], unit };
const scope = activityScopeFromSession(session);
const date = Date.parse("2026-09-10T13:00:00Z");
const booking = {
  id: "9999999999999999999",
  facilityId: "2222222222222222222",
  facilityName: "Tennis Court (Off-Peak)",
  startTime: "2026-10-01 18:00:00",
  endTime: "2026-10-01 19:00:00",
  quantity: 1,
  price: 0,
  amount: 0,
  tab: "current",
  orderTime: "2026-09-01 12:30:00",
  createdAt: "2026-09-01 12:30:01",
};

async function raw(database, action = null) {
  const db = await new Promise((resolve, reject) => {
    const request = database.open(ACTIVITY_DATABASE, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        "activity",
        action ? "readwrite" : "readonly",
      );
      const store = transaction.objectStore("activity");
      let result;
      if (action) action(store);
      else {
        const request = store.getAll();
        request.onsuccess = () => {
          result = request.result;
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

test("activity scope requires the authenticated owner association and keeps exact IDs", () => {
  assert.deepEqual(scope, {
    ownerId: session.user.id,
    projectId: unit.projectId,
    unitId: unit.unitId,
  });
  assert.throws(() => activityScopeFromSession(null));
  assert.throws(() =>
    activityScopeFromSession({
      ...session,
      unit: { ...unit, unitId: "foreign" },
    }),
  );
  assert.throws(() =>
    activityScopeFromSession({ ...session, units: [{ ...unit, userType: 1 }] }),
  );
  assert.throws(() =>
    activityScopeFromSession({ ...session, user: { id: 1234567890123456789 } }),
  );
  const injected = { ...unit, ownerId: "foreign", password: "secret" };
  assert.deepEqual(
    activityScopeFromSession({ ...session, units: [injected] }),
    scope,
  );
});

test("activity reopens encrypted and exported fields exclude credentials, QR data, and arbitrary nested properties", async () => {
  const database = new IDBFactory();
  const store = createActivityStore({ indexedDB: database, now: () => date });
  const secrets = {
    password: "PRIVATE_PASSWORD",
    token: "PRIVATE_TOKEN",
    qrPayload: "PRIVATE_QR",
    nested: { secret: "PRIVATE_NESTED" },
  };
  const result = await store.observe({ ...scope, ...secrets }, [
    { ...booking, ...secrets },
  ]);
  assert.equal(result.persistent, true);
  const [record] = await raw(database);
  assert.equal(record.key.extractable, false);
  assert.equal(record.key.algorithm.name, "AES-GCM");
  await assert.rejects(crypto.subtle.exportKey("raw", record.key));
  assert.equal(JSON.stringify(record).includes(scope.ownerId), false);
  assert.equal(JSON.stringify(record).includes(booking.id), false);
  assert.equal(JSON.stringify(record).includes("Tennis"), false);
  const reopened = createActivityStore({
    indexedDB: database,
    now: () => date,
  });
  const loaded = await reopened.load(scope);
  assert.equal(loaded.observations[0].id, booking.id);
  assert.equal(loaded.observations[0].orderTime, booking.orderTime);
  assert.equal(
    loaded.observations[0].firstObservedAt,
    "2026-09-10T13:00:00.000Z",
  );
  const exported = await reopened.export(scope);
  for (const value of [
    "PRIVATE_PASSWORD",
    "PRIVATE_TOKEN",
    "PRIVATE_QR",
    "PRIVATE_NESTED",
  ])
    assert.equal(exported.includes(value), false);
  assert.match(JSON.parse(exported).coverage, /Not a complete estate history/);
  assert.equal(JSON.parse(exported).persistent, true);
});

test("observations deduplicate exact IDs, preserve distinct timestamps, and do not invent cancellation from missing rows", async () => {
  let now = date;
  const store = createActivityStore({
    indexedDB: new IDBFactory(),
    now: () => now,
  });
  await store.observe(scope, [booking, { ...booking }]);
  now += 60_000;
  let result = await store.observe(
    scope,
    [{ ...booking, createdAt: null, orderTime: null }],
    { tab: "history" },
  );
  assert.equal(result.observations.length, 1);
  assert.equal(
    result.observations[0].firstObservedAt,
    new Date(date).toISOString(),
  );
  assert.equal(
    result.observations[0].lastObservedAt,
    new Date(now).toISOString(),
  );
  assert.equal(result.observations[0].createdAt, booking.createdAt);
  assert.equal(result.observations[0].orderTime, booking.orderTime);
  assert.equal(result.observations[0].tab, "history");
  result = await store.observe(scope, [], { tab: "current" });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].tab, "history");
  assert.deepEqual(result.events, []);
  assert.equal("cancelledAt" in result.observations[0], false);
});

test("history is the canonical exported tab and the older past alias migrates to it", async () => {
  const database = new IDBFactory();
  const store = createActivityStore({ indexedDB: database, now: () => date });
  await store.observe(scope, [{ ...booking, tab: "past" }]);
  const reopened = createActivityStore({
    indexedDB: database,
    now: () => date,
  });
  const result = await reopened.load(scope);
  assert.equal(result.observations[0].tab, "history");
  assert.equal(
    summarizeActivity(result, { month: "2026-10" }).byBookingMonth
      .lastObservedConfirmed,
    1,
  );
  assert.equal(
    JSON.parse(await reopened.export(scope)).observations[0].tab,
    "history",
  );
});

test("uncertain actions survive refresh and resolve once with their original attempt timestamp", async () => {
  const database = new IDBFactory();
  const store = createActivityStore({ indexedDB: database, now: () => date });
  const pending = await store.recordAction(scope, {
    action: "cancellation",
    outcome: "uncertain",
    booking,
    token: "PRIVATE_ACTION_TOKEN",
    error: { message: "PRIVATE_ERROR" },
  });
  const reopened = createActivityStore({
    indexedDB: database,
    now: () => date + 5000,
  });
  assert.equal((await reopened.load(scope)).events[0].outcome, "uncertain");
  const resolved = await reopened.recordAction(scope, {
    id: pending.event.id,
    action: "cancellation",
    outcome: "success",
    booking,
    attemptedAt: "2020-01-01T00:00:00Z",
    response: { token: "PRIVATE_RESPONSE" },
  });
  assert.equal(resolved.event.id, pending.event.id);
  assert.equal(resolved.event.attemptedAt, pending.event.attemptedAt);
  assert.equal(resolved.event.resolvedAt, new Date(date + 5000).toISOString());
  assert.equal((await reopened.load(scope)).events.length, 1);
  assert.equal((await reopened.export(scope)).includes("PRIVATE_"), false);
  await assert.rejects(
    reopened.recordAction(scope, {
      id: pending.event.id,
      action: "cancellation",
      outcome: "failed",
      booking,
    }),
    /resolved action/,
  );
  await assert.rejects(
    reopened.recordAction(scope, {
      id: pending.event.id,
      action: "cancellation",
      outcome: "success",
      booking: { ...booking, id: "different" },
    }),
    /another booking/,
  );
});

test("a booking action can acquire its server ID later; unknown results are not success or quota", async () => {
  const store = createActivityStore({
    indexedDB: new IDBFactory(),
    now: () => date,
  });
  const attempt = await store.recordAction(scope, {
    action: "booking",
    outcome: "uncertain",
    booking: { ...booking, id: "" },
  });
  assert.equal(attempt.event.booking.id, "");
  assert.equal(attempt.event.resolvedAt, null);
  await store.recordAction(scope, {
    id: attempt.event.id,
    action: "booking",
    outcome: "success",
    booking,
  });
  const failed = await store.recordAction(scope, {
    action: "booking",
    outcome: "failed",
    booking,
    errorCode: "ESTATE_REJECTED",
    message: "PRIVATE_MESSAGE",
  });
  assert.equal(failed.event.errorCode, "ESTATE_REJECTED");
  await assert.rejects(
    store.recordAction(scope, {
      action: "cancellation",
      outcome: "uncertain",
      booking: {},
    }),
    /identifier/,
  );
  await assert.rejects(
    store.recordAction(scope, {
      id: "not-an-existing-event",
      action: "booking",
      outcome: "success",
      booking,
    }),
    /not found/,
  );
  const result = await store.load(scope);
  assert.equal(result.events.length, 2);
  assert.equal(result.observations.length, 0);
  assert.equal("quotaRemaining" in result, false);
});

test("owner, unit and project scopes isolate logs; clear removes only the selected scope", async () => {
  const database = new IDBFactory();
  const store = createActivityStore({ indexedDB: database, now: () => date });
  const scopes = [
    scope,
    { ...scope, ownerId: "other-owner" },
    { ...scope, unitId: "other-unit" },
    { ...scope, projectId: "other-project" },
  ];
  for (const [index, selected] of scopes.entries())
    await store.observe(selected, [{ ...booking, id: `booking-${index}` }]);
  for (const [index, selected] of scopes.entries())
    assert.deepEqual(
      (await store.load(selected)).observations.map((row) => row.id),
      [`booking-${index}`],
    );
  const cleared = await store.clear(scope);
  assert.equal(cleared.startedAt, null);
  assert.deepEqual(cleared.observations, []);
  const reopened = createActivityStore({
    indexedDB: database,
    now: () => date,
  });
  assert.deepEqual((await reopened.load(scope)).observations, []);
  assert.equal((await reopened.load(scopes[1])).observations.length, 1);
});

test("concurrent tabs merge independent actions instead of losing an update", async () => {
  const database = new IDBFactory();
  const first = createActivityStore({ indexedDB: database, now: () => date });
  const second = createActivityStore({ indexedDB: database, now: () => date });
  await Promise.all([
    first.recordAction(scope, {
      action: "booking",
      outcome: "failed",
      booking,
    }),
    second.recordAction(scope, {
      action: "cancellation",
      outcome: "uncertain",
      booking,
    }),
  ]);
  const result = await first.load(scope);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((event) => event.action).sort(), [
    "booking",
    "cancellation",
  ]);
});

test("clear queued while activity encrypts cannot allow the old event to reappear", async () => {
  const database = new IDBFactory();
  const store = createActivityStore({ indexedDB: database, now: () => date });
  await Promise.all([
    store.recordAction(scope, {
      action: "cancellation",
      outcome: "uncertain",
      booking,
    }),
    store.clear(scope),
  ]);
  const result = await createActivityStore({ indexedDB: database }).load(scope);
  assert.equal(result.events.length, 0);
  assert.equal(result.startedAt, null);
});

test("clearing in another tab rejects a write already in flight, including the first-ever write", async () => {
  for (const existing of [false, true]) {
    const database = new IDBFactory();
    let pause = false;
    let unblock;
    let announce;
    const blocked = new Promise((resolve) => {
      unblock = resolve;
    });
    const started = new Promise((resolve) => {
      announce = resolve;
    });
    const delayedCrypto = {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      subtle: new Proxy(crypto.subtle, {
        get(target, property) {
          if (property === "encrypt")
            return async (...args) => {
              if (pause) {
                announce();
                await blocked;
              }
              return target.encrypt(...args);
            };
          return typeof target[property] === "function"
            ? target[property].bind(target)
            : target[property];
        },
      }),
    };
    const first = createActivityStore({
      indexedDB: database,
      crypto: delayedCrypto,
      now: () => date,
    });
    const second = createActivityStore({
      indexedDB: database,
      now: () => date,
    });
    if (existing) await first.observe(scope, [booking]);
    pause = true;
    const writing = first.recordAction(scope, {
      action: "cancellation",
      outcome: "uncertain",
      booking,
    });
    await started;
    await second.clear(scope);
    await second.observe(scope, [
      { ...booking, id: "new-observation-after-clear" },
    ]);
    const rejected = assert.rejects(writing, /cleared in another tab/);
    unblock();
    await rejected;
    assert.deepEqual((await second.load(scope)).events, []);
    assert.deepEqual(
      (await second.load(scope)).observations.map((row) => row.id),
      ["new-observation-after-clear"],
    );
  }
});

test("unsupported persistent storage falls back to a clearly flagged temporary per-scope log", async () => {
  const store = createActivityStore({
    indexedDB: null,
    crypto: null,
    now: () => date,
  });
  assert.equal(store.available, false);
  const observed = await store.observe(scope, [booking]);
  assert.equal(observed.persistent, false);
  assert.match(observed.storageError, /will not survive a refresh/);
  const event = await store.recordAction(scope, {
    action: "cancellation",
    outcome: "uncertain",
    booking,
  });
  assert.ok(event.event.id);
  assert.equal(event.persistent, false);
  assert.equal((await store.load(scope)).events.length, 1);
  assert.equal(
    (await store.load({ ...scope, ownerId: "different" })).events.length,
    0,
  );
  assert.equal(JSON.parse(await store.export(scope)).observations.length, 1);
  assert.equal(
    (await createActivityStore({ indexedDB: null }).load(scope)).observations
      .length,
    0,
  );
  assert.equal((await store.clear(scope)).events.length, 0);
});

test("unreadable saved activity is not silently deleted or overwritten, and explicit clear recovers storage", async () => {
  const database = new IDBFactory();
  const store = createActivityStore({ indexedDB: database, now: () => date });
  await store.observe(scope, [booking]);
  await raw(database, (objectStore) => {
    const request = objectStore.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      const record = cursor.value;
      const bytes = new Uint8Array(record.ciphertext.slice(0));
      bytes[0] ^= 1;
      cursor.update({ ...record, ciphertext: bytes.buffer });
    };
  });
  const reopened = createActivityStore({
    indexedDB: database,
    now: () => date,
  });
  const result = await reopened.load(scope);
  assert.equal(result.persistent, false);
  assert.match(result.storageError, /could not be opened/);
  const [before] = await raw(database);
  await reopened.recordAction(scope, {
    action: "booking",
    outcome: "uncertain",
    booking,
  });
  const [after] = await raw(database);
  assert.deepEqual(
    new Uint8Array(after.ciphertext),
    new Uint8Array(before.ciphertext),
  );
  assert.equal((await reopened.clear(scope)).persistent, true);
  assert.deepEqual(
    (await createActivityStore({ indexedDB: database }).load(scope)).events,
    [],
  );
});

test("storage denial preserves the action in memory and reports that it was not durably saved", async () => {
  const denied = {
    open() {
      const request = {};
      queueMicrotask(() => request.onerror());
      return request;
    },
  };
  const store = createActivityStore({ indexedDB: denied, now: () => date });
  const result = await store.recordAction(scope, {
    action: "cancellation",
    outcome: "uncertain",
    booking,
  });
  assert.equal(result.persistent, false);
  assert.match(result.storageError, /temporary/);
  assert.equal((await store.load(scope)).events.length, 1);
  await assert.rejects(store.clear(scope), /could not be cleared/);
});

test("retention is bounded with explicit truncation counters and no time-based expiry", async () => {
  const database = new IDBFactory();
  const store = createActivityStore({ indexedDB: database, now: () => date });
  const rows = Array.from(
    { length: ACTIVITY_LIMITS.observations + 1 },
    (_, i) => ({ ...booking, id: `booking-${i}` }),
  );
  const result = await store.observe(scope, rows);
  assert.equal(result.observations.length, ACTIVITY_LIMITS.observations);
  assert.equal(result.truncated.observations, 1);
  const yearsLater = createActivityStore({
    indexedDB: database,
    now: () => Date.parse("2040-01-01T00:00:00Z"),
  });
  assert.equal(
    (await yearsLater.load(scope)).observations.length,
    ACTIVITY_LIMITS.observations,
  );
  assert.equal(
    JSON.parse(await yearsLater.export(scope)).truncated.observations,
    1,
  );
});

test("monthly summary separates facility-use month from device-action month in Singapore time", async () => {
  const store = createActivityStore({
    indexedDB: new IDBFactory(),
    now: () => date,
  });
  await store.observe(scope, [
    booking,
    {
      ...booking,
      id: "boundary",
      tab: "history",
      startTime: "2026-09-30T17:00:00Z",
      endTime: "2026-09-30T18:00:00Z",
    },
  ]);
  await store.recordAction(scope, {
    action: "cancellation",
    outcome: "success",
    booking,
  });
  await store.recordAction(scope, {
    action: "booking",
    outcome: "uncertain",
    booking,
  });
  const log = await store.load(scope);
  const september = summarizeActivity(log, { month: "2026-09" });
  assert.equal(september.byBookingMonth.observedBookings, 0);
  assert.equal(september.byActionMonth.cancellationSuccess, 1);
  assert.equal(september.byActionMonth.bookingUncertain, 1);
  assert.equal(september.byActionMonth.bookingSuccess, 0);
  const october = summarizeActivity(log, { month: "2026-10" });
  assert.equal(october.byBookingMonth.observedBookings, 2);
  assert.equal(october.byBookingMonth.lastObservedConfirmed, 2);
  assert.equal(october.byBookingMonth.lastObservedZeroAmount, 2);
  assert.equal(october.byActionMonth.cancellationSuccess, 0);
  assert.equal(JSON.stringify(october).includes("quotaRemaining"), false);
  assert.throws(
    () => summarizeActivity(log, { month: "2026-13" }),
    /valid activity month/,
  );
});
