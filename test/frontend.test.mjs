import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { createApplication } from "../server.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";
import {
  AppError,
  WRITE_OPERATIONS,
  API_BASE,
  ROUTES,
} from "../lib/upstream.mjs";
import { createDemoRequest } from "../pages/runtime.mjs";
import { createLiveRequest } from "../pages/live.mjs";
import {
  entryPassFromSession,
  createEntryQr,
  ENTRY_REFRESH_MS,
} from "../public/entry-pass.js";
import { createPassStore } from "../public/pass-store.js";
import { IDBFactory } from "fake-indexeddb";
import { createPaymentQr } from "../public/payment-qr.js";

const html = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const sourceModule = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
// jsdom evaluates the DOM controller outside its module loader. Bind the real
// imported helpers below; the production module graph is verified separately.
const source = sourceModule.replace(
  /^import\s*\{[^}]*\}\s*from\s*["']\.\/(?:entry-pass|pass-store|payment-qr)\.js["'];\s*/gm,
  "",
);

async function fixture(t, options = {}) {
  const now = options.now || (() => Date.parse("2026-09-05T08:00:00Z"));
  const demo = createDemoUpstream({ now });
  const calls = [];
  const upstream = async (op, body, context) => {
    calls.push(op);
    if (options.override) {
      const overridden = await options.override(op, body, context, demo);
      if (overridden !== undefined) return overridden;
    }
    return demo(op, body, context);
  };
  const app = createApplication({
    upstream,
    now,
    demo: true,
    readOnly: options.readOnly || false,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const consoleErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => consoleErrors.push(error.message));
  const dom = new JSDOM(html, {
    url:
      options.staticDemo || options.browserLive
        ? "https://lproperty.github.io/Sesame/"
        : origin,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.Date.now = now;
  window.entryPassFromSession = entryPassFromSession;
  window.createEntryQr = createEntryQr;
  window.createPaymentQr = createPaymentQr;
  window.ENTRY_REFRESH_MS = ENTRY_REFRESH_MS;
  const passDatabase = options.passDatabase || new IDBFactory();
  window.createPassStore = () =>
    createPassStore({
      indexedDB: passDatabase,
      crypto: globalThis.crypto,
      now,
    });
  let cookie = "";
  let activeRequests = 0;
  const networkAttempts = [];
  window.fetch = async (path, init = {}) => {
    networkAttempts.push(path);
    if (options.staticDemo || options.browserLive)
      throw new Error("The hosted UI must use its dedicated browser adapter.");
    const target = new URL(path, origin);
    assert.equal(
      target.origin,
      origin,
      "Frontend tests may only call their isolated local mock server.",
    );
    activeRequests++;
    try {
      const response = await fetch(target, {
        ...init,
        headers: { ...init.headers, cookie },
      });
      const next = response.headers.get("set-cookie");
      if (next) cookie = next.split(";")[0];
      return response;
    } finally {
      activeRequests--;
    }
  };
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // jsdom has no layout engine or native modal implementation. These shims only
  // model open/close state; real focus trapping and rendering are not asserted.
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event("close"));
  };
  if (options.staticDemo) window.sesameRequest = createDemoRequest({ now });
  const estateRequests = [];
  if (options.browserLive)
    window.sesameRequest = createLiveRequest({
      now,
      payment: {
        payee: "Example estate",
        uen: "EXAMPLE-UEN",
        bankName: "Example bank",
        bankAccount: "EXAMPLE-ACCOUNT",
        email: "payments@example.invalid",
        qrText: "SAMPLE PAYMENT ONLY",
      },
      readOnly: options.readOnly || false,
      fetchImpl: async (url, init) => {
        estateRequests.push({ url, init });
        const operation = Object.keys(ROUTES).find(
          (key) => API_BASE + ROUTES[key] === url,
        );
        assert.ok(operation, "Only the fixed estate routes are accepted.");
        assert.equal(init.credentials, "omit");
        assert.equal(init.mode, "cors");
        assert.equal(init.cache, "no-store");
        assert.equal(init.referrerPolicy, "no-referrer");
        const headers = new Headers(init.headers);
        try {
          const result = await upstream(operation, JSON.parse(init.body), {
            token: headers.get("token"),
            unitId: headers.get("unitId"),
            userType: headers.get("userType"),
          });
          return new Response(JSON.stringify({ code: 1200, data: result }));
        } catch (error) {
          return new Response(
            JSON.stringify({
              code: error.status === 401 ? 1401 : 1400,
              message: error.message,
            }),
            { status: error.status || 500 },
          );
        }
      },
    });
  window.eval(source);
  const query = (selector) => window.document.querySelector(selector);
  const all = (selector) => [...window.document.querySelectorAll(selector)];
  const until = async (condition, label) => {
    const deadline = Date.now() + 4000;
    while (!condition()) {
      if (Date.now() > deadline)
        throw new Error(
          `Timed out: ${label}\n${window.document.body.textContent.slice(-1800)}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  t.after(async () => {
    await until(() => activeRequests === 0, "outstanding requests settle");
    window.close();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  });
  await until(
    () => (options.savedEntry ? query("#entry-qr svg") : query("#login-form")),
    options.savedEntry ? "saved entry QR" : "login form",
  );
  const submit = (form) =>
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  const change = (target) =>
    target.dispatchEvent(new window.Event("change", { bubbles: true }));
  const login = async ({ stayOnQr = false } = {}) => {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search + "#/qr",
    );
    if (options.browserLive) {
      query("#username").value = "demo";
      query("#password").value = "demo";
    }
    submit(query("#login-form"));
    await until(() => query("#entry-qr svg"), "entry QR after sign-in");
    if (!stayOnQr) {
      query('.mobile-nav a[href="#/facilities"]').click();
      await until(() => all(".facility-card").length === 11, "facility list");
    }
  };
  const chooseSlot = async () => {
    all(".facility-card")[0].click();
    await until(
      () => query("#booking-date") && all(".slot").length,
      "facility slots",
    );
    query("#booking-date").value = "2026-09-06";
    change(query("#booking-date"));
    await until(
      () => all(".slot:not(:disabled)").length === 2,
      "tomorrow availability",
    );
    query(".slot:not(:disabled)").click();
  };
  return {
    window,
    query,
    all,
    until,
    submit,
    change,
    login,
    chooseSlot,
    demo,
    calls,
    consoleErrors,
    networkAttempts,
    estateRequests,
    passDatabase,
    readSavedPass: () =>
      createPassStore({
        indexedDB: passDatabase,
        crypto: globalThis.crypto,
        now,
      }).load(),
    writes: () => calls.filter((op) => WRITE_OPERATIONS.has(op)),
  };
}

for (const browserLive of [false, true]) {
  test(`existing pending reservation supports payment and cancellation in ${browserLive ? "Pages" : "local server"} UI`, async (t) => {
    const f = await fixture(t, { browserLive });
    f.demo.bookings.push({
      id: "existing-booking",
      facilityId: "demo-facility-1",
      facilityDetailId: "demo-facility-1-2026-09-06-0",
      unitId: "demo-unit-1",
      facilityName: "Jewel Function Room 1",
      startTime: "2026-09-06 09:00:00",
      endTime: "2026-09-06 15:00:00",
      bookingNum: 1,
      pricing: 116.35,
      paidTotal: 116.35,
      status: 0,
    });
    f.demo.orders.set("EXISTING-ORDER", {
      requestNo: "EXISTING-ORDER",
      makeId: "existing-booking",
      orderType: 0,
      unitId: "demo-unit-1",
      status: 1,
      transType: "LOCAL_CASH",
    });
    await f.login();
    f.window.location.hash = "#/bookings/unpaid";
    await f.until(
      () => f.query('[data-action="booking-details"]'),
      "existing reservation",
    );
    f.query('[data-action="booking-details"]').click();
    assert.ok(f.query('[data-action="complete-payment"]'));
    assert.ok(f.query('[data-action="cancel-booking"]'));
    f.query('[data-action="complete-payment"]').click();
    await f.until(
      () => /EXISTING-ORDER/.test(f.query("#modal").textContent),
      "recovered order",
    );
    assert.match(f.query("#modal").textContent, /S\$116.35/);
    if (browserLive) assert.ok(f.query(".payment-qr svg"));
    else assert.equal(f.query(".payment-qr"), null);
    assert.equal(
      f.writes().length,
      0,
      "Existing payments must not create another reservation or order",
    );
    f.query('[data-action="payment-status"]').click();
    await f.until(
      () => !f.query('[data-action="payment-status"]').disabled,
      "payment check",
    );
    assert.match(f.query("#payment-status").textContent, /still pending/);
    f.query('[data-action="cancel-booking"]').click();
    assert.match(f.query("#modal").textContent, /Cancel this reservation/);
    f.query('[data-action="booking-details"]').click();
    assert.equal(
      f.writes().length,
      0,
      "Keeping the reservation must not cancel it",
    );
    f.query('[data-action="cancel-booking"]').click();
    f.query('[data-action="confirm-cancel-booking"]').click();
    await f.until(
      () => !f.query("#modal").open && f.query(".empty-state"),
      "cancelled reservation removed",
    );
    assert.deepEqual(f.writes(), ["cancelBooking"]);
    assert.equal(f.demo.bookings.length, 0);
    assert.deepEqual(f.consoleErrors, []);
  });
}

test("paid reservation status removes payment and cancellation controls and refreshes the pending list", async (t) => {
  const f = await fixture(t, { browserLive: true });
  await f.login();
  await f.chooseSlot();
  f.query("#book-submit").click();
  await f.until(() => f.query('[data-action="go-bookings"]'), "booking result");
  f.query('[data-action="go-bookings"]').click();
  await f.until(
    () => f.query('[data-action="booking-details"]'),
    "pending reservation",
  );
  f.query('[data-action="booking-details"]').click();
  f.demo.orders.get("DEMO-00001").status = 2;
  f.query('[data-action="payment-status"]').click();
  await f.until(
    () => /Payment received/.test(f.query("#payment-status")?.textContent),
    "paid status",
  );
  assert.equal(f.query('[data-action="complete-payment"]'), null);
  assert.equal(f.query('[data-action="cancel-booking"]'), null);
  assert.equal(f.all(".booking-row").length, 0);
  assert.deepEqual(f.consoleErrors, []);
});

test("a declined cancellation remains visible and can be dismissed without removing the booking", async (t) => {
  const f = await fixture(t, {
    override: async (operation) => {
      if (operation === "cancelBooking")
        throw new AppError(
          "Cancellation declined by the estate.",
          422,
          "ESTATE_REJECTED",
        );
    },
  });
  await f.login();
  await f.chooseSlot();
  f.query("#book-submit").click();
  await f.until(() => f.query('[data-action="go-bookings"]'), "booking result");
  f.query('[data-action="go-bookings"]').click();
  await f.until(
    () => f.query('[data-action="booking-details"]'),
    "pending reservation",
  );
  f.query('[data-action="booking-details"]').click();
  f.query('[data-action="cancel-booking"]').click();
  f.query('[data-action="confirm-cancel-booking"]').click();
  await f.until(
    () =>
      /Cancellation declined/.test(f.query("#reservation-error")?.textContent),
    "estate cancellation error",
  );
  assert.equal(
    f.query('[data-action="confirm-cancel-booking"]').disabled,
    false,
  );
  assert.equal(f.all(".booking-row").length, 1);
  f.query('[data-action="booking-details"]').click();
  assert.ok(f.query('[data-action="complete-payment"]'));
  assert.deepEqual(f.consoleErrors, []);
});

test("frontend signs in, filters, previews, submits once to the simulator, and shows its pending booking", async (t) => {
  const f = await fixture(t);
  assert.equal(f.query("#username").value, "demo");
  f.query('[data-action="toggle-password"]').click();
  assert.equal(f.query("#password").type, "text");
  await f.login();
  assert.equal(f.window.localStorage.length, 0);
  assert.equal(f.window.sessionStorage.length, 0);
  assert.equal(
    f.window.document.body.innerHTML.includes("local-demo-token"),
    false,
  );
  f.query("#facility-search").value = "tennis";
  f.query("#facility-search").dispatchEvent(
    new f.window.Event("input", { bubbles: true }),
  );
  assert.equal(f.all(".facility-card").length, 1);
  assert.match(f.query(".facility-card").textContent, /Tennis Court/);
  f.query("#facility-search").value = "";
  f.query("#facility-search").dispatchEvent(
    new f.window.Event("input", { bubbles: true }),
  );
  await f.chooseSlot();
  assert.equal(f.writes().length, 0);
  assert.match(f.query("#booking-summary").textContent, /S\$116.35/);
  assert.equal(f.query("#modal").open, false);
  assert.equal(f.query("#book-submit").disabled, false);
  assert.equal(f.query('input[type="checkbox"]'), null);
  f.query("#book-submit").click();
  f.query("#book-submit").click();
  await f.until(
    () => f.query('[data-action="go-bookings"]'),
    "submission result",
  );
  assert.equal(f.writes().filter((op) => op === "insertBooking").length, 1);
  assert.equal(f.writes().filter((op) => op === "createOrder").length, 1);
  assert.equal(
    f.query(".payment-qr"),
    null,
    "Demo must not show a real payment QR.",
  );
  f.query('[data-action="go-bookings"]').click();
  await f.until(() => f.all(".booking-row").length === 1, "pending booking");
  f.query('[data-action="booking-details"]').click();
  assert.match(f.query("#modal").textContent, /DEMO-00001/);
  f.query('[data-action="payment-status"]').click();
  await f.until(
    () => /still pending/.test(f.query("#payment-status")?.textContent),
    "payment status",
  );
  f.query('[data-action="close-modal"]').click();
  f.query("#unit-select").value = "demo-unit-2";
  f.change(f.query("#unit-select"));
  await f.until(() => f.all(".facility-card").length === 11, "switched unit");
  f.window.location.hash = "#/bookings/unpaid";
  await f.until(() => f.query(".empty-state"), "other unit has no bookings");
  f.query('[data-action="logout"]').click();
  await f.until(() => f.query("#login-form"), "signed out");
  assert.deepEqual(f.consoleErrors, []);
});

test("Pages UI has no credential form, keeps assets and sign-out under the repository path, and uses mobile navigation", async (t) => {
  const f = await fixture(t, { staticDemo: true });
  assert.equal(f.query("#username"), null);
  assert.equal(f.query('input[type="password"]'), null);
  assert.match(
    f.query(".demo-hint").textContent,
    /not an official estate service/,
  );
  assert.equal(
    f.query(".login-photo").getAttribute("src"),
    "/Sesame/assets/estate.jpg",
  );
  await f.login();
  assert.equal(f.window.sesameRequest, undefined);
  assert.match(f.query(".mode-banner").textContent, /PUBLIC DEMO/);
  assert.equal(
    f.query('.mobile-nav [aria-current="page"]').textContent.trim(),
    "Facilities",
  );
  f.query('.mobile-nav a[href="#/bookings"]').click();
  await f.until(() => f.query(".booking-tabs"), "mobile booking navigation");
  assert.match(
    f.query('.mobile-nav [aria-current="page"]').textContent,
    /My bookings/,
  );
  f.query('.mobile-nav [data-action="logout"]').click();
  await f.until(() => f.query("#login-form"), "exit public demo");
  assert.equal(f.window.location.pathname, "/Sesame/");
  assert.equal(f.window.location.hash, "");
  assert.equal(f.query("#username"), null);
  assert.equal(f.window.document.cookie, "");
  assert.equal(f.window.localStorage.length, 0);
  assert.equal(f.window.sessionStorage.length, 0);
  assert.deepEqual(f.networkAttempts, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.consoleErrors, []);
});

test("Pages booking flow creates only a simulated reservation and never displays live payment instructions", async (t) => {
  const f = await fixture(t, { staticDemo: true });
  await f.login();
  await f.chooseSlot();
  assert.equal(f.query("#modal").open, false);
  assert.equal(f.query("#book-submit").disabled, false);
  assert.equal(f.query('input[type="checkbox"]'), null);
  f.query("#book-submit").click();
  f.query("#book-submit").click();
  await f.until(
    () => f.query('[data-action="go-bookings"]'),
    "simulated result",
  );
  assert.match(f.query("#modal").textContent, /No payment is needed/);
  assert.equal(f.query(".payment-qr"), null);
  assert.equal(f.query(".bank-details"), null);
  f.query('[data-action="go-bookings"]').click();
  await f.until(
    () => f.all(".booking-row").length === 1,
    "one simulated reservation",
  );
  assert.equal(
    f.window.document.documentElement.classList.contains("modal-open"),
    false,
  );
  f.query('[data-action="booking-details"]').click();
  f.query('[data-action="payment-status"]').click();
  await f.until(
    () => /still pending/.test(f.query("#payment-status")?.textContent),
    "simulated payment status",
  );
  f.query('[data-action="complete-payment"]').click();
  await f.until(
    () =>
      !f.query('[data-action="complete-payment"]').disabled &&
      /No payment is needed/.test(f.query("#modal").textContent),
    "simulated payment instructions",
  );
  f.query('[data-action="cancel-booking"]').click();
  f.query('[data-action="confirm-cancel-booking"]').click();
  await f.until(
    () => !f.query("#modal").open && f.query(".empty-state"),
    "simulated cancellation",
  );
  assert.deepEqual(f.networkAttempts, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.consoleErrors, []);
});

test("live Pages UI signs in and completes the real booking flow against a mocked estate API", async (t) => {
  const f = await fixture(t, { browserLive: true });
  assert.equal(f.query("#username").value, "");
  assert.equal(f.query("#password").value, "");
  assert.match(
    f.query(".login-footnote").textContent,
    /directly to your estate over HTTPS/,
  );
  await f.login();
  assert.equal(f.query(".mode-banner"), null);
  assert.equal(f.window.sesameRequest, undefined);
  assert.equal(
    f.window.document.body.innerHTML.includes("local-demo-token"),
    false,
  );
  await f.chooseSlot();
  assert.equal(f.query("#modal").open, false);
  assert.equal(f.query("#book-submit").disabled, false);
  assert.equal(f.query('input[type="checkbox"]'), null);
  f.query("#book-submit").click();
  f.query("#book-submit").click();
  await f.until(() => f.query(".bank-details"), "live payment instructions");
  assert.equal(f.writes().filter((op) => op === "insertBooking").length, 1);
  assert.equal(f.writes().filter((op) => op === "createOrder").length, 1);
  assert.ok(f.query(".payment-qr svg"));
  assert.match(f.query(".bank-grid").textContent, /Example estate/);
  assert.equal(
    f.query(".payment-instructions a").getAttribute("href"),
    "mailto:payments@example.invalid",
  );
  f.query('[data-action="go-bookings"]').click();
  await f.until(
    () => f.all(".booking-row").length === 1,
    "live pending booking",
  );
  f.query('.mobile-nav [data-action="logout"]').click();
  await f.until(() => f.query("#login-form"), "live sign-out");
  assert.equal(f.window.location.pathname, "/Sesame/");
  assert.equal(f.window.document.cookie, "");
  assert.equal(f.window.localStorage.length, 0);
  assert.equal(f.window.sessionStorage.length, 0);
  assert.deepEqual(f.networkAttempts, []);
  assert.deepEqual(f.consoleErrors, []);
});

test("entry QR is the first signed-in screen and a saved pass opens without an estate login", async (t) => {
  const database = new IDBFactory();
  const first = await fixture(t, { browserLive: true, passDatabase: database });
  await first.login({ stayOnQr: true });
  assert.match(
    first.query('.mobile-nav [aria-current="page"]').textContent,
    /My QR/,
  );
  assert.equal(first.all(".facility-card").length, 0);
  assert.equal(first.calls.includes("facilities"), false);
  assert.match(first.query("#entry-status").textContent, /Ready to scan/);
  first.query('[data-action="save-entry"]').click();
  await first.until(() => first.query(".entry-saved"), "pass saved explicitly");
  first.window.dispatchEvent(new first.window.Event("pagehide"));
  const reopened = await fixture(t, {
    browserLive: true,
    passDatabase: database,
    savedEntry: true,
  });
  assert.equal(reopened.query("#login-form"), null);
  assert.deepEqual(reopened.calls, []);
  assert.match(
    reopened.query(".entry-note").textContent,
    /Sign in when you want to book/,
  );
  reopened.query('.mobile-nav a[href="#/facilities"]').click();
  await reopened.until(
    () => reopened.query("#login-form"),
    "booking still requires authentication",
  );
  assert.deepEqual(reopened.calls, []);
  reopened.query('[data-action="show-entry"]').click();
  await reopened.until(
    () => reopened.query("#entry-qr svg"),
    "back to saved QR",
  );
  reopened.query('[data-action="forget-entry"]').click();
  await reopened.until(
    () => reopened.query("#login-form"),
    "saved pass removed",
  );
  assert.equal(await reopened.readSavedPass(), null);
});

test("signing in as a different owner removes the previously saved entry identity", async (t) => {
  const database = new IDBFactory();
  const first = await fixture(t, { browserLive: true, passDatabase: database });
  await first.login({ stayOnQr: true });
  first.query('[data-action="save-entry"]').click();
  await first.until(() => first.query(".entry-saved"), "first owner saved");
  first.window.dispatchEvent(new first.window.Event("pagehide"));
  const next = await fixture(t, {
    browserLive: true,
    passDatabase: database,
    savedEntry: true,
    override: async (operation, body, context, demo) => {
      if (operation === "login") {
        const response = await demo(operation, body, context);
        response.ownerLoginOutDTO.id = "another-demo-owner";
        return response;
      }
    },
  });
  next.query('.mobile-nav a[href="#/facilities"]').click();
  await next.until(() => next.query("#login-form"), "second owner login");
  await next.login({ stayOnQr: true });
  assert.equal(await next.readSavedPass(), null);
  assert.equal(next.query(".entry-saved"), null);
});

test("returning to Sesame shows a fresh QR and preserves an open profile or booking dialog", async (t) => {
  const f = await fixture(t, { browserLive: true });
  await f.login();
  let hidden = true;
  Object.defineProperty(f.window.document, "hidden", { get: () => hidden });
  f.window.document.dispatchEvent(new f.window.Event("visibilitychange"));
  hidden = false;
  f.window.document.dispatchEvent(new f.window.Event("visibilitychange"));
  await f.until(() => f.query("#entry-qr svg"), "QR on return");
  hidden = true;
  f.window.document.dispatchEvent(new f.window.Event("visibilitychange"));
  assert.equal(
    f.query("#entry-qr svg"),
    null,
    "No stale QR remains while hidden.",
  );
  f.query("#modal").open = true;
  hidden = false;
  f.window.document.dispatchEvent(new f.window.Event("visibilitychange"));
  assert.equal(f.query("#modal").open, true);
  assert.equal(
    f.query("#entry-qr svg"),
    null,
    "Returning must not discard an active dialog.",
  );
});

test("refreshing the entry screen past Singapore midnight updates the booking date", async (t) => {
  let time = Date.parse("2026-09-05T15:59:50Z");
  const f = await fixture(t, { browserLive: true, now: () => time });
  await f.login({ stayOnQr: true });
  time += 20_000;
  f.query('[data-action="refresh-entry"]').click();
  await f.until(() => f.query("#entry-qr svg"), "QR refreshed after midnight");
  f.query('.mobile-nav a[href="#/facilities"]').click();
  await f.until(
    () => f.all(".facility-card").length === 11,
    "facilities after midnight",
  );
  f.query(".facility-card").click();
  await f.until(() => f.query("#booking-date"), "booking date after midnight");
  assert.equal(f.query("#booking-date").value, "2026-09-06");
});

test("sign-out clears a saved entry pass as well as the live session", async (t) => {
  const f = await fixture(t, { browserLive: true });
  await f.login({ stayOnQr: true });
  f.query('[data-action="save-entry"]').click();
  await f.until(() => f.query(".entry-saved"), "saved pass");
  f.query('.mobile-nav [data-action="logout"]').click();
  await f.until(() => f.query("#login-form"), "signed out");
  assert.equal(await f.readSavedPass(), null);
  assert.equal(f.query("#entry-qr svg"), null);
});

test("read-only frontend shows the booking summary with submission disabled", async (t) => {
  const f = await fixture(t, { readOnly: true });
  await f.login();
  await f.chooseSlot();
  assert.equal(f.query("#book-submit").disabled, true);
  f.query("#book-submit").click();
  assert.equal(f.writes().length, 0);
  assert.equal(f.query("#modal").open, false);
});

test("disabled estate slots cannot be selected and rules are sanitized before display", async (t) => {
  const f = await fixture(t, {
    override: async (op, body, context, demo) => {
      if (op === "availability")
        return (await demo(op, body, context)).map((s) => ({
          ...s,
          status: 0,
        }));
      if (op === "facility")
        return {
          ...(await demo(op, body, context)),
          regulations:
            '<p onclick="window.injected=1">Safe rules</p><script>window.injected=1</script><img onerror="window.injected=1" src="https://evil.example/x"><svg onload="window.injected=1"></svg>',
        };
    },
  });
  await f.login();
  f.all(".facility-card")[0].click();
  await f.until(() => f.all(".slot").length === 2, "unavailable slots");
  assert.equal(f.all(".slot:not(:disabled)").length, 0);
  assert.match(
    f.query(".not-released").textContent,
    /currently marks these times unavailable/,
  );
  assert.equal(f.query(".rules-content script"), null);
  assert.equal(f.query(".rules-content img"), null);
  assert.equal(f.query(".rules-content [onclick]"), null);
  assert.equal(f.window.injected, undefined);
  assert.equal(f.writes().length, 0);
});

test("missing email and temporary-password flags do not add a local booking gate", async (t) => {
  const f = await fixture(t, {
    browserLive: true,
    override: async (operation, body, context, demo) => {
      if (operation === "login") {
        const result = await demo(operation, body, context);
        result.ownerLoginOutDTO.email = "";
        result.ownerLoginOutDTO.isTmp = 1;
        return result;
      }
    },
  });
  await f.login();
  await f.chooseSlot();
  assert.equal(f.query(".profile-banner"), null);
  assert.equal(f.query("#profile-form"), null);
  assert.equal(f.query("#book-submit").disabled, false);
  f.query("#book-submit").click();
  await f.until(
    () => f.query(".bank-details"),
    "booking without app-only profile gate",
  );
  assert.equal(
    f.writes().filter((operation) => operation === "insertBooking").length,
    1,
  );
  assert.equal(
    f.calls.some((operation) => /profile|passwordCode/.test(operation)),
    false,
  );
});

test("an expired estate token returns the frontend to sign-in and removes the protected view", async (t) => {
  let expired = false;
  const f = await fixture(t, {
    override: async (op) => {
      if (op === "facility" && expired)
        throw new AppError("Please sign in again.", 401, "SESSION_EXPIRED");
    },
  });
  await f.login();
  expired = true;
  f.all(".facility-card")[0].click();
  await f.until(() => f.query("#login-form"), "expired-session login screen");
  assert.match(f.query("#login-error").textContent, /sign in again/);
  assert.equal(f.query(".sidebar"), null);
  assert.equal(f.query(".facility-card"), null);
  assert.equal(f.writes().length, 0);
  assert.deepEqual(f.consoleErrors, []);
});

test("a changed price is shown inline without booking at an unapproved amount", async (t) => {
  const f = await fixture(t, { browserLive: true });
  await f.login();
  await f.chooseSlot();
  f.demo.facilities[0].pricing = 150;
  f.query("#book-submit").click();
  await f.until(
    () => /price.*changed/.test(f.query("#booking-summary")?.textContent),
    "changed price message",
  );
  assert.equal(f.writes().length, 0);
  assert.equal(f.query("#modal").open, false);
});

test("an estate rejection is shown without launching profile verification", async (t) => {
  const f = await fixture(t, {
    browserLive: true,
    override: async (operation) => {
      if (operation === "insertBooking")
        throw new AppError(
          "The estate requires an email address.",
          422,
          "ESTATE_REJECTED",
        );
    },
  });
  await f.login();
  await f.chooseSlot();
  f.query("#book-submit").click();
  await f.until(
    () =>
      /estate requires an email/.test(f.query("#booking-summary")?.textContent),
    "estate message",
  );
  assert.equal(f.query("#profile-form"), null);
  assert.equal(f.calls.includes("createOrder"), false);
});
