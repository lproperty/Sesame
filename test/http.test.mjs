import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApplication } from "../server.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";

async function start(t, options = {}) {
  const now = () => Date.parse("2026-09-05T08:00:00Z");
  const upstream = createDemoUpstream({ now });
  const app = createApplication({ upstream, now, demo: true, ...options });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phoneOrEmail: "demo", cipher: "demo" }),
  });
  const setCookie = login.headers.get("set-cookie");
  const session = await login.json();
  const cookie = setCookie.split(";")[0];
  const request = (path, data, headers = {}) =>
    fetch(url + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        cookie,
        ...(data === undefined
          ? {}
          : {
              "content-type": "application/json",
              "x-csrf-token": session.csrfToken,
            }),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  return { ...app, url, upstream, session, cookie, setCookie, request };
}

test("HTTP app provides safe sessions, working assets and private-only routing", async (t) => {
  const f = await start(t);
  assert.match(f.setCookie, /HttpOnly/);
  assert.match(f.setCookie, /SameSite=Strict/);
  assert.equal(f.session.token, undefined);
  assert.equal((await f.request("/api/session")).status, 200);
  const page = await fetch(f.url + "/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.match(await page.text(), /Grand Dunman/);
  for (const path of [
    "/app.js",
    "/styles.css",
    "/assets/estate.jpg",
    "/assets/function-room.png",
  ])
    assert.equal((await fetch(f.url + path)).status, 200, path);
  for (const path of [
    "/temp-creds",
    "/lib/credentials.mjs",
    "/.env",
    "/..%5Ctemp-creds",
    "/api/proxy",
  ])
    assert.equal((await f.request(path)).status, 404, path);
  assert.equal((await fetch(f.url + "/api/facilities")).status, 401);
});

test("foreign origins, DNS-rebinding Host headers, and missing CSRF cannot mutate state", async (t) => {
  const f = await start(t);
  const cross = await f.request(
    "/api/unit",
    { unitId: "demo-unit-2" },
    { origin: "https://evil.example" },
  );
  assert.equal(cross.status, 403);
  const noCsrf = await fetch(f.url + "/api/unit", {
    method: "POST",
    headers: { cookie: f.cookie, "content-type": "application/json" },
    body: JSON.stringify({ unitId: "demo-unit-2" }),
  });
  assert.equal(noCsrf.status, 403);
  const unicodeCsrf = await f.request(
    "/api/unit",
    { unitId: "demo-unit-2" },
    { "x-csrf-token": "x".repeat(43) },
  );
  assert.equal(unicodeCsrf.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    http
      .get(
        f.url + "/api/config",
        { headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal(
    (await (await f.request("/api/session")).json()).unit.unitId,
    "demo-unit-1",
  );
});

test("read-only HTTP session can browse and preview but every write is refused", async (t) => {
  const f = await start(t, { readOnly: true });
  assert.equal((await (await f.request("/api/config")).json()).readOnly, true);
  const facilities = await (await f.request("/api/facilities")).json();
  assert.equal(facilities.length, 11);
  const availability = await (
    await f.request(
      `/api/facilities/${facilities[0].id}/availability?date=2026-09-06`,
    )
  ).json();
  const preview = await (
    await f.request("/api/bookings/preview", {
      facilityId: facilities[0].id,
      slotId: availability.slots[0].id,
      date: "2026-09-06",
      quantity: 1,
      rulesAccepted: true,
    })
  ).json();
  assert.ok(preview.previewId);
  const before = f.upstream.calls.length;
  assert.equal(
    (
      await f.request("/api/bookings/commit", {
        previewId: preview.previewId,
        confirm: true,
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/profile/code", { email: "example@example.com" }))
      .status,
    403,
  );
  assert.equal(
    (await f.request("/api/profile/complete", { confirm: true })).status,
    403,
  );
  assert.equal(f.upstream.calls.length, before);
  assert.equal(
    (await (await f.request("/api/bookings?tab=unpaid")).json()).length,
    0,
  );
  assert.equal((await f.request("/api/logout", {})).status, 200);
  assert.equal((await f.request("/api/session")).status, 401);
});

test("expired and logged-out sessions cannot continue to read owner data", async (t) => {
  let current = Date.parse("2026-09-05T08:00:00Z");
  const f = await start(t, { now: () => current });
  current += 2 * 60 * 60_000 + 1;
  assert.equal((await f.request("/api/session")).status, 401);
  assert.equal((await f.request("/api/facilities")).status, 401);
});
