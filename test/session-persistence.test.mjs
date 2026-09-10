import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiveRequest,
  SESSION_STORAGE_KEY,
  LEGACY_SESSION_STORAGE_KEY,
} from "../pages/live.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";
import { API_BASE, ROUTES, WRITE_OPERATIONS } from "../lib/upstream.mjs";

const HOUR = 60 * 60_000;
const INITIAL_TIME = Date.parse("2026-09-05T08:00:00Z");

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function fixture(storage = memoryStorage()) {
  let clock = INITIAL_TIME;
  const now = () => clock;
  const estate = createDemoUpstream({ now });
  const requests = [];
  const f = {
    storage,
    requests,
    before: null,
    override: null,
    advance: (ms) => (clock += ms),
  };
  const fetchImpl = async (url, init) => {
    const operation = Object.keys(ROUTES).find(
      (name) => API_BASE + ROUTES[name] === url,
    );
    assert.ok(
      operation,
      "Only the synthetic estate's allowlisted API is used.",
    );
    const body = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    const context = {
      token: headers.get("token"),
      unitId: headers.get("unitId"),
      userType: headers.get("userType"),
    };
    requests.push({ operation, body, context });
    if (f.before) await f.before(operation);
    const overridden = await f.override?.(operation);
    if (overridden !== undefined) return overridden;
    const data = await estate(operation, body, context);
    return new Response(JSON.stringify({ code: 1200, data }));
  };
  f.open = (options = {}) => {
    const client = createLiveRequest({
      storage,
      now,
      fetchImpl,
      legacyStorage: null,
      ...options,
    });
    let csrf = "";
    const request = async (path, body) =>
      client(
        path,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-csrf-token": csrf,
              },
              body: JSON.stringify(body),
            },
      );
    const view = async (path, body) => {
      const response = await request(path, body);
      assert.equal(response.status, 200);
      const value = await response.json();
      csrf = value.csrfToken;
      return value;
    };
    return {
      client,
      request,
      session: () => view("/api/session"),
      login: () => view("/api/login", { phoneOrEmail: "demo", cipher: "demo" }),
      unit: (unitId) => view("/api/unit", { unitId }),
    };
  };
  return f;
}

async function preview(handle) {
  const facilities = await (await handle.request("/api/facilities")).json();
  const availability = await (
    await handle.request(
      `/api/facilities/${facilities[0].id}/availability?date=2026-09-06`,
    )
  ).json();
  const response = await handle.request("/api/bookings/preview", {
    facilityId: facilities[0].id,
    slotId: availability.slots[0].id,
    date: "2026-09-06",
    quantity: 1,
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("an old tab cannot restore a logout or overwrite a newer login on suspension", async () => {
  const f = fixture();
  const first = f.open();
  await first.login();
  const stale = f.open();
  await stale.session();
  await first.request("/api/logout", {});
  const marker = f.storage.getItem(SESSION_STORAGE_KEY);
  stale.client.suspend();
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), marker);
  assert.equal((await f.open().request("/api/session")).status, 401);
  const newer = f.open();
  await newer.login();
  const replacement = f.storage.getItem(SESSION_STORAGE_KEY);
  stale.client.dispose();
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), replacement);
  await f.open().session();
});

test("another tab's logout is checked before any estate request", async () => {
  const f = fixture();
  const first = f.open();
  await first.login();
  const second = f.open();
  await second.session();
  await first.request("/api/logout", {});
  const count = f.requests.length;
  assert.equal((await second.request("/api/facilities")).status, 401);
  assert.equal(f.requests.length, count);
});

test("an old request's expired-token response cannot clear a newer saved login", async () => {
  const f = fixture();
  const first = f.open();
  await first.login();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.before = (op) => (op === "facilities" ? gate : undefined);
  f.override = (op) =>
    op === "facilities"
      ? new Response(JSON.stringify({ code: 1401, message: "Expired" }), {
          status: 401,
        })
      : undefined;
  const oldRequest = first.request("/api/facilities");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newer = f.open();
  await newer.login();
  const saved = f.storage.getItem(SESSION_STORAGE_KEY);
  release();
  assert.equal((await oldRequest).status, 401);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), saved);
  await f.open().session();
});

