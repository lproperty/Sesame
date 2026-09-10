import { createPaymentQr } from "./payment-qr.js";
import {
  entryPassFromSession,
  createEntryQr,
  ENTRY_REFRESH_MS,
} from "./entry-pass.js";
import { createPassStore } from "./pass-store.js";
import {
  activityScopeFromSession,
  createActivityStore,
  summarizeActivity,
} from "./activity-store.js";

const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
const toastRoot = document.querySelector("#toasts");
const pageRequest = globalThis.sesameRequest;
delete globalThis.sesameRequest;
const assetVersion = document.querySelector(
  'meta[name="sesame-build"]',
)?.content;
const assetUrl = (path) => {
  const url = new URL(path.replace(/^\//, ""), new URL("./", location.href));
  if (assetVersion) url.searchParams.set("v", assetVersion);
  return url.pathname + url.search;
};
const state = {
  config: {},
  session: null,
  facilities: [],
  filter: "All facilities",
  search: "",
  detail: null,
  date: "",
  weekStart: "",
  slots: [],
  selectedSlot: null,
  quantity: 1,
  bookingError: "",
  availabilityError: "",
  availabilityCheckedAt: "",
  inspectionGeneration: 0,
  slotsLoading: false,
  routeGeneration: 0,
  availabilityGeneration: 0,
  committing: false,
  switchingUnit: false,
  modalType: "",
  bookings: [],
  bookingDetail: null,
  tab: "current",
  savedPass: null,
  savingPass: false,
  activity: null,
  activityMonth: "",
  activityStorageError: "",
  activitySyncError: "",
};
const passStore = createPassStore();
let activityStore = createActivityStore({ indexedDB: null });
const localMonth = (value = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date(value))
    .slice(0, 7);
const activityScope = () => {
  try {
    return activityScopeFromSession(state.session);
  } catch {
    return null;
  }
};
const sameActivityScope = (scope) =>
  scope && JSON.stringify(scope) === JSON.stringify(activityScope());
const freeBooking = (booking) => booking?.price === 0 && booking?.amount === 0;
const bookingFromView = (id) =>
  state.bookings.find((booking) => booking.id === id) ||
  (state.bookingDetail?.booking.id === id &&
  sameActivityScope(state.bookingDetail.scope)
    ? state.bookingDetail.booking
    : null);
const futureFreeTennis = (booking) => {
  const value = String(booking?.startTime || "").replace(" ", "T");
  const timestamp = Date.parse(
    value + (/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? "" : "+08:00"),
  );
  return (
    booking?.tab === "current" &&
    freeBooking(booking) &&
    /tennis/i.test(booking.facilityName || "") &&
    timestamp > Date.now()
  );
};
const activityTime = (value) => {
  if (!value) return "Time not provided";
  const text = String(value).replace(" ", "T");
  const date = new Date(
    text + (/(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? "" : "+08:00"),
  );
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en-SG", {
        timeZone: "Asia/Singapore",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date)
    : "Time not provided";
};

async function observeActivity(scope, bookings, tab) {
  if (!scope) return null;
  try {
    const log = await activityStore.observe(scope, bookings, { tab });
    if (sameActivityScope(scope)) {
      state.activity = log;
      state.activityStorageError = log.storageError || "";
    }
    return log;
  } catch {
    if (sameActivityScope(scope))
      state.activityStorageError =
        "Activity could not be saved. Booking actions still work; export any available log before closing this tab.";
    return null;
  }
}

async function beginActivityAction(action, booking) {
  const scope = activityScope();
  if (!scope) return null;
  try {
    const result = await activityStore.recordAction(scope, {
      action,
      outcome: "uncertain",
      booking,
    });
    if (sameActivityScope(scope))
      state.activityStorageError = result.storageError || "";
    return { scope, id: result.event.id, action, booking };
  } catch {
    state.activityStorageError =
      "This action could not be added to the activity log. Check the estate result below.";
    return null;
  }
}

async function finishActivityAction(attempt, outcome, booking, errorCode) {
  if (!attempt) return;
  try {
    const result = await activityStore.recordAction(attempt.scope, {
      id: attempt.id,
      action: attempt.action,
      outcome,
      booking: booking || attempt.booking,
      errorCode,
    });
    if (sameActivityScope(attempt.scope))
      state.activityStorageError = result.storageError || "";
  } catch {
    if (sameActivityScope(attempt.scope))
      state.activityStorageError =
        "The action result could not be saved to the local log. Check My bookings for its estate status.";
  }
}

const activityBookingTime = (booking) =>
  booking?.startTime
    ? `${dateFormat(booking.startTime.slice(0, 10), { weekday: "short", year: "numeric" })} · ${timeRange(booking.startTime.slice(11), booking.endTime?.slice(11))}`
    : "Booking time not provided";

const uncertainError = (error) =>
  !error?.code ||
  [
    "CONNECTION_INTERRUPTED",
    "INTERNAL_ERROR",
    "OUTCOME_UNCERTAIN",
    "UPSTREAM_UNREACHABLE",
    "UPSTREAM_RESPONSE",
    "SESSION_CHANGED",
  ].includes(error.code);
const receiptBooking = (receipt) => ({
  id: receipt.bookingId,
  facilityId: receipt.facility?.id,
  facilityName: receipt.facility?.name,
  startTime: `${receipt.date} ${receipt.startTime}:00`,
  endTime: `${receipt.date} ${receipt.endTime}:00`,
  quantity: receipt.quantity,
  price:
    receipt.unitPrice ??
    (receipt.quantity ? receipt.amount / receipt.quantity : null),
  amount: receipt.amount,
  tab: receipt.status === "confirmed_free" ? "current" : "unpaid",
});
const entryRoute = () =>
  ["", "qr"].includes(location.hash.replace(/^#\/?/, "").split("/")[0]);
const savedPassReady = () => Boolean(state.savedPass);
const savedPassMatches = (session) =>
  state.savedPass?.pass.ownerId === session?.user.id &&
  session.units.some(
    (unit) =>
      unit.unitId === state.savedPass.pass.unit.unitId &&
      unit.projectId === state.savedPass.pass.unit.projectId,
  );
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (value) =>
  value == null
    ? "See available times"
    : "S$" +
      new Intl.NumberFormat("en-SG", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value / 100);
const unitLabel = (unit) =>
  unit
    ? [unit.buildingName, unit.unitName].filter(Boolean).join(" · ")
    : "No active unit";
const updateConfig = (session) => {
  for (const key of ["today", "lastDate", "timeZone", "demo", "readOnly"])
    state.config[key] = session[key];
};
const addDays = (date, n) => {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dateFormat = (date, options = {}) => {
  if (!date || !Number.isFinite(Date.parse(date))) return "Date unavailable";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    ...options,
  }).format(new Date(date.slice(0, 10) + "T12:00:00+08:00"));
};
const timeRange = (start, end) =>
  `${String(start || "").slice(0, 5)} – ${String(end || "").slice(0, 5)}`;
const excerpt = (value) =>
  String(value || "")
    .split(/\n\s*\n/)[0]
    .trim();
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/>',
  calendar:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2M8 18h2"/>',
  calendarCheck:
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 16l3 3 5-5"/>',
  arrow: '<path d="M4 12h16M14 6l6 6-6 6"/>',
  back: '<path d="M20 12H4M10 6l-6 6 6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  leaf: '<path d="M20 3C10 3 3 7 4 14c1 7 8 8 12 3 3-4 4-10 4-14ZM3 22 16 9"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m7 12 3 3 7-7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  logout: '<path d="M9 4H4v16h5M14 8l4 4-4 4M8 12h13"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  qr: '<path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM19 15h2v6h-6v-2M12 3v3M3 12h3M9 12h6v-3M12 18v3"/>',
};
const icon = (name, extra = "") =>
  `<svg class="icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const brand = () =>
  '<span class="brand-mark" aria-hidden="true">S</span><span class="brand-name">SESAME<span class="brand-sub">RESIDENT PORTAL</span></span>';
const image = (src, alt, extra = "") =>
  `<img src="${esc(!src || src.startsWith("/assets/") ? assetUrl(src || "/assets/estate.jpg") : src)}" alt="${esc(alt)}" ${extra}>`;

// Rebuild estate rich text with an explicit tag allowlist and no attributes.
// HTML from API responses never enters the live DOM unsanitized.
function safeRichText(html) {
  const parsed = new DOMParser().parseFromString(
    String(html || ""),
    "text/html",
  );
  const container = document.createElement("div");
  const allowed = new Set([
    "P",
    "BR",
    "UL",
    "OL",
    "LI",
    "STRONG",
    "B",
    "EM",
    "I",
    "U",
    "H2",
    "H3",
    "H4",
    "BLOCKQUOTE",
    "SPAN",
  ]);
  const drop = new Set([
    "SCRIPT",
    "STYLE",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "SVG",
    "MATH",
    "TEMPLATE",
    "FORM",
    "NOSCRIPT",
  ]);
  const copy = (node, destination) => {
    if (node.nodeType === Node.TEXT_NODE) {
      destination.append(document.createTextNode(node.textContent));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || drop.has(node.tagName)) return;
    const next = allowed.has(node.tagName)
      ? document.createElement(node.tagName.toLowerCase())
      : document.createDocumentFragment();
    for (const child of node.childNodes) copy(child, next);
    destination.append(next);
  };
  for (const node of parsed.body.childNodes) copy(node, container);
  return container.innerHTML;
}

async function api(path, data) {
  const requestSession = state.session;
  const headers = { accept: "application/json" };
  if (data !== undefined) {
    headers["content-type"] = "application/json";
    if (state.session) headers["x-csrf-token"] = state.session.csrfToken;
  }
  let response;
  try {
    response = await (pageRequest || fetch)(path, {
      method: data === undefined ? "GET" : "POST",
      headers,
      credentials: "same-origin",
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch {
    const error = new Error(
      state.config.browserClient
        ? "Unable to reach the estate service. Check your internet connection."
        : "Unable to reach the local app. Check that the server is running.",
    );
    error.code = "CONNECTION_INTERRUPTED";
    throw error;
  }
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(
      "The app returned an unexpected response. Please refresh the page.",
    );
  }
  if (!response.ok) {
    const error = new Error(
      value.error?.message || "The request could not be completed.",
    );
    error.code = value.error?.code;
    error.details = value.error?.details;
    if (
      response.status === 401 &&
      path !== "/api/login" &&
      state.session &&
      state.session === requestSession
    ) {
      state.session = null;
      state.bookings = [];
      state.bookingDetail = null;
      state.activity = null;
      state.facilities = [];
      state.detail = null;
      state.slots = [];
      resetSelection();
      state.routeGeneration++;
      state.committing = false;
      closeModal();
      if (entryRoute() && savedPassReady()) renderEntry();
      else renderLogin(error.message);
    }
    throw error;
  }
  return value;
}

let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  toastRoot.innerHTML = `<div class="toast${error ? " error" : ""}" role="${error ? "alert" : "status"}">${esc(message)}</div>`;
  toastTimer = setTimeout(() => toastRoot.replaceChildren(), 6000);
}

function renderLogin(message = "") {
  stopEntry();
  stopBookingQr();
  document.title = state.config.staticDemo
    ? "Explore · Sesame"
    : "Sign in · Sesame";
  app.innerHTML = `<div class="login-layout">
    <section class="login-visual" aria-label="Life at Sesame">
      ${image("/assets/estate.jpg", "The resident clubhouse and pool at dusk", 'class="login-photo"')}
      <div class="brand">${brand()}</div>
      <div class="login-story"><span class="eyebrow">A little more to come home to</span>
        <h1>Every day,<br>a little <em>extraordinary.</em></h1>
        <p>Make the most of the spaces you call home. Your next gathering, game or quiet moment starts here.</p>
      </div>
      <div class="login-location">${icon("pin")} Your community</div>
    </section>
    <main class="login-panel" id="main-content">
      <span class="small-top-label pill${state.config.demo || state.config.readOnly ? " amber" : ""}">${state.config.staticDemo ? "Public demonstration" : state.config.demo ? "Offline demonstration" : state.config.readOnly ? "Read-only session" : "Owner access"}</span>
      <div class="login-form">
        <span class="eyebrow muted">YOUR RESIDENT PORTAL</span>
        <h2>Welcome home.</h2><p class="intro">${state.config.staticDemo ? "A little preview of life at Sesame." : entryRoute() ? "Sign in to show your resident entry QR." : "Sign in to manage your facility bookings."}</p>
        ${state.config.staticDemo ? '<div class="demo-hint"><strong>Explore with sample data.</strong><br>This community-built demonstration is not an official estate service. For real bookings, use the estate app.</div>' : state.config.demo ? '<div class="demo-hint">Explore with <strong>demo / demo</strong>. Everything in this session is simulated.</div>' : ""}
        ${state.config.staticDemo ? "" : `<div class="account-type">${icon("home")}<div><strong>Unit owner</strong><small>Your existing estate account</small></div>${icon("circleCheck", "check-icon")}</div>`}
        <form id="login-form">
          <div id="login-error" class="form-error" role="alert">${esc(message)}</div>
          ${
            state.config.staticDemo
              ? ""
              : `<label class="form-field"><span>Email, phone or username</span><input name="phoneOrEmail" id="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required maxlength="200" placeholder="Enter your owner login" ${state.config.demo ? 'value="demo"' : ""}></label>
          <label class="form-field"><span>Password</span><div class="input-wrap"><input name="cipher" id="password" type="password" autocomplete="current-password" enterkeyhint="go" required maxlength="300" placeholder="Enter your password" ${state.config.demo ? 'value="demo"' : ""}><button type="button" class="icon-button" data-action="toggle-password" aria-label="Show password" aria-pressed="false">${icon("eye")}</button></div></label>`
          }
          <button class="button full" type="submit" id="login-submit">${state.config.demo ? "Explore the demo" : "Sign in"} ${icon("arrow")}</button>
        </form>
        ${state.config.staticDemo ? "" : '<div class="login-help"><span class="muted field-note">Signing in as a unit owner</span><button class="text-button" data-action="login-help">Need help signing in?</button></div>'}
        <p class="login-footnote">${icon("shield")} ${state.config.staticDemo ? "No sign-in or real payments. Refresh to start afresh." : state.config.browserClient ? "Sign-in goes directly to your estate over HTTPS." : "A private connection to your estate account."}</p>
        ${state.config.browserClient ? '<p class="field-note">You stay signed in on this device when you reopen Sesame. Your password is never saved. Use Sign out to remove the saved login. Sesame is an independent resident portal.</p>' : ""}
        ${savedPassReady() && !state.config.demo ? '<button class="text-button full" data-action="show-entry">Back to my entry QR</button>' : ""}
      </div>
      <div class="login-bottom">Sesame &nbsp; · &nbsp; Spaces for the way you live</div>
    </main>
  </div>`;
}

function renderShell(content, section = "Facilities", cachedPass = null) {
  const identity =
    state.session ||
    (cachedPass
      ? {
          user: { name: "Entry pass" },
          units: [cachedPass.unit],
          unit: cachedPass.unit,
        }
      : null);
  if (!identity) return;
  const { user, units, unit } = identity;
  const authenticated = Boolean(state.session);
  const active =
    section === "Entry QR"
      ? "qr"
      : section === "My bookings"
        ? "bookings"
        : section === "Activity"
          ? "activity"
          : "facilities";
  app.innerHTML = `<div class="app-layout">
    <aside class="sidebar" aria-label="Resident navigation"><a class="brand" href="#/qr" aria-label="My resident entry QR">${brand()}</a>
      <p class="nav-label">YOUR ESTATE</p>
      <nav><a href="#/qr" class="nav-item ${active === "qr" ? "active" : ""}" ${active === "qr" ? 'aria-current="page"' : ""}>${icon("qr")} My entry QR</a>
      <a href="#/facilities" class="nav-item ${active === "facilities" ? "active" : ""}" ${active === "facilities" ? 'aria-current="page"' : ""}>${icon("grid")} Facilities ${icon("chevron", "nav-arrow")}</a>
      <a href="#/bookings" class="nav-item ${active === "bookings" ? "active" : ""}" ${active === "bookings" ? 'aria-current="page"' : ""}>${icon("calendarCheck")} My bookings</a>
      <a href="#/activity" class="nav-item ${active === "activity" ? "active" : ""}" ${active === "activity" ? 'aria-current="page"' : ""}>${icon("clock")} Activity log</a></nav>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-bottom"><span class="avatar" aria-hidden="true">${esc(user.name.slice(0, 1).toUpperCase())}</span><div><p class="account-name">${esc(user.name)}</p><p class="account-role">${authenticated ? "Unit owner" : "Saved on this device"}</p></div><button class="icon-button" data-action="${authenticated ? "logout" : "forget-entry"}" title="${authenticated ? "Sign out" : "Forget saved pass"}" aria-label="${authenticated ? "Sign out" : "Forget saved pass"}">${icon("logout")}</button></div>
    </aside>
    <div class="workspace"><header class="topbar"><div class="topbar-crumb"><span>Resident services</span><span class="crumb-divider">/</span><span class="current">${esc(section)}</span></div>
      <div class="topbar-actions"><span class="property-tag">Resident portal</span><label class="unit-control">${icon("home")}<span><small>YOUR UNIT</small><select id="unit-select" aria-label="Active owner unit" ${units.length < 2 ? "disabled" : ""}>${units.length ? units.map((u) => `<option value="${esc(u.unitId)}" ${u.unitId === unit?.unitId ? "selected" : ""}>${esc(unitLabel(u))}</option>`).join("") : "<option>No active unit</option>"}</select></span></label></div></header>
      ${state.config.staticDemo ? '<div class="mode-banner"><strong>PUBLIC DEMO</strong><span>Sample data only. No real bookings or payments.</span></div>' : state.config.demo ? '<div class="mode-banner"><strong>DEMO</strong> An offline preview. All bookings here are simulated.</div>' : state.config.readOnly ? '<div class="mode-banner readonly">Read-only mode · Explore facilities and availability. Submissions are disabled.</div>' : ""}
      ${state.config.browserClient && state.session?.loginPersistence === "memory" ? '<div class="mode-banner readonly">This browser could not save your sign-in. It works in this tab, but reopening may require login. Allow storage for this site to stay signed in.</div>' : ""}
      <main class="page${active === "qr" ? " entry-page" : ""}" id="main-content" tabindex="-1">${content}
        <footer class="page-footer"><span>SESAME &nbsp; / &nbsp; RESIDENT PORTAL</span><span>${icon("clock")} All facility times are in Singapore time (SGT).</span></footer>
      </main>
    </div>
    <nav class="mobile-nav" aria-label="Mobile resident navigation">
      <a href="#/qr" ${active === "qr" ? 'aria-current="page"' : ""}>${icon("qr")}<span>My QR</span></a>
      <a href="#/facilities" ${active === "facilities" ? 'aria-current="page"' : ""}>${icon("grid")}<span>Facilities</span></a>
      <a href="#/bookings" ${active === "bookings" ? 'aria-current="page"' : ""}>${icon("calendarCheck")}<span>My bookings</span></a>
      <a href="#/activity" ${active === "activity" ? 'aria-current="page"' : ""}>${icon("clock")}<span>Activity</span></a>
      <button type="button" data-action="${authenticated ? "logout" : "forget-entry"}">${icon("logout")}<span>${state.config.staticDemo ? "Exit demo" : authenticated ? "Sign out" : "Forget pass"}</span></button>
    </nav>
  </div>`;
}

let entryTimer;
let entryGeneration = 0;
let entryWakeLock = null;
function stopEntry() {
  entryGeneration++;
  clearTimeout(entryTimer);
  entryWakeLock?.release().catch(() => {});
  entryWakeLock = null;
}

async function keepEntryAwake(generation) {
  if (!navigator.wakeLock || entryWakeLock) return;
  try {
    const lock = await navigator.wakeLock.request("screen");
    if (generation !== entryGeneration || document.hidden)
      return void lock.release();
    entryWakeLock = lock;
    lock.addEventListener("release", () => {
      if (entryWakeLock === lock) entryWakeLock = null;
    });
  } catch {
    /* The QR still works when this browser does not offer a wake lock. */
  }
}

function renderEntry() {
  stopEntry();
  document.title = state.config.demo
    ? "Entry QR demo · Sesame"
    : "My entry QR · Sesame";
  let pass;
  try {
    pass = state.session
      ? entryPassFromSession(state.session)
      : savedPassReady()
        ? state.savedPass.pass
        : null;
  } catch (error) {
    renderShell(
      `<div class="empty-state"><h1>No active owner unit.</h1><p>${esc(error.message)}</p></div>`,
      "Entry QR",
    );
    return;
  }
  if (!pass) return renderLogin("Sign in to show your entry QR.");
  const savedForUnit =
    savedPassReady() &&
    state.savedPass.pass.ownerId === pass.ownerId &&
    state.savedPass.pass.unit.unitId === pass.unit.unitId;
  renderShell(
    `<section class="entry-view" aria-labelledby="entry-title">
    <div class="entry-heading"><p class="eyebrow">MY RESIDENT PASS</p><h1 id="entry-title">Ready for entry.</h1><p>Hold this QR up to the entrance reader.</p></div>
    <div class="entry-card"><div id="entry-qr" class="entry-qr" aria-label="Resident entry QR"><span class="spinner" aria-label="Preparing entry QR"></span></div>
      <p class="entry-unit">${esc(unitLabel(pass.unit))}</p><p id="entry-status" class="entry-status" role="status">Preparing a fresh code…</p>
    </div>
    <div class="entry-tools"><span id="entry-countdown" class="muted"></span><button class="text-button" data-action="refresh-entry">${icon("refresh")} Refresh QR</button></div>
    ${state.config.demo ? '<p class="entry-note">Example QR only. This demonstration cannot be used for estate entry.</p>' : savedForUnit ? `<div class="entry-saved">${icon("shield")}<div><strong>Ready when you reopen Sesame</strong><p>Saved until you forget it or sign out.</p></div></div><button class="text-button" data-action="forget-entry">Forget saved entry pass</button>` : `<div class="entry-save"><button class="button full" data-action="save-entry" ${!passStore.available || state.savingPass ? "disabled" : ""}>${icon("qr")} Keep my entry pass on this device</button><p class="entry-note">Saved until you forget it or sign out. Use a personal device. Your password is not saved.</p></div>`}
    ${!state.session ? '<p class="entry-note">Your entry pass is ready. Sign in when you want to book facilities.</p>' : ""}
  </section>`,
    "Entry QR",
    pass,
  );
  const generation = entryGeneration;
  let updatedAt = 0;
  const tick = async () => {
    if (generation !== entryGeneration || document.hidden || !entryRoute())
      return;
    try {
      if (!updatedAt || Date.now() - updatedAt >= ENTRY_REFRESH_MS) {
        if (state.session) {
          const session = await api("/api/session");
          if (generation !== entryGeneration) return;
          state.session = session;
          updateConfig(session);
          if (state.savedPass && !savedPassMatches(session))
            await forgetEntry();
          pass = entryPassFromSession(session);
        } else {
          const saved = await passStore.load();
          if (generation !== entryGeneration) return;
          state.savedPass = saved;
          if (!savedPassReady())
            return renderLogin("Sign in to show your entry QR.");
          pass = saved.pass;
        }
        if (generation !== entryGeneration || document.hidden) return;
        const code = createEntryQr(pass, Date.now());
        document.querySelector("#entry-qr").innerHTML = code.svg;
        const status = document.querySelector("#entry-status");
        const message = state.config.demo ? "Sample entry QR" : "Ready to scan";
        if (status.textContent !== message) status.textContent = message;
        updatedAt = code.updatedAt;
        void keepEntryAwake(generation);
      }
      const seconds = Math.max(
        1,
        Math.ceil((ENTRY_REFRESH_MS - (Date.now() - updatedAt)) / 1000),
      );
      document.querySelector("#entry-countdown").textContent =
        `Refreshes in ${seconds}s`;
    } catch (error) {
      if (generation !== entryGeneration) return;
      document.querySelector("#entry-qr")?.replaceChildren();
      const status = document.querySelector("#entry-status");
      if (status) status.textContent = error.message;
      updatedAt = 0;
    }
    if (generation === entryGeneration) entryTimer = setTimeout(tick, 1000);
  };
  void tick();
}

async function forgetEntry() {
  state.savedPass = null;
  if (!state.config.demo) await passStore.clear();
}

function renderLoading(section = "Facilities") {
  renderShell(
    `<div class="page-heading"><div><h1>${esc(section)}</h1><p>Getting your estate ready…</p></div></div><div class="skeleton skeleton-wide" aria-label="Loading"></div><div class="facility-grid">${'<div class="skeleton skeleton-card"></div>'.repeat(3)}</div>`,
    section,
  );
}

function renderError(error, section = "Facilities") {
  if (!state.session) return;
  renderShell(
    `<div class="error-panel" role="alert"><h2>We couldn’t load this just yet.</h2><p>${esc(error.message)}</p><button class="button" data-action="reload">${icon("refresh")} Try again</button></div>`,
    section,
  );
}

function facilityCards() {
  const filtered = state.facilities.filter(
    (f) =>
      (state.filter === "All facilities" || f.category === state.filter) &&
      `${f.name} ${f.category}`
        .toLowerCase()
        .includes(state.search.toLowerCase()),
  );
  if (!filtered.length)
    return '<div class="slot-empty"><p>No facilities match your search.</p><button class="text-button" data-action="clear-filters">Clear filters</button></div>';
  return filtered
    .sort(
      (a, b) =>
        Number(/\btennis\b/i.test(b.name)) - Number(/\btennis\b/i.test(a.name)),
    )
    .map(
      (
        f,
      ) => `<a class="facility-card" href="#/facility/${esc(f.id)}" aria-label="View times for ${esc(f.name)}">
    <div class="facility-image">${image(f.image, f.name, 'loading="lazy"')}<span class="image-label">${esc(f.category)}</span></div>
    <div class="facility-info"><h3>${esc(f.name)}</h3><p class="facility-excerpt">${esc(excerpt(f.introduction) || "Discover this shared space at Sesame.")}</p>
      <div class="facility-bottom"><span class="facility-price"><small>Listed rate</small><strong>${esc(money(f.indicativePrice))}</strong></span><span class="view-times">View times ${icon("arrow")}</span></div>
    </div></a>`,
    )
    .join("");
}

function renderFacilities() {
  document.title = "Facilities · Sesame";
  const categories = [
    "All facilities",
    ...new Set(state.facilities.map((f) => f.category)),
  ];
  renderShell(`<div class="page-heading"><div><h1>Facilities</h1></div><span class="date-caption">${icon("calendar")} ${dateFormat(state.config.today, { weekday: "short", year: "numeric" })}</span></div>
    <section id="facilities-section" aria-labelledby="facilities-title"><div class="facilities-toolbar"><div><h2 id="facilities-title">Find your space <span>${state.facilities.length} facilities</span></h2><p>Choose a facility and find a time that works for you.</p></div><label class="search">${icon("search")}<span class="visually-hidden">Search facilities</span><input id="facility-search" type="search" placeholder="Search facilities" value="${esc(state.search)}" autocomplete="off"></label></div>
      <div class="filters" aria-label="Filter facilities">${categories.map((c) => `<button class="filter ${state.filter === c ? "active" : ""}" data-action="filter" data-value="${esc(c)}" aria-pressed="${state.filter === c}">${esc(c)}</button>`).join("")}</div>
      <div class="facility-grid" id="facility-grid">${facilityCards()}</div>
    </section>`);
}

function resetSelection() {
  state.selectedSlot = null;
  state.quantity = 1;
  state.bookingError = "";
}

function dateStrip() {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(state.weekStart, i);
    const selected = date === state.date;
    const day = dateFormat(date, { weekday: "short" })
      .split(",")[0]
      .split(" ")[0];
    return `<button class="date-option ${selected ? "selected" : ""}" data-action="date" data-value="${date}" aria-label="${esc(dateFormat(date, { weekday: "long", year: "numeric" }))}" aria-pressed="${selected}" ${date > state.config.lastDate ? "disabled" : ""}><span>${esc(day)}</span><strong>${Number(date.slice(8))}</strong><span>${date === state.config.today ? "Today" : dateFormat(date, { day: undefined, month: "short" })}</span></button>`;
  }).join("");
}

function slotMarkup() {
  if (state.slotsLoading)
    return '<div class="slot-empty"><span class="spinner" aria-label="Loading time slots"></span></div>';
  if (state.availabilityError)
    return `<div class="slot-empty" role="alert"><p>${esc(state.availabilityError)}</p><button class="text-button" data-action="refresh-slots">Try again</button></div>`;
  if (!state.slots.length)
    return '<div class="slot-empty">No sessions have been released for this date. Try another day.</div>';
  return state.slots
    .map(
      (slot) =>
        `<div class="slot-card"><button class="slot ${state.selectedSlot?.id === slot.id ? "selected" : ""}" data-action="slot" data-value="${esc(slot.id)}" aria-pressed="${state.selectedSlot?.id === slot.id}" ${!slot.enabled ? "disabled" : ""}><strong>${esc(timeRange(slot.startTime, slot.endTime))}</strong><span class="slot-bottom"><span>${slot.enabled ? "Available" : esc(slot.reason)}</span><span>${esc(money(slot.price))}</span></span></button></div>`,
    )
    .join("");
}

function summaryMarkup() {
  const slot = state.selectedSlot;
  if (!slot)
    return `<h2>Your booking</h2><div class="summary-placeholder">${icon("calendar")}<strong>Choose a time.</strong><p>Your date, time and price will appear here.</p></div><button class="button full" disabled>Choose a time ${icon("arrow")}</button><div class="form-error" role="alert">${esc(state.bookingError)}</div>`;
  return `<h2>Your booking</h2><p class="summary-facility">${esc(state.detail.name)}</p><dl>
    <div class="summary-row"><dt>Date</dt><dd>${esc(dateFormat(slot.date, { weekday: "short" }))}</dd></div>
    <div class="summary-row"><dt>Time</dt><dd>${esc(timeRange(slot.startTime, slot.endTime))}</dd></div>
    <div class="summary-row"><dt>Unit</dt><dd>${esc(unitLabel(state.session.unit))}</dd></div>
    <div class="summary-row"><dt>Quantity</dt><dd>${slot.maxQuantity > 1 ? `<select id="booking-quantity" aria-label="Booking quantity">${Array.from({ length: slot.maxQuantity }, (_, i) => `<option value="${i + 1}" ${state.quantity === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select>` : "1 session"}</dd></div>
    </dl><div class="total-row"><span>Total</span><strong>${money(slot.price * state.quantity)}</strong></div><p class="summary-price-note">The estate’s price for this time slot. Review the facility information for fee and deposit details.</p>
    <div class="form-error" role="alert">${esc(state.bookingError)}</div>
    <button class="button full" id="book-submit" data-action="book" ${state.committing || state.config.readOnly ? "disabled" : ""}>${state.committing ? "Booking…" : state.config.readOnly ? "Read-only mode" : (state.config.demo ? "Book demo · " : "Book · ") + money(slot.price * state.quantity)} ${icon("arrow")}</button>
    <p class="summary-disclaimer">${state.config.readOnly ? "Submissions are disabled in read-only mode." : "Tap Book to reserve this time."}</p>`;
}

function renderDetail() {
  const f = state.detail;
  document.title = `${f.name} · Sesame`;
  renderShell(`<a class="back-link" href="#/facilities">${icon("back")} All facilities</a><div class="detail-heading"><p class="eyebrow">${esc(f.category)}</p><h1>${esc(f.name)}</h1></div>
    <div class="booking-layout"><div><section class="panel" aria-labelledby="choose-date-title"><div class="panel-title"><h2 id="choose-date-title"><span class="step-number">1</span>Choose a date</h2><label><span class="visually-hidden">Booking date</span><input class="date-input" id="booking-date" type="date" min="${state.config.today}" max="${state.config.lastDate}" value="${state.date}"></label></div>
      <div class="calendar-nav"><button class="icon-button" data-action="week-prev" aria-label="Previous week" ${state.weekStart <= state.config.today ? "disabled" : ""}>${icon("back")}</button><strong>${esc(dateFormat(state.weekStart, { day: undefined, month: "long", year: "numeric" }))}</strong><button class="icon-button" data-action="week-next" aria-label="Next week" ${addDays(state.weekStart, 7) > state.config.lastDate ? "disabled" : ""}>${icon("arrow")}</button></div>
      <div class="date-strip">${dateStrip()}</div><div class="slot-heading"><h3>Available times</h3><span>Singapore time · SGT</span></div>
      ${!state.slotsLoading && state.slots.length && state.slots.every((s) => s.reason === "Unavailable") ? '<div class="not-released">The estate currently marks these times unavailable. Please check another date.</div>' : ""}
      <div class="slots" id="slots" aria-live="polite">${slotMarkup()}</div><div class="availability-note">${icon("refresh")} Availability updates when you book.</div>
    </section>
    </div><aside class="panel summary-panel" id="booking-summary" aria-label="Your booking summary">${summaryMarkup()}</aside>
    <details class="panel rules-panel facility-information"><summary>Facility information & rules ${icon("down")}</summary><div class="introduction-full">${esc(f.introduction || "")}</div><div class="rules-content">${safeRichText(f.regulations)}</div></details></div>`);
  const strip = document.querySelector(".date-strip");
  const selected = strip?.querySelector(".selected");
  if (selected && strip.scrollWidth > strip.clientWidth)
    strip.scrollLeft = Math.max(
      0,
      selected.offsetLeft - (strip.clientWidth - selected.clientWidth) / 2,
    );
}

function renderSummary() {
  const target = document.querySelector("#booking-summary");
  if (target) target.innerHTML = summaryMarkup();
}

const tabNames = {
  current: "Upcoming",
  unpaid: "Pending payment",
  history: "History",
};
function renderBookings() {
  document.title = "My bookings · Sesame";
  const tab = state.tab;
  const titles = {
    current: "Your next moment awaits.",
    unpaid: "You’re all caught up.",
    history: "A fresh start.",
  };
  const descriptions = {
    current:
      "You have no upcoming bookings. Find a space for something to look forward to.",
    unpaid: "There are no bookings awaiting payment for this unit.",
    history: "Your past facility bookings will appear here.",
  };
  renderShell(
    `<div class="page-heading"><div><h1>Your bookings.</h1><p>Keep track of the moments you’ve made room for.</p></div><button class="button secondary small" data-action="reload">${icon("refresh")} Refresh</button></div>
    <nav class="booking-tabs" aria-label="Booking status">${Object.entries(
      tabNames,
    )
      .map(
        ([key, name]) =>
          `<a class="booking-tab ${tab === key ? "active" : ""}" href="#/bookings/${key}" ${tab === key ? 'aria-current="page"' : ""}>${name}</a>`,
      )
      .join("")}</nav>
    ${
      state.bookings.length
        ? state.bookings
            .map((b) => {
              const date = b.startTime.slice(0, 10);
              const valid = /^\d{4}-\d{2}-\d{2}$/.test(date);
              return `<article class="booking-row"><div class="booking-row-left"><div class="booking-date"><span>${valid ? esc(dateFormat(date, { day: undefined, month: "short" })) : "—"}</span><strong>${valid ? Number(date.slice(8)) : "—"}</strong></div><div><h3>${esc(b.facilityName)}</h3><p class="booking-day">${valid ? `<time datetime="${esc(date)}">${esc(dateFormat(date, { weekday: "long", month: "long", year: "numeric" }))}</time>` : "Date unavailable"}</p><p>${esc(timeRange(b.startTime.slice(11), b.endTime.slice(11)))} · ${b.quantity} ${b.quantity === 1 ? "session" : "sessions"}</p><p class="booking-reference">Booking ${esc(b.id)}</p></div></div><div class="booking-row-right"><strong>${esc(money(b.amount ?? (b.price == null ? null : b.price * b.quantity)))}</strong><span class="pill ${tab === "unpaid" ? "amber" : ""}">${tab === "current" && freeBooking(b) ? "Confirmed · Free" : tabNames[tab]}</span><br>${tab === "current" ? `<button class="text-button booking-qr-button" data-action="booking-qr" data-value="${esc(b.id)}">${icon("qr")} Entry QR</button>` : ""}<button class="text-button" data-action="booking-details" data-value="${esc(b.id)}">View details</button></div></article>`;
            })
            .join("")
        : `<section class="empty-state"><div class="empty-icon">${icon("calendarCheck")}</div><h2>${titles[tab]}</h2><p>${descriptions[tab]}</p><a class="button" href="#/facilities">Explore facilities ${icon("arrow")}</a></section>`
    }`,
    "My bookings",
  );
}

function renderActivity() {
  document.title = "Activity log · Sesame";
  const log = state.activity || { observations: [], events: [] };
  const month = state.activityMonth || localMonth();
  const summary = summarizeActivity(log, { month });
  const events = log.events
    .filter((event) => localMonth(event.attemptedAt) === month)
    .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));
  const observations = log.observations
    .filter((booking) => booking.startTime?.slice(0, 7) === month)
    .sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""));
  const cancelled = new Set(
    log.events
      .filter(
        (event) =>
          event.action === "cancellation" && event.outcome === "success",
      )
      .map((event) => event.booking.id),
  );
  const resultLabel = (event) =>
    event.outcome === "uncertain"
      ? "Result unconfirmed"
      : event.outcome === "failed"
        ? "Request failed"
        : event.action === "cancellation"
          ? "Cancellation confirmed"
          : "Booking submitted";
  const metrics = [
    [
      "Bookings observed",
      summary.byBookingMonth.observedBookings,
      "By facility-use month",
    ],
    [
      "Booking actions succeeded",
      summary.byActionMonth.bookingSuccess,
      "Actions recorded this month",
    ],
    [
      "Cancellations confirmed",
      summary.byActionMonth.cancellationSuccess,
      "Actions recorded this month",
    ],
    [
      "Unconfirmed actions",
      summary.byActionMonth.bookingUncertain +
        summary.byActionMonth.cancellationUncertain,
      "Check the estate records before retrying",
    ],
  ];
  renderShell(
    `<div class="page-heading"><div><p class="eyebrow">THIS ACCOUNT · THIS DEVICE</p><h1>Your activity.</h1><p>Booking observations and actions recorded by Sesame, starting when you use it here.</p></div><button class="button secondary small" data-action="reload">${icon("refresh")} Refresh records</button></div>
    <div class="activity-toolbar"><label for="activity-month">Month <input type="month" id="activity-month" value="${esc(month)}"></label><div class="activity-actions"><button class="button secondary small" data-action="export-activity">Export log</button><button class="text-button" data-action="clear-activity">Clear this unit’s log</button></div></div>
    <p class="field-note">${log.persistent ? "Saved in this browser for this account and unit, including after sign-out. It is not synced to other devices." : state.config.demo ? "Demo activity stays in this tab and resets when the demo reloads." : esc(state.activityStorageError || log.storageError || "Activity is available in this tab only; it may not survive a refresh.")}</p>
    ${state.activityStorageError && log.persistent ? `<p class="activity-warning" role="status">${esc(state.activityStorageError)}</p>` : ""}
    ${state.activitySyncError ? `<p class="activity-warning" role="status">${esc(state.activitySyncError)}</p>` : ""}
    <div class="activity-metrics">${metrics.map(([label, value, note]) => `<article class="activity-metric"><span>${esc(label)}</span><strong>${value}</strong><small>${esc(note)}</small></article>`).join("")}</div>
    <p class="activity-note">These are observed activity totals. The estate has not provided a remaining-quota balance or complete cancellation history. A missing booking is never automatically recorded as cancelled.</p>
    ${log.truncated?.events || log.truncated?.observations ? `<p class="activity-warning">Older records exceed this device’s log capacity (${log.truncated.events} action records and ${log.truncated.observations} booking observations omitted). Export regularly to keep your own archive.</p>` : ""}
    <section class="activity-section"><h2>Recorded actions</h2><p class="section-note">Times below are when this device sent and checked the request.</p>${events.length ? `<ol class="activity-list">${events.map((event) => `<li class="activity-row"><div class="activity-symbol">${icon(event.action === "cancellation" ? "close" : "calendarCheck")}</div><div class="activity-copy"><h3>${esc(event.booking.facilityName)}</h3><p>${esc(activityBookingTime(event.booking))}</p><p class="activity-timestamp">Attempted ${esc(activityTime(event.attemptedAt))}${event.resolvedAt ? ` · Checked ${esc(activityTime(event.resolvedAt))}` : ""}</p>${event.booking.id ? `<p class="booking-reference">Booking ${esc(event.booking.id)}</p>` : ""}${event.errorCode ? `<p class="activity-timestamp">Result code: ${esc(event.errorCode)}</p>` : ""}</div><span class="pill ${event.outcome === "success" ? "" : "amber"}">${esc(resultLabel(event))}</span></li>`).join("")}</ol>` : '<div class="activity-empty">No actions recorded for this month. Booking and cancellation attempts made here will appear in this log.</div>'}</section>
    <section class="activity-section"><h2>Bookings observed</h2><p class="section-note">The latest record Sesame saw for each booking. Other household accounts and earlier cancellations may not appear.</p>${observations.length ? `<ol class="activity-list">${observations.map((booking) => `<li class="activity-row"><div class="activity-copy"><h3>${esc(booking.facilityName)}</h3><p>${esc(activityBookingTime(booking))} · ${booking.quantity} session${booking.quantity === 1 ? "" : "s"} · ${freeBooking(booking) ? "Free" : esc(money(booking.amount))}</p><p class="activity-timestamp">First observed ${esc(activityTime(booking.firstObservedAt))}<br>Last observed ${esc(activityTime(booking.lastObservedAt))}${booking.orderTime || booking.createdAt ? `<br>Estate order time: ${esc(activityTime(booking.orderTime || booking.createdAt))}` : ""}</p><p class="booking-reference">Booking ${esc(booking.id)}</p></div><span class="pill">${cancelled.has(booking.id) ? "Cancelled in Sesame" : `Last seen: ${esc(tabNames[booking.tab] || "Observed")}`}</span></li>`).join("")}</ol>` : '<div class="activity-empty">No bookings have been observed for this facility-use month.</div>'}</section>`,
    "Activity",
  );
}

