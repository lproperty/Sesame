export const ACTIVITY_DATABASE = "sesame-booking-activity-v1";
export const ACTIVITY_LIMITS = Object.freeze({
  observations: 5000,
  events: 10000,
});
const STORE = "activity";
const encoder = new TextEncoder();
const clone = (value) => JSON.parse(JSON.stringify(value));
const tabs = new Set(["current", "history", "unpaid"]);
const tabValue = (value) =>
  value === "past" ? "history" : tabs.has(value) ? value : null;
const outcomes = new Set(["uncertain", "success", "failed"]);
const actions = new Set(["booking", "cancellation"]);

function identifier(value, optional = false) {
  if (optional && (value == null || value === "")) return "";
  if (
    (typeof value !== "string" && !Number.isSafeInteger(value)) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(String(value))
  )
    throw new Error("Activity requires an exact valid identifier.");
  return String(value);
}

function scopeValue(value) {
  return {
    ownerId: identifier(value?.ownerId),
    projectId: identifier(value?.projectId),
    unitId: identifier(value?.unitId),
  };
}

export function activityScopeFromSession(session) {
  const unit = session?.units?.find(
    (candidate) =>
      candidate.unitId === session.unit?.unitId &&
      candidate.projectId === session.unit?.projectId &&
      candidate.userType === 0,
  );
  if (!session?.user?.id || !unit)
    throw new Error("Sign in with your owner unit to view its local activity.");
  return scopeValue({
    ownerId: session.user.id,
    projectId: unit.projectId,
    unitId: unit.unitId,
  });
}

function timestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/.test(
      value,
    )
  )
    return null;
  const date = value.slice(0, 10);
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    return null;
  // Keep the estate's wall time/offset. It is never relabelled as a local
  // observation, action, or cancellation audit timestamp.
  return value;
}

const amount = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000
    ? value
    : null;
const label = (value) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200)
    : "";

function bookingValue(value, { requireId = false, tab } = {}) {
  return {
    id: identifier(value?.id, !requireId),
    facilityId: identifier(value?.facilityId, true),
    facilityName: label(value?.facilityName) || "Facility booking",
    startTime: timestamp(value?.startTime),
    endTime: timestamp(value?.endTime),
    quantity:
      Number.isSafeInteger(value?.quantity) &&
      value.quantity > 0 &&
      value.quantity <= 999
        ? value.quantity
        : 1,
    amount: amount(value?.amount),
    price: amount(value?.price),
    tab: tabValue(tab) || tabValue(value?.tab),
    orderTime: timestamp(value?.orderTime),
    createdAt: timestamp(value?.createdAt),
    updatedAt: timestamp(value?.updatedAt),
  };
}

function emptyLog(scope) {
  return {
    version: 1,
    scope,
    startedAt: null,
    observations: [],
    events: [],
    truncated: { observations: 0, events: 0 },
  };
}

function cleanEvent(value) {
  if (!actions.has(value?.action) || !outcomes.has(value?.outcome))
    throw new Error("Invalid activity action or outcome.");
  const attemptedAt = timestamp(value.attemptedAt);
  if (!attemptedAt)
    throw new Error("An activity action needs its device timestamp.");
  const resolvedAt =
    value.outcome === "uncertain" ? null : timestamp(value.resolvedAt);
  if (value.outcome !== "uncertain" && !resolvedAt)
    throw new Error(
      "A resolved action needs its device confirmation timestamp.",
    );
  return {
    id: identifier(value.id),
    action: value.action,
    outcome: value.outcome,
    booking: bookingValue(value.booking, {
      requireId: value.action === "cancellation",
    }),
    attemptedAt,
    resolvedAt,
    errorCode:
      typeof value.errorCode === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode)
        ? value.errorCode
        : null,
  };
}