test("a delayed sign-in cannot overwrite a later cross-tab logout or account replacement", async (t) => {
  for (const replace of [false, true])
    await t.test(replace ? "new login" : "logout", async () => {
      const f = fixture();
      const first = f.open();
      await first.login();
      const other = f.open();
      await other.session();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let held = false;
      f.before = (op) => {
        if (op === "login" && !held) {
          held = true;
          return gate;
        }
      };
      const late = first.request("/api/login", {
        phoneOrEmail: "demo",
        cipher: "demo",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (replace) await other.login();
      else await other.request("/api/logout", {});
      const saved = f.storage.getItem(SESSION_STORAGE_KEY);
      release();
      assert.equal((await late).status, 409);
      assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), saved);
    });
});

test("old tab logins migrate once without obsolete client deadlines and cannot undo logout", async () => {
  const f = fixture();
  const original = f.open();
  await original.login();
  const record = JSON.parse(f.storage.getItem(SESSION_STORAGE_KEY));
  const legacy = { ...record, version: 1, expiresAt: 1, lastSeen: 1 };
  delete legacy.sessionId;
  original.client.suspend();
  f.storage.removeItem(SESSION_STORAGE_KEY);
  const tabStore = memoryStorage();
  tabStore.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy));
  const migrated = f.open({ legacyStorage: tabStore });
  const view = await migrated.session();
  assert.equal(view.user.id, record.user.id);
  assert.equal(tabStore.getItem(LEGACY_SESSION_STORAGE_KEY), null);
  assert.equal(JSON.parse(f.storage.getItem(SESSION_STORAGE_KEY)).version, 2);
  await migrated.request("/api/logout", {});
  const staleTab = memoryStorage();
  staleTab.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy));
  assert.equal(
    (await f.open({ legacyStorage: staleTab }).request("/api/session")).status,
    401,
  );
  assert.equal(staleTab.getItem(LEGACY_SESSION_STORAGE_KEY), null);
});

test("default storage survives a fresh tab with an empty sessionStorage", async () => {
  const localDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const sessionDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const durable = memoryStorage();
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: durable,
    });
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    const f = fixture();
    const first = f.open({ storage: undefined, legacyStorage: undefined });
    await first.login();
    first.client.suspend();
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: memoryStorage(),
    });
    f.advance(45 * 24 * HOUR);
    const fresh = f.open({ storage: undefined, legacyStorage: undefined });
    assert.equal((await fresh.session()).loginPersistence, "device");
    assert.equal(
      f.requests.filter((row) => row.operation === "login").length,
      1,
    );
  } finally {
    if (localDescriptor)
      Object.defineProperty(globalThis, "localStorage", localDescriptor);
    else delete globalThis.localStorage;
    if (sessionDescriptor)
      Object.defineProperty(globalThis, "sessionStorage", sessionDescriptor);
    else delete globalThis.sessionStorage;
  }
});

test("a failed account-switch save cannot revive the older account after explicit sign-out", async () => {
  const storage = memoryStorage();
  const f = fixture(storage);
  const first = f.open();
  await first.login();
  const old = storage.getItem(SESSION_STORAGE_KEY);
  const write = storage.setItem,
    remove = storage.removeItem;
  let blocked = true;
  storage.setItem = (key, value) => {
    if (blocked) throw new Error("Synthetic denied write");
    write(key, value);
  };
  storage.removeItem = (key) => {
    if (blocked) throw new Error("Synthetic denied removal");
    remove(key);
  };
  f.override = (op) =>
    op === "login"
      ? new Response(
          JSON.stringify({
            code: 1200,
            data: {
              token: "local-demo-token",
              ownerLoginOutDTO: { id: "other-owner", username: "Other owner" },
            },
          }),
        )
      : undefined;
  const second = f.open();
  const signedIn = await second.login();
  assert.equal(signedIn.user.id, "other-owner");
  assert.equal(signedIn.loginPersistence, "memory");
  assert.equal(storage.getItem(SESSION_STORAGE_KEY), old);
  blocked = false;
  assert.equal((await second.request("/api/logout", {})).status, 200);
  assert.equal(
    JSON.parse(storage.getItem(SESSION_STORAGE_KEY)).signedOut,
    true,
  );
  assert.equal((await f.open().request("/api/session")).status, 401);
});

test("storage events invalidate the old in-memory page without erasing its replacement", async () => {
  const target = new EventTarget();
  let invalidations = 0;
  target.addEventListener("sesame-session-ended", () => invalidations++);
  const f = fixture();
  const first = f.open({ eventTarget: target });
  await first.login();
  const second = f.open();
  await second.login();
  const saved = f.storage.getItem(SESSION_STORAGE_KEY);
  const event = new Event("storage");
  Object.defineProperty(event, "key", { value: SESSION_STORAGE_KEY });
  target.dispatchEvent(event);
  assert.equal(invalidations, 1);
  assert.equal((await first.request("/api/session")).status, 401);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), saved);
  first.client.suspend();
  target.dispatchEvent(event);
  assert.equal(invalidations, 1);
});