async function loadActivity(generation) {
  const scope = activityScope();
  if (!scope) return;
  state.activityMonth ||= localMonth();
  state.activitySyncError = "";
  const reads = await Promise.allSettled(
    ["current", "unpaid", "history"].map(async (tab) => ({
      tab,
      bookings: await api(`/api/bookings?tab=${tab}`),
    })),
  );
  for (const result of reads) {
    if (generation !== state.routeGeneration || !sameActivityScope(scope))
      return;
    if (result.status === "fulfilled")
      await observeActivity(scope, result.value.bookings, result.value.tab);
    else
      state.activitySyncError =
        "Some estate records could not be refreshed. Saved observations are still shown below.";
  }
  const log = await activityStore.load(scope);
  if (generation !== state.routeGeneration || !sameActivityScope(scope)) return;
  state.activity = log;
  state.activityStorageError = log.storageError || state.activityStorageError;
  renderActivity();
}

async function exportActivity() {
  const scope = activityScope();
  if (!scope) return;
  const data = await activityStore.export(scope);
  if (!sameActivityScope(scope)) return;
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sesame-activity-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadAvailability(date) {
  if (
    date < state.config.today ||
    date > state.config.lastDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    toast("Choose a date within the next four weeks.", true);
    return;
  }
  const generation = ++state.availabilityGeneration;
  const routeGeneration = state.routeGeneration;
  const facility = state.detail;
  state.date = date;
  state.slotsLoading = true;
  state.availabilityError = "";
  state.slots = [];
  resetSelection();
  renderDetail();
  try {
    const result = await api(
      `/api/facilities/${encodeURIComponent(facility.id)}/availability?date=${date}`,
    );
    if (
      generation !== state.availabilityGeneration ||
      routeGeneration !== state.routeGeneration
    )
      return;
    Object.assign(state.config, {
      today: result.today,
      lastDate: result.lastDate,
    });
    state.slots = result.slots;
    state.availabilityCheckedAt = result.checkedAt;
  } catch (error) {
    if (
      generation !== state.availabilityGeneration ||
      routeGeneration !== state.routeGeneration
    )
      return;
    state.availabilityError = error.message;
  } finally {
    if (
      generation === state.availabilityGeneration &&
      routeGeneration === state.routeGeneration &&
      state.session
    ) {
      state.slotsLoading = false;
      renderDetail();
    }
  }
}

async function route() {
  if (state.switchingUnit) return;
  stopEntry();
  stopBookingQr();
  if (!state.session) {
    if (entryRoute() && savedPassReady() && !state.config.demo) renderEntry();
    else renderLogin();
    return;
  }
  const generation = ++state.routeGeneration;
  state.availabilityGeneration++;
  state.detail = null;
  state.bookingDetail = null;
  resetSelection();
  closeModal();
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const section = entryRoute()
    ? "Entry QR"
    : parts[0] === "bookings"
      ? "My bookings"
      : parts[0] === "activity"
        ? "Activity"
        : "Facilities";
  if (entryRoute()) {
    renderEntry();
    window.scrollTo(0, 0);
    return;
  }
  if (!state.session.unit) {
    renderShell(
      '<section class="empty-state"><div class="empty-icon">' +
        icon("home") +
        '</div><h2>No active owner unit.</h2><p>This login does not have an activated owner association. Please contact estate management to link your unit.</p><button class="button" data-action="logout">Sign out</button></section>',
    );
    return;
  }
  renderLoading(section);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === "activity") {
      await loadActivity(generation);
    } else if (parts[0] === "facility" && parts[1]) {
      const detail = await api(
        "/api/facilities/" + encodeURIComponent(parts[1]),
      );
      if (generation !== state.routeGeneration) return;
      state.detail = detail;
      state.weekStart = state.config.today;
      await loadAvailability(state.config.today);
    } else if (parts[0] === "bookings") {
      state.tab = Object.hasOwn(tabNames, parts[1]) ? parts[1] : "current";
      const scope = activityScope();
      const bookings = await api("/api/bookings?tab=" + state.tab);
      if (generation !== state.routeGeneration) return;
      state.bookings = bookings;
      await observeActivity(scope, bookings, state.tab);
      if (generation !== state.routeGeneration) return;
      renderBookings();
    } else {
      const facilities = await api("/api/facilities");
      if (generation !== state.routeGeneration) return;
      state.facilities = facilities;
      renderFacilities();
    }
  } catch (error) {
    if (generation === state.routeGeneration) renderError(error, section);
  }
}