function cleanLog(value, scope) {
  if (
    value?.version !== 1 ||
    JSON.stringify(scopeValue(value.scope)) !== JSON.stringify(scope) ||
    !Array.isArray(value.observations) ||
    !Array.isArray(value.events) ||
    value.observations.length > ACTIVITY_LIMITS.observations ||
    value.events.length > ACTIVITY_LIMITS.events
  )
    throw new Error("Invalid saved activity.");
  return {
    version: 1,
    scope,
    startedAt: timestamp(value.startedAt),
    observations: value.observations.map((row) => {
      if (!timestamp(row.firstObservedAt) || !timestamp(row.lastObservedAt))
        throw new Error("Invalid booking observation timestamp.");
      return {
        ...bookingValue(row, { requireId: true }),
        firstObservedAt: row.firstObservedAt,
        lastObservedAt: row.lastObservedAt,
      };
    }),
    events: value.events.map(cleanEvent),
    truncated: {
      observations:
        Number.isSafeInteger(value.truncated?.observations) &&
        value.truncated.observations >= 0
          ? value.truncated.observations
          : 0,
      events:
        Number.isSafeInteger(value.truncated?.events) &&
        value.truncated.events >= 0
          ? value.truncated.events
          : 0,
    },
  };
}

function capLog(log) {
  for (const field of ["observations", "events"]) {
    const excess = log[field].length - ACTIVITY_LIMITS[field];
    if (excess > 0) {
      log[field].sort((a, b) =>
        String(a.lastObservedAt || a.attemptedAt).localeCompare(
          String(b.lastObservedAt || b.attemptedAt),
        ),
      );
      log[field].splice(0, excess);
      log.truncated[field] += excess;
    }
  }
  return log;
}

