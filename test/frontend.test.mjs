import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { createApplication } from "../server.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";
import { AppError, WRITE_OPERATIONS } from "../lib/upstream.mjs";
import { createDemoRequest } from "../pages/runtime.mjs";

const html = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

async function fixture(t, options = {}) {
  const now = () => Date.parse("2026-09-05T08:00:00Z");
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
    url: options.staticDemo ? "https://lproperty.github.io/Sesame/" : origin,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  let cookie = "";
  let activeRequests = 0;
  const networkAttempts = [];
  window.fetch = async (path, init = {}) => {
    networkAttempts.push(path);
    if (options.staticDemo)
      throw new Error("The public demo must not use the network.");
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
  if (options.staticDemo) window.sesameDemoRequest = createDemoRequest({ now });
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
  await until(() => query("#login-form"), "login form");
  const submit = (form) =>
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
  const change = (target) =>
    target.dispatchEvent(new window.Event("change", { bubbles: true }));
  const login = async () => {
    submit(query("#login-form"));
    await until(() => all(".facility-card").length === 11, "facility list");
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
    query('[data-action="rules"]').click();
    await until(
      () => query("#accept-rules") && !query("#accept-rules").disabled,
      "read rules",
    );
    query("#accept-rules").click();
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
    writes: () => calls.filter((op) => WRITE_OPERATIONS.has(op)),
  };
}

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
  f.query('[data-action="preview"]').click();
  await f.until(() => f.query("#confirm-booking"), "final review");
  assert.equal(
    f.writes().length,
    0,
    "Opening review must not reserve anything.",
  );
  assert.match(f.query("#modal").textContent, /demonstration booking only/);
  f.query("#confirm-booking").click();
  f.query("#confirm-booking").click();
  await f.until(
    () => f.query('[data-action="go-bookings"]'),
    "submission result",
  );
  assert.equal(f.writes().filter((op) => op === "insertBooking").length, 1);
  assert.equal(f.writes().filter((op) => op === "createOrder").length, 1);
  assert.equal(
    f.query('img[src="/assets/bank-transfer.jpg"]'),
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
  assert.equal(f.window.sesameDemoRequest, undefined);
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
  f.query('[data-action="preview"]').click();
  await f.until(() => f.query("#confirm-booking"), "public demo review");
  assert.equal(
    f.window.document.documentElement.classList.contains("modal-open"),
    true,
  );
  f.query("#confirm-booking").click();
  f.query("#confirm-booking").click();
  await f.until(
    () => f.query('[data-action="go-bookings"]'),
    "simulated result",
  );
  assert.match(f.query("#modal").textContent, /No payment is needed/);
  assert.equal(f.query('img[src$="bank-transfer.jpg"]'), null);
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
  assert.deepEqual(f.networkAttempts, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.consoleErrors, []);
});

test("read-only frontend exposes a review but disables final confirmation", async (t) => {
  const f = await fixture(t, { readOnly: true });
  await f.login();
  await f.chooseSlot();
  f.query('[data-action="preview"]').click();
  await f.until(() => f.query("#confirm-booking"), "read-only review");
  assert.equal(f.query("#confirm-booking").disabled, true);
  f.query("#confirm-booking").click();
  assert.equal(f.writes().length, 0);
  assert.deepEqual(f.consoleErrors, []);
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

test("an occupied slot can be inspected without selecting it or exposing another resident", async (testContext) => {
  const fixtureData = await fixture(testContext, {
    override: async (operation, body, context, demo) => {
      if (operation === "availability")
        return (await demo(operation, body, context)).map((slot) => ({
          ...slot,
          status: 1,
          ordered: 1,
          remainingNum: 0,
          gmtCreate: "2026-08-28 13:07:34",
          ownerName: "Private Resident",
          unitName: "#99-99",
        }));
    },
  });
  await fixtureData.login();
  fixtureData.all(".facility-card")[0].click();
  await fixtureData.until(
    () => fixtureData.all(".slot-details-button").length === 2,
    "slot inspection buttons",
  );
  assert.equal(fixtureData.all(".slot:not(:disabled)").length, 0);
  fixtureData.query(".slot-details-button").click();
  await fixtureData.until(
    () =>
      /No booking for your unit/.test(
        fixtureData.query("#slot-own-bookings")?.textContent,
      ),
    "own booking lookup",
  );
  const detailsText = fixtureData.query("#modal").textContent;
  assert.match(detailsText, /Booking capacity/);
  assert.match(detailsText, /Capacity unavailable/);
  assert.match(detailsText, /2026-08-28 13:07:34/);
  assert.equal(detailsText.includes("Private Resident"), false);
  assert.equal(detailsText.includes("#99-99"), false);
  assert.equal(fixtureData.query(".slot.selected"), null);
  assert.equal(fixtureData.query("#confirm-booking"), null);
  assert.equal(fixtureData.writes().length, 0);
  assert.deepEqual(fixtureData.consoleErrors, []);
});

test("slot inspection links an existing booking only to the account’s own selected unit", async (testContext) => {
  const fixtureData = await fixture(testContext);
  fixtureData.demo.bookings.push({
    id: "existing-own-booking",
    unitId: "demo-unit-1",
    facilityId: "demo-facility-1",
    facilityDetailId: "demo-facility-1-2026-09-06-0",
    facilityName: "Jewel Function Room 1",
    startTime: "2026-09-06 09:00:00",
    endTime: "2026-09-06 15:00:00",
    bookingNum: 1,
    pricing: 116.35,
    paidTotal: 116.35,
    status: 0,
    orderNo: "EXISTING-ORDER",
    gmtCreate: "2026-09-01 12:00:00",
  });
  await fixtureData.login();
  fixtureData.all(".facility-card")[0].click();
  await fixtureData.until(
    () => fixtureData.query("#booking-date") && fixtureData.all(".slot").length,
    "facility slots",
  );
  fixtureData.query("#booking-date").value = "2026-09-06";
  fixtureData.change(fixtureData.query("#booking-date"));
  await fixtureData.until(
    () =>
      fixtureData.all(".slot-details-button").length === 2 &&
      fixtureData.query(".slot:disabled"),
    "occupied session",
  );
  fixtureData.query(".slot-details-button").click();
  await fixtureData.until(
    () => fixtureData.query(".own-slot-booking"),
    "own booking association",
  );
  assert.match(fixtureData.query(".own-slot-booking").textContent, /#08-01/);
  assert.match(
    fixtureData.query(".own-slot-booking").textContent,
    /existing-own-booking/,
  );
  assert.match(
    fixtureData.query(".own-slot-booking").textContent,
    /EXISTING-ORDER/,
  );
  assert.match(
    fixtureData.query(".own-slot-booking").textContent,
    /2026-09-01 12:00:00/,
  );
  assert.equal(fixtureData.writes().length, 0);
});

test("an incomplete owner profile is explained and its mutations are disabled during read-only testing", async (t) => {
  const f = await fixture(t, {
    readOnly: true,
    override: async (op, body, context, demo) => {
      if (op === "login") {
        const value = await demo(op, body, context);
        value.ownerLoginOutDTO.email = "";
        return value;
      }
    },
  });
  await f.login();
  assert.match(f.query(".profile-banner").textContent, /verified email/);
  f.query('[data-action="profile"]').click();
  assert.ok(f.query("#profile-form"));
  assert.equal(f.query('[data-action="send-code"]').disabled, true);
  assert.equal(f.query('#profile-form button[type="submit"]').disabled, true);
  assert.equal(f.writes().length, 0);
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