let returnFocus;
let bookingQrTimer;
let bookingQrGeneration = 0;
let bookingQrInFlight = false;
let activeBookingQr = null;

function stopBookingQr({ retain = false } = {}) {
  bookingQrGeneration++;
  clearTimeout(bookingQrTimer);
  document.querySelector("#booking-qr-images")?.replaceChildren();
  if (!retain) activeBookingQr = null;
}

function visibleBookingQr(active) {
  return (
    active &&
    active === activeBookingQr &&
    !document.hidden &&
    modal.open &&
    state.modalType === "booking-qr" &&
    active.routeGeneration === state.routeGeneration &&
    sameActivityScope(active.scope)
  );
}

async function refreshBookingQr(active = activeBookingQr) {
  if (!visibleBookingQr(active) || bookingQrInFlight) return;
  clearTimeout(bookingQrTimer);
  bookingQrInFlight = true;
  const generation = bookingQrGeneration;
  const status = document.querySelector("#booking-qr-status");
  if (status) status.textContent = "Getting a fresh entry code…";
  try {
    const result = await api(
      `/api/bookings/${encodeURIComponent(active.id)}/qr`,
    );
    if (!visibleBookingQr(active) || generation !== bookingQrGeneration) return;
    const images = document.querySelector("#booking-qr-images");
    if (!images) return;
    active.refreshMs =
      Number.isFinite(result.refreshMs) &&
      result.refreshMs >= 1000 &&
      result.refreshMs <= 3_600_000
        ? result.refreshMs
        : 10_000;
    images.innerHTML = result.images.length
      ? result.images
          .map(
            (code, index) =>
              `<figure class="booking-qr-image"><img data-booking-qr src="${esc(code.src)}" alt="${esc(code.label)}" width="220" height="220" referrerpolicy="no-referrer"><figcaption>${result.images.length > 1 ? `Entry code ${index + 1}` : "Facility entry"}</figcaption></figure>`,
          )
          .join("")
      : '<p class="activity-empty">The estate has not returned an entry QR for this booking yet.</p>';
    status.textContent = result.images.length
      ? `Updated ${new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(result.updatedAt))} · refreshes every ${active.refreshMs / 1000} seconds`
      : "It will check again automatically while this screen is open.";
  } catch (error) {
    if (!visibleBookingQr(active) || generation !== bookingQrGeneration) return;
    document.querySelector("#booking-qr-images")?.replaceChildren();
    if (status) status.textContent = error.message;
    active.terminal = [
      "BOOKING_NOT_FOUND",
      "BOOKING_ENDED",
      "BOOKING_NOT_CONFIRMED",
      "UNIT_CHANGED",
      "SESSION_CHANGED",
      "SESSION_EXPIRED",
      "SIGN_IN_REQUIRED",
    ].includes(error.code);
  } finally {
    bookingQrInFlight = false;
    const next = activeBookingQr;
    if (visibleBookingQr(next) && !next.terminal)
      bookingQrTimer = setTimeout(
        () => void refreshBookingQr(next),
        next === active && generation === bookingQrGeneration
          ? next.refreshMs
          : 0,
      );
  }
}

