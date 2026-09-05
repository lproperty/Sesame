import { normalizeEntryPass, ENTRY_PASS_TTL_MS } from "./entry-pass.js";

export const PASS_DATABASE = "sesame-entry-pass-v1";
const STORE = "entry";
const RECORD = "active";
const binding = new TextEncoder().encode(
  "Sesame resident entry pass, version 1",
);

// Persistence is opt-in. AES-GCM and its non-extractable key stay in this
// browser's IndexedDB. This protects stored bytes, not an unlocked browser or
// compromised same-origin JavaScript; the UI explains the device-access tradeoff.
export function createPassStore({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  now = Date.now,
} = {}) {
  let pending = Promise.resolve();
  const available = Boolean(indexedDB && crypto?.subtle);
  const open = () =>
    new Promise((resolve, reject) => {
      if (!available)
        return reject(
          new Error("This browser cannot save an entry pass securely."),
        );
      const request = indexedDB.open(PASS_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onerror = () =>
        reject(new Error("The saved pass could not be opened."));
      request.onblocked = () =>
        reject(new Error("Close other Sesame tabs and try again."));
      request.onsuccess = () => resolve(request.result);
    });
  const transact = async (mode, action) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = action(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = transaction.onabort = () =>
          reject(new Error("The saved pass could not be updated."));
      });
    } finally {
      db.close();
    }
  };
  // A sign-out/forget queued during encryption must run after that save, so a
  // late encryption result cannot put a forgotten pass back on the device.
  const serial = (operation) => {
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const remove = () =>
    available
      ? transact("readwrite", (store) => store.delete(RECORD))
      : Promise.resolve();
  return {
    available,
    save: (input) =>
      serial(async () => {
        const pass = normalizeEntryPass(input);
        const createdAt = now();
        const expiresAt = createdAt + ENTRY_PASS_TTL_MS;
        const key = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const bytes = new TextEncoder().encode(
          JSON.stringify({ version: 1, pass, createdAt, expiresAt }),
        );
        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: binding },
          key,
          bytes,
        );
        await transact("readwrite", (store) =>
          store.put({ version: 1, key, iv, ciphertext }, RECORD),
        );
        return { pass, expiresAt };
      }),
    load: () =>
      serial(async () => {
        if (!available) return null;
        const record = await transact("readonly", (store) => store.get(RECORD));
        if (!record) return null;
        try {
          if (
            record.version !== 1 ||
            record.key?.extractable !== false ||
            record.key?.algorithm?.name !== "AES-GCM" ||
            record.iv?.byteLength !== 12 ||
            !record.ciphertext?.byteLength ||
            record.ciphertext.byteLength > 16_384
          )
            throw new Error("Invalid saved pass.");
          const bytes = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: record.iv, additionalData: binding },
            record.key,
            record.ciphertext,
          );
          const value = JSON.parse(new TextDecoder().decode(bytes));
          if (
            value.version !== 1 ||
            !Number.isSafeInteger(value.createdAt) ||
            value.createdAt > now() + 60_000 ||
            value.expiresAt !== value.createdAt + ENTRY_PASS_TTL_MS ||
            value.expiresAt <= now()
          )
            throw new Error("Saved pass expired.");
          return {
            pass: normalizeEntryPass(value.pass),
            expiresAt: value.expiresAt,
          };
        } catch {
          await remove();
          return null;
        }
      }),
    clear: () => serial(remove),
  };
}