// AES-GCM and its non-extractable key remain in this browser. This does not
// protect an unlocked browser from same-origin code. Only explicit booking
// fields enter the log: never full sessions, API responses, errors or QR data.
export function createActivityStore({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  now = () => Date.now(),
} = {}) {
  const available = Boolean(
    indexedDB && crypto?.subtle && crypto?.getRandomValues,
  );
  const memory = new Map();
  const impaired = new Map();
  let pending = Promise.resolve();
  let sequence = 0;
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("The device clock is unavailable.");
    return new Date(value).toISOString();
  };
  const randomId = () => {
    if (crypto?.getRandomValues)
      return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    return `temporary-${now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;
  };
  const serial = (operation) => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const localKey = (scope) => JSON.stringify(scope);
  const diskKey = async (scope) => {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(localKey(scope)),
    );
    return Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  };
  const open = () =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(ACTIVITY_DATABASE, 1);
      let settled = false;
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = request.onblocked = () => {
        settled = true;
        reject(new Error("Local activity storage is unavailable."));
      };
      request.onsuccess = () => {
        if (settled) request.result.close();
        else resolve(request.result);
      };
    });
  const transact = async (mode, operation) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        let result;
        operation(transaction.objectStore(STORE), (value) => {
          result = value;
        });
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () =>
          reject(new Error("Local activity storage could not be updated."));
      });
    } finally {
      db.close();
    }
  };
  const readRecord = (key) =>
    transact("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result);
    });
  const fallback = (scope, message) => {
    const key = localKey(scope);
    impaired.set(key, message);
    return {
      log: clone(memory.get(key) || emptyLog(scope)),
      record: null,
      persistent: false,
      storageError: message,
    };
  };
  const read = async (scope) => {
    const key = localKey(scope);
    if (!available || impaired.has(key))
      return fallback(
        scope,
        impaired.get(key) ||
          "This browser keeps activity in this tab only; it will not survive a refresh.",
      );
    try {
      const record = await readRecord(await diskKey(scope));
      if (!record)
        return {
          log: emptyLog(scope),
          record: null,
          persistent: true,
          storageError: null,
        };
      if (
        record.version !== 1 ||
        !record.revision ||
        !record.resetId ||
        record.key?.extractable !== false ||
        record.key?.algorithm?.name !== "AES-GCM" ||
        record.iv?.byteLength !== 12 ||
        !record.ciphertext?.byteLength ||
        record.ciphertext.byteLength > 32 * 1024 * 1024
      )
        throw new Error("Invalid saved activity.");
      const bytes = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: record.iv,
          additionalData: encoder.encode(`Sesame booking activity v1:${key}`),
        },
        record.key,
        record.ciphertext,
      );
      const log = cleanLog(JSON.parse(new TextDecoder().decode(bytes)), scope);
      memory.set(key, log);
      return { log: clone(log), record, persistent: true, storageError: null };
    } catch {
      // Preserve unreadable ciphertext. A later browser session may recover it;
      // only the user's explicit clear replaces it. Do not silently lose history.
      return fallback(
        scope,
        "Saved activity could not be opened. New activity is temporary in this tab; export it before leaving.",
      );
    }
  };
  const envelope = async (scope, log, previous, reset = false) => {
    const key =
      previous?.key ||
      (await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(
          `Sesame booking activity v1:${localKey(scope)}`,
        ),
      },
      key,
      encoder.encode(JSON.stringify(log)),
    );
    return {
      version: 1,
      revision: randomId(),
      resetId: (!reset && previous?.resetId) || randomId(),
      // Keep the clear marker for this generation, even after new activity,
      // so an older tab's first-ever pending write cannot revive cleared data.
      cleared: reset || previous?.cleared === true,
      key,
      iv,
      ciphertext,
    };
  };
  const view = (result) => ({
    ...clone(result.log),
    persistent: result.persistent,
    storageError: result.storageError,
    limits: { ...ACTIVITY_LIMITS },
  });
  const change = async (scope, update) => {
    let firstReset;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await read(scope);
      if (attempt === 0) firstReset = current.record?.resetId;
      else if (
        (firstReset && current.record?.resetId !== firstReset) ||
        (!firstReset && attempt > 0 && current.record?.cleared)
      )
        throw new Error(
          "Activity was cleared in another tab. This old update was not restored.",
        );
      const log = capLog(update(clone(current.log)));
      if (!current.persistent) {
        memory.set(localKey(scope), log);
        return view({ ...current, log });
      }
      try {
        const next = await envelope(scope, log, current.record);
        const key = await diskKey(scope);
        // Compare and replace inside one IDB transaction. Concurrent tabs retry
        // against the latest log, so unrelated activity is not overwritten.
        const saved = await transact("readwrite", (store, done) => {
          const request = store.get(key);
          request.onsuccess = () => {
            if (
              (request.result?.revision || null) !==
              (current.record?.revision || null)
            )
              return done(false);
            store.put(next, key);
            done(true);
          };
        });
        if (!saved) continue;
        memory.set(localKey(scope), log);
        return view({ log, persistent: true, storageError: null });
      } catch {
        memory.set(localKey(scope), log);
        return view(
          fallback(
            scope,
            "Activity could not be saved. This tab has a temporary copy; export it before leaving.",
          ),
        );
      }
    }
    throw new Error("Activity changed in another tab. Try reading it again.");
  };

  const load = (input) =>
    serial(async () => view(await read(scopeValue(input))));
  return {
    available,
    load,
    observe: (input, bookings, { tab } = {}) =>
      serial(async () => {
        const scope = scopeValue(input);
        if (!Array.isArray(bookings))
          throw new Error("Booking observations must be a list.");
        const observedAt = clock();
        const cleaned = bookings.map((booking) =>
          bookingValue(booking, { requireId: true, tab }),
        );
        return change(scope, (log) => {
          log.startedAt ||= observedAt;
          const rows = new Map(log.observations.map((row) => [row.id, row]));
          for (const booking of cleaned) {
            const previous = rows.get(booking.id);
            rows.set(booking.id, {
              ...booking,
              orderTime: booking.orderTime || previous?.orderTime || null,
              createdAt: booking.createdAt || previous?.createdAt || null,
              updatedAt: booking.updatedAt || previous?.updatedAt || null,
              firstObservedAt: previous?.firstObservedAt || observedAt,
              lastObservedAt: observedAt,
            });
          }
          // An absent row is not a proven cancellation. Retain its last known
          // observation without manufacturing a status or event timestamp.
          log.observations = [...rows.values()];
          return log;
        });
      }),
    recordAction: (input, action) =>
      serial(async () => {
        const scope = scopeValue(input);
        const recordedAt = clock();
        const updating = action?.id != null;
        const eventId = updating ? identifier(action.id) : randomId();
        let savedEvent;
        const result = await change(scope, (log) => {
          const previous = log.events.find((event) => event.id === eventId);
          if (updating && !previous)
            throw new Error(
              "This action was not found in the selected owner/unit log.",
            );
          if (
            previous &&
            (previous.action !== action.action ||
              (previous.outcome !== "uncertain" &&
                previous.outcome !== action.outcome))
          )
            throw new Error(
              "A resolved action cannot be changed to a different result.",
            );
          const event = cleanEvent({
            id: eventId,
            action: action.action,
            outcome: action.outcome,
            booking: {
              ...(previous?.booking || {}),
              ...(action.booking || {}),
            },
            attemptedAt:
              previous?.attemptedAt ||
              timestamp(action.attemptedAt) ||
              recordedAt,
            resolvedAt:
              action.outcome === "uncertain"
                ? null
                : previous?.resolvedAt ||
                  timestamp(action.resolvedAt) ||
                  recordedAt,
            errorCode: action.errorCode,
          });
          if (previous?.booking.id && previous.booking.id !== event.booking.id)
            throw new Error(
              "An action cannot be reassigned to another booking.",
            );
          savedEvent = event;
          log.startedAt ||= event.attemptedAt;
          if (previous) log.events[log.events.indexOf(previous)] = event;
          else log.events.push(event);
          return log;
        });
        return {
          event: clone(savedEvent),
          persistent: result.persistent,
          storageError: result.storageError,
        };
      }),
    clear: (input) =>
      serial(async () => {
        const scope = scopeValue(input);
        const log = emptyLog(scope);
        if (available) {
          try {
            const key = await diskKey(scope);
            const next = await envelope(scope, log, null, true);
            await transact("readwrite", (store, done) => {
              store.put(next, key);
              done(true);
            });
            impaired.delete(localKey(scope));
            memory.set(localKey(scope), log);
            return view({ log, persistent: true, storageError: null });
          } catch {
            // A failed disk clear must not claim that old persisted data is gone.
            throw new Error(
              "Saved activity could not be cleared. Try again before leaving this device.",
            );
          }
        }
        memory.set(localKey(scope), log);
        return view(
          fallback(
            scope,
            "This browser keeps activity in this tab only; it will not survive a refresh.",
          ),
        );
      }),
    export: (input) =>
      serial(async () => {
        const result = view(await read(scopeValue(input)));
        return (
          JSON.stringify(
            {
              format: "Sesame local booking activity",
              exportedAt: clock(),
              coverage:
                "Observations and actions recorded by this browser from now on. Not a complete estate history, cancellation audit, or remaining-quota ledger.",
              timestampMeaning:
                "firstObservedAt/lastObservedAt and attemptedAt/resolvedAt are device times; orderTime/createdAt/updatedAt are estate-provided values when available.",
              ...result,
            },
            null,
            2,
          ) + "\n"
        );
      }),
  };
}

function singaporeMonth(value) {
  if (!timestamp(value)) return "";
  const normalized = value.replace(" ", "T");
  const instant = /(?:Z|[+-]\d\d:?\d\d)$/.test(normalized)
    ? normalized
    : normalized + "+08:00";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(instant));
  return `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}`;
}

export function summarizeActivity(log, { month } = {}) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month || ""))
    throw new Error("Choose a valid activity month.");
  const observations = (log?.observations || []).filter(
    (row) => singaporeMonth(row.startTime) === month,
  );
  const events = (log?.events || []).filter(
    (event) => singaporeMonth(event.attemptedAt) === month,
  );
  const counts = (action, outcome) =>
    events.filter(
      (event) => event.action === action && event.outcome === outcome,
    ).length;
  return {
    month,
    byBookingMonth: {
      observedBookings: new Set(observations.map((row) => row.id)).size,
      lastObservedConfirmed: observations.filter((row) =>
        ["current", "history"].includes(tabValue(row.tab)),
      ).length,
      lastObservedZeroAmount: observations.filter(
        (row) => row.amount === 0 && row.price === 0,
      ).length,
    },
    byActionMonth: {
      bookingSuccess: counts("booking", "success"),
      bookingFailed: counts("booking", "failed"),
      bookingUncertain: counts("booking", "uncertain"),
      cancellationSuccess: counts("cancellation", "success"),
      cancellationFailed: counts("cancellation", "failed"),
      cancellationUncertain: counts("cancellation", "uncertain"),
    },
    startedAt: log?.startedAt || null,
    truncated: {
      observations: log?.truncated?.observations || 0,
      events: log?.truncated?.events || 0,
    },
  };
}