function showBookingQr(id) {
  const booking = bookingFromView(id);
  if (!booking || booking.tab !== "current" || !state.session) return;
  openModal(
    "booking-qr",
    booking.facilityName,
    `<p class="modal-copy">${esc(activityBookingTime(booking))}</p><p>Hold the entry code up to the facility reader for this booking.</p><div id="booking-qr-images" class="booking-qr-images"><span class="spinner" aria-label="Loading booking QR"></span></div><p id="booking-qr-status" class="entry-status" role="status">Getting a fresh entry code…</p>${state.config.demo ? '<p class="entry-note">Demo code only. It cannot open a facility.</p>' : ""}<div class="modal-actions"><button class="button secondary" data-action="refresh-booking-qr">${icon("refresh")} Refresh code</button><button class="button secondary" data-action="booking-details" data-value="${esc(id)}">Booking details</button></div>`,
    "BOOKING ENTRY QR",
  );
  activeBookingQr = {
    id,
    scope: activityScope(),
    routeGeneration: state.routeGeneration,
    refreshMs: 10_000,
    terminal: false,
  };
  void refreshBookingQr(activeBookingQr);
}

function openModal(type, heading, body, eyebrow = "SESAME") {
  stopBookingQr();
  if (!modal.open) returnFocus = document.activeElement;
  state.modalType = type;
  modal.innerHTML = `<header class="modal-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h2 id="modal-title">${esc(heading)}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></header><div class="modal-body">${body}</div>`;
  if (!modal.open) modal.showModal();
  document.documentElement.classList.add("modal-open");
}

