import test from "node:test";
import assert from "node:assert/strict";
import { createLiveRequest, SESSION_STORAGE_KEY } from "../pages/live.mjs";
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
  f.open = () => {
    const client = createLiveRequest({ storage, now, fetchImpl });
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

test("refresh restores the selected owner unit without another login or stale booking data", async () => {
  assert.equal(SESSION_STORAGE_KEY, "sesame-owner-session-v1");
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

test("refresh preserves the original idle deadline and persists subsequent activity", async () => {
  const f = fixture();
  const first = f.open();
  await first.login();
  first.client.suspend();
  f.advance(2 * HOUR);
  assert.equal((await f.open().request("/api/session")).status, 401);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), null);

  const next = f.open();
  await next.login();
  next.client.suspend();
  f.advance(HOUR);
  const active = f.open();
  await active.session();
  active.client.suspend();
  f.advance(HOUR + 1);
  const later = f.open();
  await later.session();
  later.client.suspend();
  f.advance(2 * HOUR);
  assert.equal((await f.open().request("/api/session")).status, 401);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), null);
});

test("repeated refreshes and activity cannot renew the twelve-hour absolute lifetime", async () => {
  const f = fixture();
  let active = f.open();
  await active.login();
  for (let hour = 1; hour < 12; hour++) {
    active.client.suspend();
    f.advance(HOUR);
    active = f.open();
    await active.session();
  }
  active.client.suspend();
  f.advance(HOUR);
  assert.equal((await f.open().request("/api/session")).status, 401);
  assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), null);
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
      assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), null);
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
      assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), null);
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
      assert.equal(storage.getItem(SESSION_STORAGE_KEY), null);
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
      assert.equal(f.storage.getItem(SESSION_STORAGE_KEY), null);
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