test("refresh restores the selected owner unit without another login or stale booking data", async () => {
  assert.equal(SESSION_STORAGE_KEY, "sesame-owner-session-v2");
  const f = fixture();
  const first = f.open();
  const signedIn = await first.login();
  await first.unit("demo-unit-2");
  const oldPreview = await preview(first);
  const saved = f.storage.getItem(SESSION_STORAGE_KEY);
  assert.ok(saved);
  assert.ok(saved.includes("local-demo-token"));
  for (const field of [
    "cipher",
    "password",
    "phoneOrEmail",
    "email",
    "phone",
    "quotes",
    "facilities",
    "actions",
  ])
    assert.equal(new RegExp(`"${field}"\\s*:`).test(saved), false, field);
  assert.equal(saved.includes(oldPreview.previewId), false);

  first.client.suspend();
  assert.equal((await first.request("/api/session")).status, 401);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), saved);
  const callsBeforeRestore = f.requests.length;
  const restored = f.open();
  const current = await restored.session();
  assert.equal(current.user.id, signedIn.user.id);
  assert.equal(current.unit.unitId, "demo-unit-2");
  assert.deepEqual(current.units, signedIn.units);
  assert.notEqual(current.csrfToken, signedIn.csrfToken);
  assert.equal(current.token, undefined);
  assert.equal(f.requests.length, callsBeforeRestore);

  const oldCommit = await restored.request("/api/bookings/commit", {
    previewId: oldPreview.previewId,
    confirm: true,
  });
  assert.equal(oldCommit.status, 409);
  assert.equal((await oldCommit.json()).error.code, "PREVIEW_NOT_FOUND");
  assert.equal((await restored.request("/api/facilities")).status, 200);
  assert.equal(f.requests.length, callsBeforeRestore + 1);
  assert.equal(f.requests.at(-1).context.token, "local-demo-token");
  assert.equal(f.requests.at(-1).context.unitId, "demo-unit-2");
  assert.ok((await preview(restored)).previewId);
  assert.equal(
    f.requests.some(({ operation }) => WRITE_OPERATIONS.has(operation)),
    false,
  );
});

test("closing and reopening after long inactivity keeps the issued login and selected unit", async () => {
  const f = fixture();
  const first = f.open();
  await first.login();
  await first.unit("demo-unit-2");
  const before = f.storage.getItem(SESSION_STORAGE_KEY);
  first.client.suspend();
  f.advance(35 * 24 * HOUR);
  const reopened = f.open();
  const view = await reopened.session();
  assert.equal(view.loginPersistence, "device");
  assert.equal(view.unit.unitId, "demo-unit-2");
  assert.equal((await reopened.request("/api/facilities")).status, 200);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), before);
  assert.equal(f.requests.filter((row) => row.operation === "login").length, 1);
  assert.equal(JSON.parse(before).expiresAt, undefined);
  assert.equal(JSON.parse(before).lastSeen, undefined);
});

test("repeated launches do not impose a twelve-hour or idle logout", async () => {
  const f = fixture();
  let active = f.open();
  await active.login();
  for (let launch = 0; launch < 6; launch++) {
    active.client.suspend();
    f.advance(20 * 24 * HOUR);
    active = f.open();
    await active.session();
  }
  assert.equal((await active.request("/api/facilities")).status, 200);
  assert.equal(
    f.requests.filter(({ operation }) => operation === "login").length,
    1,
  );
});

test("explicit logout and disposal remove the saved login", async (t) => {
  for (const action of ["logout", "dispose"])
    await t.test(action, async () => {
      const f = fixture();
      const active = f.open();
      await active.login();
      assert.ok(f.storage.getItem(SESSION_STORAGE_KEY));
      if (action === "logout")
        assert.equal((await active.request("/api/logout", {})).status, 200);
      else active.client.dispose();
      assert.equal(
        JSON.parse(f.storage.getItem(SESSION_STORAGE_KEY)).signedOut,
        true,
      );
      assert.equal((await active.request("/api/session")).status, 401);
      assert.equal((await f.open().request("/api/session")).status, 401);
    });
});