function closeModal() {
  if (state.committing) return;
  stopBookingQr();
  if (modal.open) modal.close();
  state.modalType = "";
  state.bookingDetail = null;
}

modal.addEventListener("close", () => {
  if (modal.open) return;
  stopBookingQr();
  document.documentElement.classList.remove("modal-open");
  state.modalType = "";
  state.bookingDetail = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
});
modal.addEventListener("cancel", (event) => {
  if (state.committing) event.preventDefault();
});
modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    const rect = modal.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      closeModal();
  }
});

function reviewDetails(preview) {
  return `<div class="review-facility">${image(preview.facility.image, preview.facility.name)}<div><h3>${esc(preview.facility.name)}</h3><p>${esc(preview.unit.projectName)} · ${esc(unitLabel(preview.unit))}</p></div></div><dl class="review-details">
    <div class="summary-row"><dt>Date</dt><dd>${esc(dateFormat(preview.date, { weekday: "long", month: "long", year: "numeric" }))}</dd></div>
    <div class="summary-row"><dt>Time (SGT)</dt><dd>${esc(timeRange(preview.startTime, preview.endTime))}</dd></div>
    <div class="summary-row"><dt>Quantity</dt><dd>${preview.quantity} ${preview.quantity === 1 ? "session" : "sessions"}</dd></div>
    <div class="summary-row"><dt>Payment</dt><dd>${esc(preview.paymentMethod)}</dd></div></dl><div class="review-total"><span>Total amount</span><strong>${esc(money(preview.amount))}</strong></div>`;
}

