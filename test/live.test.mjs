import test from "node:test";
import assert from "node:assert/strict";
import { createLiveRequest } from "../pages/live.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";
import { API_BASE, ROUTES, WRITE_OPERATIONS } from "../lib/upstream.mjs";

function fixture(options = {}) {
  let clock = Date.parse("2026-09-05T08:00:00Z");
  const now = () => clock;
  const estate = createDemoUpstream({ now });
  const requests = [];
  const client = createLiveRequest({
    now,
    readOnly: options.readOnly || false,
    fetchImpl: async (url, init) => {
      const operation = Object.keys(ROUTES).find(
        (name) => API_BASE + ROUTES[name] === url,
      );
      assert.ok(operation, "Request must use an allowlisted estate endpoint.");
      assert.equal(init.method, "POST");
      assert.equal(init.credentials, "omit");
      assert.equal(init.mode, "cors");
      assert.equal(init.cache, "no-store");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(init.redirect, "error");
      requests.push({ operation, init });
      const headers = new Headers(init.headers);
      if (options.before) await options.before(operation);
      const value = await estate(operation, JSON.parse(init.body), {
        token: headers.get("token"),
        unitId: headers.get("unitId"),
        userType: headers.get("userType"),
      });
      return new Response(JSON.stringify({ code: 1200, data: value }));
    },
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
  const login = async () => {
    const response = await request("/api/login", {
      phoneOrEmail: "demo",
      cipher: "demo",
    });
    assert.equal(response.status, 200);
    const view = await response.json();
    csrf = view.csrfToken;
    return view;
  };
  return {
    client,
    request,
    login,
    requests,
    estate,
    advance: (ms) => (clock += ms),
  };
}

test("live browser client authenticates only against the estate and never returns its bearer token to the UI", async () => {
  const f = fixture();
  assert.equal((await f.request("/api/session")).status, 401);
  const config = await (await f.request("/api/config")).json();
  assert.equal(config.demo, false);
  assert.equal(config.browserClient, true);
  const view = await f.login();
  assert.equal(view.token, undefined);
  assert.equal(JSON.stringify(view).includes("local-demo-token"), false);
  assert.equal(view.units.length, 2);
  assert.equal((await (await f.request("/api/facilities")).json()).length, 11);
  assert.equal(f.requests[0].init.headers.token, "");
  assert.equal(f.requests[1].init.headers.token, "local-demo-token");
  const calls = f.requests.length;
  assert.equal(
    (await f.request("https://example.com/api/facilities")).status,
    403,
  );
  assert.equal(
    (await f.request("/api/unit", { unitId: "foreign-unit" })).status,
    403,
  );
  assert.equal(f.requests.length, calls);
  assert.equal((await f.request("/api/logout", {})).status, 200);
  assert.equal((await f.request("/api/session")).status, 401);
});

test("browser sessions expire and disposal prevents a later request from reusing the token", async () => {
  const f = fixture();
  await f.login();
  f.advance(2 * 60 * 60_000 + 1);
  assert.equal((await f.request("/api/session")).status, 401);
  await f.login();
  const before = f.requests.length;
  f.client.dispose();
  assert.equal((await f.request("/api/facilities")).status, 401);
  assert.equal(f.requests.length, before);
  assert.equal(
    (
      await createLiveRequest({
        fetchImpl: () => {
          throw new Error("Must not contact network");
        },
      })("/api/session")
    ).status,
    401,
  );
});

test("browser booking requires an explicit reviewed confirmation, and repeated confirmation inserts once", async () => {
  const f = fixture();
  await f.login();
  const facilities = await (await f.request("/api/facilities")).json();
  const availability = await (
    await f.request(
      `/api/facilities/${facilities[0].id}/availability?date=2026-09-06`,
    )
  ).json();
  const payload = {
    facilityId: facilities[0].id,
    slotId: availability.slots[0].id,
    date: "2026-09-06",
    quantity: 1,
    rulesAccepted: true,
  };
  const preview = await (
    await f.request("/api/bookings/preview", payload)
  ).json();
  assert.equal(
    f.requests.filter((r) => WRITE_OPERATIONS.has(r.operation)).length,
    0,
  );
  assert.equal(
    (await f.request("/api/bookings/commit", { previewId: preview.previewId }))
      .status,
    400,
  );
  const confirmations = await Promise.all(
    [1, 2].map(() =>
      f.request("/api/bookings/commit", {
        previewId: preview.previewId,
        confirm: true,
      }),
    ),
  );
  assert.equal(confirmations[0].status, 200);
  assert.equal(confirmations[1].status, 200);
  const first = await confirmations[0].json();
  assert.equal(first.status, "payment_pending");
  assert.equal(
    f.requests.filter((r) => r.operation === "insertBooking").length,
    1,
  );
  assert.equal(
    f.requests.filter((r) => r.operation === "createOrder").length,
    1,
  );
  const bookings = await (await f.request("/api/bookings?tab=unpaid")).json();
  assert.equal(bookings[0].id, first.bookingId);
});

test("read-only verification of the live browser client cannot send estate mutations", async () => {
  const f = fixture({ readOnly: true });
  await f.login();
  for (const path of ["/api/bookings", "/api/bookings/commit"])
    assert.equal((await f.request(path, { confirm: true })).status, 403);
  assert.equal(
    f.requests.some((r) => WRITE_OPERATIONS.has(r.operation)),
    false,
  );
});

test("a delayed response from a discarded browser session cannot replace a newer sign-in", async () => {
  let release;
  let started;
  const began = new Promise((resolve) => (started = resolve));
  const hold = new Promise((resolve) => (release = resolve));
  const f = fixture({
    before: async (operation) => {
      if (operation === "facilities") {
        started();
        await hold;
      }
    },
  });
  await f.login();
  const pending = f.request("/api/facilities");
  await began;
  f.client.dispose();
  await f.login();
  release();
  assert.equal((await pending).status, 409);
  assert.equal((await f.request("/api/session")).status, 200);
});