test("the estate rejecting an expired token clears saved authentication", async (t) => {
  for (const [status, code] of [
    [401, 1401],
    [403, 1401],
    [200, 1401],
    [200, 1402],
  ])
    await t.test(`HTTP ${status}, estate code ${code}`, async () => {
      const f = fixture();
      const active = f.open();
      await active.login();
      f.override = (operation) =>
        operation === "facilities"
          ? new Response(
              JSON.stringify({ code, message: "Session expired." }),
              {
                status,
              },
            )
          : undefined;
      const response = await active.request("/api/facilities");
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "SESSION_EXPIRED");
      assert.equal(
        JSON.parse(f.storage.getItem(SESSION_STORAGE_KEY)).signedOut,
        true,
      );
      assert.equal((await f.open().request("/api/session")).status, 401);
    });
});

test("a temporary network failure keeps the login available after refresh", async () => {
  const f = fixture();
  const active = f.open();
  await active.login();
  f.override = () => {
    throw new TypeError("Synthetic connection interruption");
  };
  const failure = await active.request("/api/facilities");
  assert.equal(failure.status, 502);
  assert.equal((await failure.json()).error.code, "UPSTREAM_UNREACHABLE");
  assert.ok(f.storage.getItem(SESSION_STORAGE_KEY));
  active.client.suspend();
  f.override = null;
  const restored = f.open();
  await restored.session();
  assert.equal((await restored.request("/api/facilities")).status, 200);
  assert.equal(
    f.requests.filter(({ operation }) => operation === "login").length,
    1,
  );
});

test("malformed saved state is discarded and does not prevent a later sign-in", async (t) => {
  for (const value of ["{", "null", "[]", "{}", '{"version":999}'])
    await t.test(value, async () => {
      const storage = memoryStorage();
      storage.setItem(SESSION_STORAGE_KEY, value);
      const f = fixture(storage);
      const active = f.open();
      assert.equal((await active.request("/api/session")).status, 401);
      assert.equal(
        JSON.parse(storage.getItem(SESSION_STORAGE_KEY)).signedOut,
        true,
      );
      assert.equal(f.requests.length, 0);
      await active.login();
      await active.session();
      assert.ok(storage.getItem(SESSION_STORAGE_KEY));
    });
});

test("unavailable browser storage falls back to a working in-memory sign-in", async () => {
  const fail = () => {
    throw new Error("Synthetic browser storage restriction");
  };
  const f = fixture({ getItem: fail, setItem: fail, removeItem: fail });
  const active = f.open();
  assert.equal((await active.request("/api/session")).status, 401);
  await active.login();
  await active.session();
  assert.equal((await active.request("/api/facilities")).status, 200);
  assert.equal((await active.request("/api/logout", {})).status, 200);
  assert.doesNotThrow(() => active.client.dispose());
  assert.equal((await f.open().request("/api/session")).status, 401);
});

test("a saved login cannot restore a foreign unit or another estate's token", async (t) => {
  for (const [label, corrupt] of [
    ["foreign unit", (record) => (record.unitId = "foreign-unit")],
    ["foreign project", (record) => (record.projectId = "foreign-project")],
    ["non-owner association", (record) => (record.units[0].userType = 1)],
    ["different API", (record) => (record.apiBase = "https://other.invalid")],
  ])
    await t.test(label, async () => {
      const f = fixture();
      const first = f.open();
      await first.login();
      first.client.suspend();
      const record = JSON.parse(f.storage.getItem(SESSION_STORAGE_KEY));
      corrupt(record);
      f.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(record));
      const calls = f.requests.length;
      assert.equal((await f.open().request("/api/session")).status, 401);
      assert.equal(
        JSON.parse(f.storage.getItem(SESSION_STORAGE_KEY)).signedOut,
        true,
      );
      assert.equal(f.requests.length, calls);
    });
});

test("a delayed sign-in cannot overwrite saved authentication after the page is suspended", async () => {
  const f = fixture();
  const active = f.open();
  await active.login();
  await active.unit("demo-unit-2");
  const saved = f.storage.getItem(SESSION_STORAGE_KEY);
  let release;
  let began;
  const held = new Promise((resolve) => (release = resolve));
  const started = new Promise((resolve) => (began = resolve));
  f.before = async (operation) => {
    if (operation !== "login") return;
    began();
    await held;
  };
  const pending = active.request("/api/login", {
    phoneOrEmail: "demo",
    cipher: "demo",
  });
  await started;
  active.client.suspend();
  release();
  assert.equal((await pending).status, 409);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), saved);
  const restored = await f.open().session();
  assert.equal(restored.unit.unitId, "demo-unit-2");
});