async function bookSelected() {
  if (
    state.committing ||
    state.switchingUnit ||
    !state.selectedSlot ||
    state.config.readOnly
  )
    return;
  const slot = state.selectedSlot;
  const generation = state.routeGeneration;
  const selection = {
    facilityId: state.detail.id,
    slotId: slot.id,
    date: state.date,
    quantity: state.quantity,
    expectedAmount: slot.price * state.quantity,
    expectedUnitId: state.session.unit.unitId,
    expectedStartTime: slot.startTime,
    expectedEndTime: slot.endTime,
    confirm: true,
  };
  const receipt = {
    facility: state.detail,
    unit: state.session.unit,
    date: state.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    quantity: state.quantity,
    amount: selection.expectedAmount,
    unitPrice: slot.price,
    paymentMethod:
      selection.expectedAmount === 0
        ? "Free — no payment required"
        : "Bank transfer / PayNow UEN",
  };
  state.committing = true;
  state.bookingError = "";
  renderSummary();
  const controls = [...app.querySelectorAll("button, input, select")].map(
    (element) => ({ element, disabled: element.disabled }),
  );
  for (const { element } of controls) element.disabled = true;
  let activityAttempt;
  try {
    activityAttempt = await beginActivityAction(
      "booking",
      receiptBooking(receipt),
    );
    const result = await api("/api/bookings", selection);
    const outcome = ["payment_pending", "confirmed_free"].includes(
      result.status,
    )
      ? "success"
      : "uncertain";
    await finishActivityAction(
      activityAttempt,
      outcome,
      receiptBooking(result),
    );
    if (result.bookingId && outcome === "success")
      await observeActivity(
        activityAttempt?.scope,
        [receiptBooking(result)],
        result.status === "confirmed_free" ? "current" : "unpaid",
      );
    state.committing = false;
    if (state.session && generation === state.routeGeneration)
      showResult(result);
  } catch (error) {
    await finishActivityAction(
      activityAttempt,
      uncertainError(error) ? "uncertain" : "failed",
      null,
      error.code,
    );
    state.committing = false;
    if (!state.session || generation !== state.routeGeneration) return;
    if (uncertainError(error)) {
      showResult({
        ...receipt,
        status: "outcome_unknown",
        message:
          "The booking result could not be confirmed. Check My bookings or the estate app before trying again.",
      });
    } else {
      if (
        [
          "BOOKING_CHANGED",
          "SLOT_UNAVAILABLE",
          "QUANTITY_UNAVAILABLE",
          "UNIT_CHANGED",
        ].includes(error.code)
      )
        await loadAvailability(selection.date);
      if (generation === state.routeGeneration)
        state.bookingError = error.message;
    }
  } finally {
    state.committing = false;
    for (const { element, disabled } of controls)
      if (element.isConnected) element.disabled = disabled;
    if (generation === state.routeGeneration && state.session) renderSummary();
  }
}

function bankInstructions() {
  const payment = state.config.payment;
  if (!payment)
    return '<p class="payment-instructions">Complete payment in the estate app.</p>';
  return `<section class="bank-details"><h3>Pay by bank transfer or PayNow UEN</h3><div class="bank-grid"><dl><dt>Payee</dt><dd>${esc(payment.payee)}</dd><dt>UEN</dt><dd>${esc(payment.uen)}</dd><dt>${esc(payment.bankName)} account</dt><dd>${esc(payment.bankAccount)}</dd></dl><div class="payment-qr">${createPaymentQr(payment.qrText)}</div></div></section><p class="payment-instructions">Send proof of payment through <strong>E-Forms 13</strong> in the estate app, or email <a href="mailto:${esc(payment.email)}">${esc(payment.email)}</a>. Include your unit and booking reference.</p>`;
}

function showResult(result) {
  const ok = ["payment_pending", "confirmed_free"].includes(result.status);
  const free = result.amount === 0;
  openModal(
    "result",
    ok
      ? state.config.demo
        ? "Your demo booking is ready."
        : "Booking submitted."
      : "Booking status unconfirmed.",
    `<div class="result-icon">${icon(ok ? "calendarCheck" : "info")}</div><p class="modal-copy">${esc(state.config.demo && ok ? "This reservation exists only in the offline demonstration. No payment is needed." : result.message)}</p>${reviewDetails(result)}
    ${result.orderNo ? `<span class="result-reference">Order reference: ${esc(result.orderNo)}</span>` : ""}${result.bookingId ? `<span class="result-reference">Booking reference: ${esc(result.bookingId)}</span>` : ""}
    ${ok && !state.config.demo && !free ? bankInstructions() : ""}
    ${ok ? `<p class="status-line" id="payment-status" role="status">${free ? (result.status === "confirmed_free" ? "Confirmed · Free" : "No payment required. Check My bookings for confirmation.") : "Payment status: pending"}</p>` : ""}
    <div class="modal-actions">${ok && !free ? `<button class="button secondary" data-action="payment-status" data-value="${esc(result.previewId)}">${icon("refresh")} Check payment</button>` : ""}<button class="button" data-action="go-bookings" data-tab="${result.status === "confirmed_free" ? "current" : "unpaid"}">View my bookings ${icon("arrow")}</button></div>`,
    ok ? "BOOKING SUBMITTED" : "SUBMISSION STATUS",
  );
}

function paymentStatusText(status) {
  return (
    {
      paid: "Payment received.",
      free: "No payment is required for this booking.",
      expired:
        "This payment order has expired. Use Complete payment to continue the reservation.",
      not_started:
        "No payment order is set up yet. Use Complete payment to continue.",
      pending: "Payment is still pending confirmation from the estate.",
    }[status] || "Payment has not been checked yet."
  );
}

