import { createPaymentQr } from "./payment-qr.js";
import {
  entryPassFromSession,
  createEntryQr,
  ENTRY_REFRESH_MS,
} from "./entry-pass.js";
import { createPassStore } from "./pass-store.js";

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
  modalType: "",
  bookings: [],
  tab: "current",
  savedPass: null,
  savingPass: false,
};
const passStore = createPassStore();
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
    if (response.status === 401 && path !== "/api/login" && state.session) {
      state.session = null;
      state.bookings = [];
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
        ${state.config.browserClient ? '<p class="field-note">You stay signed in when this tab refreshes. Your password is never saved. Sesame is an independent resident portal.</p>' : ""}
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
        : "facilities";
  app.innerHTML = `<div class="app-layout">
    <aside class="sidebar" aria-label="Resident navigation"><a class="brand" href="#/qr" aria-label="My resident entry QR">${brand()}</a>
      <p class="nav-label">YOUR ESTATE</p>
      <nav><a href="#/qr" class="nav-item ${active === "qr" ? "active" : ""}" ${active === "qr" ? 'aria-current="page"' : ""}>${icon("qr")} My entry QR</a>
      <a href="#/facilities" class="nav-item ${active === "facilities" ? "active" : ""}" ${active === "facilities" ? 'aria-current="page"' : ""}>${icon("grid")} Facilities ${icon("chevron", "nav-arrow")}</a>
      <a href="#/bookings" class="nav-item ${active === "bookings" ? "active" : ""}" ${active === "bookings" ? 'aria-current="page"' : ""}>${icon("calendarCheck")} My bookings</a></nav>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-bottom"><span class="avatar" aria-hidden="true">${esc(user.name.slice(0, 1).toUpperCase())}</span><div><p class="account-name">${esc(user.name)}</p><p class="account-role">${authenticated ? "Unit owner" : "Saved on this device"}</p></div><button class="icon-button" data-action="${authenticated ? "logout" : "forget-entry"}" title="${authenticated ? "Sign out" : "Forget saved pass"}" aria-label="${authenticated ? "Sign out" : "Forget saved pass"}">${icon("logout")}</button></div>
    </aside>
    <div class="workspace"><header class="topbar"><div class="topbar-crumb"><span>Resident services</span><span class="crumb-divider">/</span><span class="current">${esc(section)}</span></div>
      <div class="topbar-actions"><span class="property-tag">Resident portal</span><label class="unit-control">${icon("home")}<span><small>YOUR UNIT</small><select id="unit-select" aria-label="Active owner unit" ${units.length < 2 ? "disabled" : ""}>${units.length ? units.map((u) => `<option value="${esc(u.unitId)}" ${u.unitId === unit?.unitId ? "selected" : ""}>${esc(unitLabel(u))}</option>`).join("") : "<option>No active unit</option>"}</select></span></label></div></header>
      ${state.config.staticDemo ? '<div class="mode-banner"><strong>PUBLIC DEMO</strong><span>Sample data only. No real bookings or payments.</span></div>' : state.config.demo ? '<div class="mode-banner"><strong>DEMO</strong> An offline preview. All bookings here are simulated.</div>' : state.config.readOnly ? '<div class="mode-banner readonly">Read-only mode · Explore facilities and availability. Submissions are disabled.</div>' : ""}
      <main class="page${active === "qr" ? " entry-page" : ""}" id="main-content" tabindex="-1">${content}
        <footer class="page-footer"><span>SESAME &nbsp; / &nbsp; RESIDENT PORTAL</span><span>${icon("clock")} All facility times are in Singapore time (SGT).</span></footer>
      </main>
    </div>
    <nav class="mobile-nav" aria-label="Mobile resident navigation">
      <a href="#/qr" ${active === "qr" ? 'aria-current="page"' : ""}>${icon("qr")}<span>My QR</span></a>
      <a href="#/facilities" ${active === "facilities" ? 'aria-current="page"' : ""}>${icon("grid")}<span>Facilities</span></a>
      <a href="#/bookings" ${active === "bookings" ? 'aria-current="page"' : ""}>${icon("calendarCheck")}<span>My bookings</span></a>
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
              return `<article class="booking-row"><div class="booking-row-left"><div class="booking-date"><span>${valid ? esc(dateFormat(date, { day: undefined, month: "short" })) : "—"}</span><strong>${valid ? Number(date.slice(8)) : "—"}</strong></div><div><h3>${esc(b.facilityName)}</h3><p class="booking-day">${valid ? `<time datetime="${esc(date)}">${esc(dateFormat(date, { weekday: "long", month: "long", year: "numeric" }))}</time>` : "Date unavailable"}</p><p>${esc(timeRange(b.startTime.slice(11), b.endTime.slice(11)))} · ${b.quantity} ${b.quantity === 1 ? "session" : "sessions"}</p><p class="booking-reference">Booking ${esc(b.id)}</p></div></div><div class="booking-row-right"><strong>${esc(money(b.amount ?? (b.price == null ? null : b.price * b.quantity)))}</strong><span class="pill ${tab === "unpaid" ? "amber" : ""}">${tabNames[tab]}</span><br><button class="text-button" data-action="booking-details" data-value="${esc(b.id)}">View details</button></div></article>`;
            })
            .join("")
        : `<section class="empty-state"><div class="empty-icon">${icon("calendarCheck")}</div><h2>${titles[tab]}</h2><p>${descriptions[tab]}</p><a class="button" href="#/facilities">Explore facilities ${icon("arrow")}</a></section>`
    }`,
    "My bookings",
  );
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
  stopEntry();
  if (!state.session) {
    if (entryRoute() && savedPassReady() && !state.config.demo) renderEntry();
    else renderLogin();
    return;
  }
  const generation = ++state.routeGeneration;
  state.availabilityGeneration++;
  state.detail = null;
  resetSelection();
  closeModal();
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const section = entryRoute()
    ? "Entry QR"
    : parts[0] === "bookings"
      ? "My bookings"
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
    if (parts[0] === "facility" && parts[1]) {
      const detail = await api(
        "/api/facilities/" + encodeURIComponent(parts[1]),
      );
      if (generation !== state.routeGeneration) return;
      state.detail = detail;
      state.weekStart = state.config.today;
      await loadAvailability(state.config.today);
    } else if (parts[0] === "bookings") {
      state.tab = Object.hasOwn(tabNames, parts[1]) ? parts[1] : "current";
      const bookings = await api("/api/bookings?tab=" + state.tab);
      if (generation !== state.routeGeneration) return;
      state.bookings = bookings;
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
function openModal(type, heading, body, eyebrow = "SESAME") {
  if (!modal.open) returnFocus = document.activeElement;
  state.modalType = type;
  modal.innerHTML = `<header class="modal-head"><div><p class="eyebrow">${esc(eyebrow)}</p><h2 id="modal-title">${esc(heading)}</h2></div><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></header><div class="modal-body">${body}</div>`;
  if (!modal.open) modal.showModal();
  document.documentElement.classList.add("modal-open");
}

function closeModal() {
  if (state.committing) return;
  if (modal.open) modal.close();
  state.modalType = "";
}

modal.addEventListener("close", () => {
  if (modal.open) return;
  document.documentElement.classList.remove("modal-open");
  state.modalType = "";
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
  if (state.committing || !state.selectedSlot || state.config.readOnly) return;
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
    paymentMethod: "Bank transfer / PayNow UEN",
  };
  state.committing = true;
  state.bookingError = "";
  renderSummary();
  const controls = [...app.querySelectorAll("button, input, select")].map(
    (element) => ({ element, disabled: element.disabled }),
  );
  for (const { element } of controls) element.disabled = true;
  try {
    const result = await api("/api/bookings", selection);
    state.committing = false;
    if (state.session && generation === state.routeGeneration)
      showResult(result);
  } catch (error) {
    state.committing = false;
    if (!state.session || generation !== state.routeGeneration) return;
    if (
      ["CONNECTION_INTERRUPTED", "INTERNAL_ERROR"].includes(error.code) ||
      !error.code
    ) {
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
  const ok = result.status === "payment_pending";
  openModal(
    "result",
    ok
      ? state.config.demo
        ? "Your demo booking is ready."
        : "Booking submitted."
      : "Booking status unconfirmed.",
    `<div class="result-icon">${icon(ok ? "calendarCheck" : "info")}</div><p class="modal-copy">${esc(state.config.demo && ok ? "This reservation exists only in the offline demonstration. No payment is needed." : result.message)}</p>${reviewDetails(result)}
    ${result.orderNo ? `<span class="result-reference">Order reference: ${esc(result.orderNo)}</span>` : ""}${result.bookingId ? `<span class="result-reference">Booking reference: ${esc(result.bookingId)}</span>` : ""}
    ${ok && !state.config.demo ? bankInstructions() : ""}
    ${ok ? '<p class="status-line" id="payment-status" role="status">Payment status: pending</p>' : ""}
    <div class="modal-actions">${ok ? `<button class="button secondary" data-action="payment-status" data-value="${esc(result.previewId)}">${icon("refresh")} Check payment</button>` : ""}<button class="button" data-action="go-bookings">View my bookings ${icon("arrow")}</button></div>`,
    ok ? "BOOKING SUBMITTED" : "SUBMISSION STATUS",
  );
}

function paymentStatusText(status) {
  return (
    {
      paid: "Payment received.",
      expired:
        "This payment order has expired. Use Complete payment to continue the reservation.",
      not_started:
        "No payment order is set up yet. Use Complete payment to continue.",
      pending: "Payment is still pending confirmation from the estate.",
    }[status] || "Payment has not been checked yet."
  );
}

function showBookingDetails(id, payment = null) {
  const booking = payment?.booking || state.bookings.find((b) => b.id === id);
  if (!booking) return;
  const pending = booking.tab === "unpaid" && payment?.status !== "paid";
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
    <div class="modal-actions reservation-actions">${pending ? `<button class="button" data-action="complete-payment" data-value="${esc(id)}" ${state.config.readOnly ? "disabled" : ""}>Complete payment</button>` : ""}
    ${booking.tab === "unpaid" || payment ? `<button class="button secondary" data-action="payment-status" data-booking="${esc(id)}">${icon("refresh")} Check payment</button>` : ""}
    ${pending ? `<button class="button secondary" data-action="cancel-booking" data-value="${esc(id)}" ${state.config.readOnly ? "disabled" : ""}>Cancel reservation</button>` : ""}
    <button class="button secondary" data-action="close-modal">Close</button></div>`,
    "YOUR BOOKING",
  );
}

function confirmCancellation(id) {
  const booking = state.bookings.find((b) => b.id === id);
  if (!booking || booking.tab !== "unpaid" || state.config.readOnly) return;
  openModal(
    "cancel-booking",
    "Cancel this reservation?",
    `<p class="modal-copy">${esc(booking.facilityName)} · ${esc(dateFormat(booking.startTime.slice(0, 10), { weekday: "long", month: "long", year: "numeric" }))} · ${esc(timeRange(booking.startTime.slice(11), booking.endTime.slice(11)))}</p><p>Your time slot will be released when the estate confirms cancellation.</p><span class="result-reference">Booking reference: ${esc(id)}</span><div class="form-error" id="reservation-error" role="alert"></div><div class="modal-actions"><button class="button secondary" data-action="booking-details" data-value="${esc(id)}">Keep reservation</button><button class="button" data-action="confirm-cancel-booking" data-value="${esc(id)}">Confirm cancellation</button></div>`,
    "PENDING RESERVATION",
  );
}

async function mutateReservation(id, action) {
  if (state.committing || state.config.readOnly) return;
  const generation = state.routeGeneration;
  state.committing = true;
  const controls = [...document.querySelectorAll("button, input, select")].map(
    (element) => ({ element, disabled: element.disabled }),
  );
  for (const { element } of controls) element.disabled = true;
  try {
    const result = await api(
      `/api/bookings/${encodeURIComponent(id)}/${action}`,
      { confirm: true },
    );
    state.committing = false;
    if (!state.session || generation !== state.routeGeneration) return;
    if (action === "cancel") {
      closeModal();
      await route();
      toast("Reservation cancelled.");
    } else {
      showBookingDetails(id, result);
      if (result.status === "paid") {
        state.bookings = state.bookings.filter((booking) => booking.id !== id);
        renderBookings();
      }
    }
  } catch (error) {
    if (!state.session || generation !== state.routeGeneration) return;
    const message = ["CONNECTION_INTERRUPTED", "INTERNAL_ERROR"].includes(
      error.code,
    )
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
    if (state.committing) {
      target.value = state.session.unit.unitId;
      return;
    }
    target.disabled = true;
    try {
      state.session = await api("/api/unit", { unitId: target.value });
      const destination = entryRoute() ? "#/qr" : "#/facilities";
      if (location.hash !== destination) location.hash = destination;
      else await route();
    } catch (error) {
      toast(error.message, true);
      target.value = state.session?.unit?.unitId || "";
      target.disabled = false;
    }
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
      await forgetEntry();
      await api("/api/logout", {});
      state.session = null;
      state.facilities = [];
      state.bookings = [];
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
    else if (action === "explore")
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
      const hash = "#/bookings/unpaid";
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
          if (result.status === "paid") {
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
            result.status === "paid"
              ? "Payment received."
              : result.status === "expired"
                ? "This payment order has expired. Please check your reservation in the estate app."
                : "Payment is still pending confirmation from the estate.";
      } finally {
        button.disabled = false;
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
      !event.target.src.split("?")[0].endsWith("/assets/estate.jpg")
    )
      event.target.src = assetUrl("/assets/estate.jpg");
  },
  true,
);

let lastHash = location.hash;
window.addEventListener("hashchange", () => {
  if (state.committing) {
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
    stopEntry();
    document.querySelector("#entry-qr")?.replaceChildren();
    return;
  }
  // Returning from another app must not discard an open dialog.
  if (state.committing || modal.open) return;
  if (state.session || savedPassReady()) {
    if (location.hash !== "#/qr") location.hash = "#/qr";
    else void route();
  } else if (entryRoute()) void route();
});

if (pageRequest)
  window.addEventListener("pagehide", () => {
    stopEntry();
    state.savedPass = null;
    state.session = null;
    state.bookings = [];
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