function showBookingDetails(id, payment = null) {
  const booking = payment?.booking || bookingFromView(id);
  if (!booking) return;
  state.bookingDetail = { booking, scope: activityScope() };
  const pending =
    booking.tab === "unpaid" && !["paid", "free"].includes(payment?.status);
  const canCancel =
    payment?.canCancel ?? (pending || futureFreeTennis(booking));
  const orderNo =
    payment?.orderNo || booking.orderNo || booking.receipt?.orderNo;
  const instructions =
    payment?.status === "pending"
      ? state.config.demo
        ? '<p class="payment-instructions">This is a demonstration reservation. No payment is needed.</p>'
        : payment.codeUrl
          ? `<section class="bank-details"><h3>Complete your PayNow payment</h3><div class="payment-qr">${createPaymentQr(payment.codeUrl)}</div><p>Scan this payment QR with your banking app, then check payment below.</p></section>`
          : bankInstructions()
      : "";
  openModal(
    "booking-details",
    booking.facilityName,
    `<p class="modal-copy">${esc(dateFormat(booking.startTime.slice(0, 10), { weekday: "long", month: "long", year: "numeric" }))} · ${esc(timeRange(booking.startTime.slice(11), booking.endTime.slice(11)))}</p>${ownBookingMetadata({ ...booking, orderNo })}
    ${booking.tab === "unpaid" || payment ? `<p class="status-line" id="payment-status" role="status">${esc(paymentStatusText(payment?.status))}</p>` : ""}${instructions}
    ${booking.tab === "current" && freeBooking(booking) && !payment ? '<p class="status-line">Confirmed · Free</p>' : ""}
    <div class="modal-actions reservation-actions">${booking.tab === "current" ? `<button class="button" data-action="booking-qr" data-value="${esc(id)}">${icon("qr")} Show entry QR</button>` : ""}${pending ? `<button class="button" data-action="complete-payment" data-value="${esc(id)}" ${state.config.readOnly ? "disabled" : ""}>${freeBooking(booking) ? "Check confirmation" : "Complete payment"}</button>` : ""}
    ${booking.tab === "unpaid" || payment ? `<button class="button secondary" data-action="payment-status" data-booking="${esc(id)}">${icon("refresh")} Check payment</button>` : ""}
    ${canCancel ? `<button class="button secondary" data-action="cancel-booking" data-value="${esc(id)}" ${state.config.readOnly ? "disabled" : ""}>Cancel reservation</button>` : ""}
    <button class="button secondary" data-action="close-modal">Close</button></div>`,
    "YOUR BOOKING",
  );
}

function confirmCancellation(id) {
  const booking = bookingFromView(id);
  if (
    !booking ||
    (booking.tab !== "unpaid" && !futureFreeTennis(booking)) ||
    state.config.readOnly
  )
    return;
  openModal(
    "cancel-booking",
    "Cancel this reservation?",
    `<p class="modal-copy">${esc(booking.facilityName)} · ${esc(dateFormat(booking.startTime.slice(0, 10), { weekday: "long", month: "long", year: "numeric" }))} · ${esc(timeRange(booking.startTime.slice(11), booking.endTime.slice(11)))}</p><p>Your time slot will be released when the estate confirms cancellation.</p><span class="result-reference">Booking reference: ${esc(id)}</span><div class="form-error" id="reservation-error" role="alert"></div><div class="modal-actions"><button class="button secondary" data-action="booking-details" data-value="${esc(id)}">Keep reservation</button><button class="button" data-action="confirm-cancel-booking" data-value="${esc(id)}">Confirm cancellation</button></div>`,
    freeBooking(booking) && booking.tab === "current"
      ? "FREE TENNIS BOOKING"
      : "PENDING RESERVATION",
  );
}

async function mutateReservation(id, action) {
  if (state.committing || state.switchingUnit || state.config.readOnly) return;
  const generation = state.routeGeneration;
  const bookingForLog = bookingFromView(id);
  let activityAttempt;
  stopBookingQr();
  state.committing = true;
  const controls = [...document.querySelectorAll("button, input, select")].map(
    (element) => ({ element, disabled: element.disabled }),
  );
  for (const { element } of controls) element.disabled = true;
  try {
    if (action === "cancel")
      activityAttempt = await beginActivityAction(
        "cancellation",
        bookingForLog,
      );
    const result = await api(
      `/api/bookings/${encodeURIComponent(id)}/${action}`,
      { confirm: true },
    );
    if (action === "cancel")
      await finishActivityAction(
        activityAttempt,
        result.status === "cancelled" ? "success" : "uncertain",
      );
    state.committing = false;
    if (!state.session || generation !== state.routeGeneration) return;
    if (action === "cancel") {
      closeModal();
      await route();
      toast("Reservation cancelled.");
    } else {
      showBookingDetails(id, result);
      if (
        ["paid", "free"].includes(result.status) &&
        result.booking?.tab === "current"
      ) {
        state.bookings = state.bookings.filter((booking) => booking.id !== id);
        renderBookings();
      }
    }
  } catch (error) {
    if (action === "cancel")
      await finishActivityAction(
        activityAttempt,
        uncertainError(error) ? "uncertain" : "failed",
        null,
        error.code,
      );
    if (!state.session || generation !== state.routeGeneration) return;
    const message = uncertainError(error)
      ? "The result could not be confirmed. Refresh My bookings before trying again."
      : error.message;
    const target =
      document.querySelector("#reservation-error") ||
      document.querySelector("#payment-status");
    if (target) target.textContent = message;
    else toast(message, true);
  } finally {
    state.committing = false;
    for (const { element, disabled } of controls)
      if (element.isConnected) element.disabled = disabled;
  }
}

function metadataRows(rows) {
  return `<dl class="inspection-details">${rows.map(([label, value]) => `<div class="summary-row"><dt>${esc(label)}</dt><dd>${esc(value == null || value === "" ? "Not provided" : value)}</dd></div>`).join("")}</dl>`;
}

function ownBookingMetadata(booking) {
  return metadataRows([
    ["Unit", booking.unit ? unitLabel(booking.unit) : null],
    ["Status", tabNames[booking.tab]],
    ["Quantity", booking.quantity],
    [
      "Amount",
      money(
        booking.amount ??
          (booking.price == null ? null : booking.price * booking.quantity),
      ),
    ],
    ["Booking reference", booking.id],
    ["Order reference", booking.orderNo],
  ]);
}

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id === "login-form") {
    event.preventDefault();
    const button = document.querySelector("#login-submit");
    if (button.disabled) return;
    const body = state.config.staticDemo
      ? { phoneOrEmail: "demo", cipher: "demo" }
      : Object.fromEntries(new FormData(form));
    button.disabled = true;
    button.textContent = state.config.staticDemo
      ? "Opening the demo…"
      : "Signing in…";
    document.querySelector("#login-error").textContent = "";
    try {
      state.session = await api("/api/login", body);
      body.cipher = "";
      if (!state.config.demo && savedPassReady()) {
        const saved = state.savedPass.pass;
        const allowed = state.session.units.some(
          (unit) =>
            unit.unitId === saved.unit.unitId &&
            unit.projectId === saved.unit.projectId,
        );
        if (saved.ownerId !== state.session.user.id || !allowed)
          await forgetEntry();
        else if (state.session.unit?.unitId !== saved.unit.unitId)
          state.session = await api("/api/unit", { unitId: saved.unit.unitId });
      }
      updateConfig(state.session);
      state.filter = "All facilities";
      state.search = "";
      await route();
    } catch (error) {
      if (document.querySelector("#login-error"))
        document.querySelector("#login-error").textContent = error.message;
      if (button.isConnected) {
        button.disabled = false;
        button.innerHTML = `${state.config.demo ? "Explore the demo" : "Sign in"} ${icon("arrow")}`;
      }
    }
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "facility-search") {
    state.search = event.target.value;
    document.querySelector("#facility-grid").innerHTML = facilityCards();
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.id === "unit-select") {
    if (!state.session) return;
    if (state.committing || state.switchingUnit) {
      target.value = state.session.unit.unitId;
      return;
    }
    state.switchingUnit = true;
    state.routeGeneration++;
    state.availabilityGeneration++;
    stopEntry();
    document.querySelector("#entry-qr")?.replaceChildren();
    stopBookingQr();
    state.activity = null;
    state.bookingDetail = null;
    state.bookings = [];
    state.activityStorageError = "";
    target.disabled = true;
    try {
      state.session = await api("/api/unit", { unitId: target.value });
      state.switchingUnit = false;
      const destination = entryRoute()
        ? "#/qr"
        : location.hash.startsWith("#/activity")
          ? "#/activity"
          : "#/facilities";
      if (location.hash !== destination) location.hash = destination;
      else await route();
    } catch (error) {
      state.switchingUnit = false;
      toast(error.message, true);
      target.value = state.session?.unit?.unitId || "";
      target.disabled = false;
      if (state.session) await route();
    }
  } else if (target.id === "activity-month") {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(target.value)) return;
    state.activityMonth = target.value;
    renderActivity();
  } else if (target.id === "booking-date") {
    if (!target.value || !target.checkValidity()) return;
    const offset =
      Math.floor(
        (Date.parse(target.value) - Date.parse(state.config.today)) /
          86_400_000 /
          7,
      ) * 7;
    state.weekStart = addDays(state.config.today, offset);
    await loadAvailability(target.value);
  } else if (target.id === "booking-quantity") {
    state.quantity = Number(target.value);
    state.bookingError = "";
    renderSummary();
  }
});

document.addEventListener("click", async (event) => {
  if (state.switchingUnit) {
    if (event.target.closest('a[href^="#"], [data-action]')) {
      event.preventDefault();
      toast("Please wait while your unit changes.");
    }
    return;
  }
  if (state.committing && event.target.closest('a[href^="#"]')) {
    event.preventDefault();
    toast("Please wait for your booking submission to finish.");
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  try {
    if (action === "toggle-password") {
      const input = document.querySelector("#password");
      input.type = input.type === "password" ? "text" : "password";
      button.setAttribute(
        "aria-label",
        input.type === "password" ? "Show password" : "Hide password",
      );
      button.setAttribute("aria-pressed", String(input.type === "text"));
    } else if (action === "login-help") {
      openModal(
        "help",
        "A little help signing in.",
        '<p class="modal-copy">Use the same email, phone number or username and password as your estate owner account. The portal always signs in as a unit owner.</p><p class="modal-copy">To reset a forgotten password, use <strong>Forgot Password</strong> in the estate app. Contact estate management if your account or unit needs activation.</p><button class="button full" data-action="close-modal">Back to sign in</button>',
        "OWNER ACCESS",
      );
    } else if (action === "logout") {
      button.disabled = true;
      stopBookingQr();
      await forgetEntry();
      await api("/api/logout", {});
      state.session = null;
      state.facilities = [];
      state.bookings = [];
      state.bookingDetail = null;
      state.activity = null;
      state.activityStorageError = "";
      state.routeGeneration++;
      closeModal();
      history.replaceState(null, "", location.pathname + location.search);
      renderLogin();
    } else if (action === "save-entry") {
      if (!state.session || state.config.demo || state.savingPass) return;
      const csrf = state.session.csrfToken;
      state.savingPass = true;
      button.disabled = true;
      try {
        const saved = await passStore.save(entryPassFromSession(state.session));
        if (state.session?.csrfToken === csrf) state.savedPass = saved;
      } finally {
        state.savingPass = false;
        if (state.session?.csrfToken === csrf && entryRoute()) renderEntry();
      }
    } else if (action === "forget-entry") {
      button.disabled = true;
      await forgetEntry();
      if (state.session) renderEntry();
      else renderLogin("Saved entry pass removed from this device.");
    } else if (action === "show-entry" || action === "refresh-entry") {
      if (location.hash !== "#/qr") location.hash = "#/qr";
      else await route();
    } else if (action === "reload") await route();
    else if (action === "export-activity") await exportActivity();
    else if (action === "clear-activity") {
      openModal(
        "clear-activity",
        "Clear this unit’s local activity?",
        '<p class="modal-copy">This removes the activity saved in this browser for the signed-in account and selected unit. It does not cancel any estate booking. Current records can be observed again when you refresh.</p><div class="modal-actions"><button class="button secondary" data-action="close-modal">Keep log</button><button class="button" data-action="confirm-clear-activity">Clear local log</button></div>',
        "ACTIVITY LOG",
      );
    } else if (action === "confirm-clear-activity") {
      if (state.modalType !== "clear-activity") return;
      const scope = activityScope();
      if (!scope) return;
      button.disabled = true;
      const log = await activityStore.clear(scope);
      if (!sameActivityScope(scope)) return;
      state.activity = log;
      state.activityStorageError = log.storageError || "";
      state.activitySyncError = "";
      closeModal();
      renderActivity();
      toast("This unit’s local activity was cleared.");
    } else if (action === "explore")
      document
        .querySelector("#facilities-section")
        ?.scrollIntoView({ behavior: "smooth" });
    else if (action === "filter") {
      state.filter = button.dataset.value;
      document.querySelectorAll(".filter").forEach((filter) => {
        const selected = filter.dataset.value === state.filter;
        filter.classList.toggle("active", selected);
        filter.setAttribute("aria-pressed", String(selected));
      });
      document.querySelector("#facility-grid").innerHTML = facilityCards();
    } else if (action === "clear-filters") {
      state.filter = "All facilities";
      state.search = "";
      renderFacilities();
    } else if (action === "date") await loadAvailability(button.dataset.value);
    else if (action === "week-prev" || action === "week-next") {
      const next = addDays(state.weekStart, action === "week-prev" ? -7 : 7);
      if (next >= state.config.today && next <= state.config.lastDate) {
        state.weekStart = next;
        renderDetail();
      }
    } else if (action === "slot") {
      const slot = state.slots.find((s) => s.id === button.dataset.value);
      if (!slot?.enabled) return;
      state.selectedSlot = slot;
      state.quantity = 1;
      state.bookingError = "";
      document.querySelector("#slots").innerHTML = slotMarkup();
      renderSummary();
      document
        .querySelector("#booking-summary")
        ?.scrollIntoView({ block: "nearest" });
    } else if (action === "refresh-slots") await loadAvailability(state.date);
    else if (action === "close-modal") closeModal();
    else if (action === "book") await bookSelected();
    else if (action === "return-availability") {
      closeModal();
      await loadAvailability(state.date);
    } else if (action === "go-bookings") {
      closeModal();
      const hash =
        button.dataset.tab === "current"
          ? "#/bookings/current"
          : "#/bookings/unpaid";
      if (location.hash === hash) await route();
      else location.hash = hash;
    } else if (action === "payment-status") {
      button.disabled = true;
      const generation = state.routeGeneration;
      const bookingId = button.dataset.booking;
      try {
        const result = await api(
          bookingId
            ? `/api/bookings/${encodeURIComponent(bookingId)}/payment`
            : "/api/payments/" + encodeURIComponent(button.dataset.value),
        );
        if (
          !button.isConnected ||
          !modal.open ||
          generation !== state.routeGeneration
        )
          return;
        if (bookingId) {
          showBookingDetails(bookingId, result);
          if (
            ["paid", "free"].includes(result.status) &&
            result.booking?.tab === "current"
          ) {
            state.bookings = state.bookings.filter(
              (booking) => booking.id !== bookingId,
            );
            renderBookings();
          }
          return;
        }
        const status = document.querySelector("#payment-status");
        if (status)
          status.textContent =
            result.status === "free"
              ? "No payment required. Check My bookings for confirmation."
              : result.status === "paid"
                ? "Payment received."
                : result.status === "expired"
                  ? "This payment order has expired. Please check your reservation in the estate app."
                  : "Payment is still pending confirmation from the estate.";
      } finally {
        button.disabled = false;
      }
    } else if (action === "booking-qr") showBookingQr(button.dataset.value);
    else if (action === "refresh-booking-qr") {
      if (activeBookingQr) {
        activeBookingQr.terminal = false;
        await refreshBookingQr(activeBookingQr);
      }
    } else if (action === "booking-details")
      showBookingDetails(button.dataset.value);
    else if (action === "complete-payment")
      await mutateReservation(button.dataset.value, "payment");
    else if (action === "cancel-booking")
      confirmCancellation(button.dataset.value);
    else if (action === "confirm-cancel-booking")
      await mutateReservation(button.dataset.value, "cancel");
  } catch (error) {
    toast(error.message, true);
    if (button.isConnected) button.disabled = false;
  }
});

document.addEventListener(
  "error",
  (event) => {
    if (
      event.target instanceof HTMLImageElement &&
      event.target.hasAttribute("data-booking-qr")
    ) {
      document.querySelector("#booking-qr-images")?.replaceChildren();
      const status = document.querySelector("#booking-qr-status");
      if (status)
        status.textContent =
          "This entry image could not be displayed. Refresh the code to try again.";
      return;
    }
    if (
      event.target instanceof HTMLImageElement &&
      !event.target.src.split("?")[0].endsWith("/assets/estate.jpg")
    )
      event.target.src = assetUrl("/assets/estate.jpg");
  },
  true,
);

let lastHash = location.hash;
window.addEventListener("hashchange", () => {
  if (state.committing || state.switchingUnit) {
    history.replaceState(null, "", lastHash || "#/facilities");
    return;
  }
  lastHash = location.hash;
  void route();
});
window.addEventListener("beforeunload", (event) => {
  if (state.committing) {
    event.preventDefault();
    event.returnValue = "";
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopBookingQr({ retain: true });
    stopEntry();
    document.querySelector("#entry-qr")?.replaceChildren();
    return;
  }
  if (state.modalType === "booking-qr" && activeBookingQr) {
    activeBookingQr.terminal = false;
    void refreshBookingQr(activeBookingQr);
    return;
  }
  // Returning from another app must not discard an open dialog.
  if (state.committing || state.switchingUnit || modal.open) return;
  if (state.session || savedPassReady()) {
    if (location.hash !== "#/qr") location.hash = "#/qr";
    else void route();
  } else if (entryRoute()) void route();
});

window.addEventListener("sesame-session-ended", () => {
  if (!state.session) return;
  stopEntry();
  stopBookingQr();
  state.session = null;
  state.savedPass = null;
  state.bookings = [];
  state.bookingDetail = null;
  state.activity = null;
  state.facilities = [];
  state.detail = null;
  state.slots = [];
  state.committing = false;
  state.switchingUnit = false;
  state.routeGeneration++;
  state.availabilityGeneration++;
  resetSelection();
  closeModal();
  renderLogin(
    "Your saved sign-in was cleared or changed in another tab. Reopen Sesame to use the current login, or sign in here.",
  );
});

if (pageRequest)
  window.addEventListener("pagehide", () => {
    stopEntry();
    stopBookingQr();
    state.savedPass = null;
    state.session = null;
    state.bookings = [];
    state.bookingDetail = null;
    state.activity = null;
    state.facilities = [];
    state.detail = null;
    state.slots = [];
    resetSelection();
    state.routeGeneration++;
  });

async function start() {
  try {
    state.config = await api("/api/config");
  } catch (error) {
    app.innerHTML = `<main class="boot-screen" id="main-content"><span class="brand-mark">G</span><h1 class="serif">The portal isn’t available yet.</h1><p>${esc(error.message)}</p><p>Start the local server, then refresh this page.</p></main>`;
    return;
  }
  activityStore = createActivityStore({
    ...(state.config.demo ? { indexedDB: null } : {}),
    now: () => Date.now(),
  });
  if (!state.config.demo) {
    try {
      state.savedPass = await passStore.load();
    } catch {
      state.savedPass = null;
    }
  }
  try {
    state.session = await api("/api/session");
    updateConfig(state.session);
    if (state.savedPass && !savedPassMatches(state.session))
      await forgetEntry();
  } catch {
    state.session = null;
  }
  await route();
}
void start();
