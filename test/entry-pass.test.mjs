import test from "node:test";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { IDBFactory } from "fake-indexeddb";
import {
  createEntryQr,
  entryPayload,
  entryPassFromSession,
} from "../public/entry-pass.js";
import { createPassStore, PASS_DATABASE } from "../public/pass-store.js";
import { createPaymentQr } from "../public/payment-qr.js";

const unit = {
  unitId: "9876543210987654321",
  projectId: "1111111111111111111",
  userType: 0,
  unitName: "Example unit",
  buildingName: "Example block",
  projectName: "Example estate",
};
const session = { user: { id: "1234567890123456789" }, units: [unit], unit };
const pass = entryPassFromSession(session);
const now = 1788624000000;

function decodeSvg(svg) {
  const size = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  // Rasterize the actual SVG's square paths, then decode it with an independent
  // QR implementation. This verifies encoded bytes and the four-module border.
  for (const match of svg.matchAll(/M(\d+),(\d+)l(\d+),0 0,(\d+)/g)) {
    const [, x, y, width, height] = match.map(Number);
    for (let row = y; row < y + height; row++)
      for (let col = x; col < x + width; col++) {
        const offset = (row * size + col) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
  }
  return jsQR(pixels, size, size, { inversionAttempts: "dontInvert" });
}

test("payment QR encodes the deployment payload exactly without rendering its text as HTML", () => {
  const text = "SAMPLE-PAYMENT-ONLY <script>alert(1)</script> & merchant";
  const svg = createPaymentQr(text);
  assert.equal(decodeSvg(svg).data, text);
  assert.equal(svg.includes("<script>"), false);
});

test("entry QR decodes to the native resident payload without losing 19-digit IDs", () => {
  const expected =
    "{id:1234567890123456789,unitId:9876543210987654321,timestamp:1788624000000}";
  assert.equal(entryPayload(pass, now), expected);
  const first = createEntryQr(pass, now);
  const refreshed = createEntryQr(pass, now + 10_000);
  assert.equal(decodeSvg(first.svg).data, expected);
  assert.equal(
    decodeSvg(refreshed.svg).data,
    expected.replace("1788624000000", "1788624010000"),
  );
  assert.notEqual(first.svg, refreshed.svg);
  assert.equal(first.svg.includes(pass.ownerId), false);
  assert.throws(() =>
    entryPayload({ ...pass, ownerId: "bad},unitId:other" }, now),
  );
  assert.throws(() => entryPayload(pass, NaN));
});

test("entry identity must belong to the signed-in activated owner associations", () => {
  assert.throws(() =>
    entryPassFromSession({
      ...session,
      unit: { ...unit, unitId: "foreign-unit" },
    }),
  );
  assert.throws(() =>
    entryPassFromSession({ ...session, units: [{ ...unit, userType: 1 }] }),
  );
  assert.throws(() => entryPassFromSession(null));
  const clean = entryPassFromSession({
    ...session,
    token: "private-token",
    cipher: "private-password",
    user: { ...session.user, email: "private@example.com" },
  });
  assert.equal(JSON.stringify(clean).includes("private"), false);
});

async function raw(database, change) {
  const db = await new Promise((resolve, reject) => {
    const request = database.open(PASS_DATABASE, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        "entry",
        change ? "readwrite" : "readonly",
      );
      const store = transaction.objectStore("entry");
      const request = change
        ? store.put(change, "active")
        : store.get("active");
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

test("saved pass is encrypted with a non-extractable key, restores after reopening, and never contains login secrets", async () => {
  const database = new IDBFactory();
  const store = createPassStore({ indexedDB: database, now: () => now });
  assert.equal(await store.load(), null);
  await store.save({
    ...pass,
    token: "private-token",
    password: "private-password",
  });
  const record = await raw(database);
  assert.equal(record.key.extractable, false);
  assert.equal(record.key.algorithm.name, "AES-GCM");
  await assert.rejects(crypto.subtle.exportKey("raw", record.key));
  assert.equal(JSON.stringify(record).includes(pass.ownerId), false);
  const reopened = await createPassStore({
    indexedDB: database,
    now: () => now,
  }).load();
  assert.deepEqual(reopened.pass, pass);
  assert.equal(reopened.expiresAt, undefined);
  assert.equal(JSON.stringify(reopened).includes("private"), false);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("tampered saved passes are rejected and removed", async () => {
  const database = new IDBFactory();
  const store = createPassStore({ indexedDB: database });
  await store.save(pass);
  const record = await raw(database);
  const bytes = new Uint8Array(record.ciphertext.slice(0));
  bytes[0] ^= 1;
  await raw(database, { ...record, ciphertext: bytes.buffer });
  assert.equal(await store.load(), null);
  assert.equal(await raw(database), undefined);
});

test("forget queued during encryption removes the completed save instead of allowing it to reappear", async () => {
  const store = createPassStore({
    indexedDB: new IDBFactory(),
    now: () => now,
  });
  const save = store.save(pass);
  const forget = store.clear();
  await Promise.all([save, forget]);
  assert.equal(await store.load(), null);
});

test("existing seven-day passes remain usable without renewal", async () => {
  const database = new IDBFactory();
  const store = createPassStore({ indexedDB: database });
  await store.save(pass);
  const record = await raw(database);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, pass, createdAt: 1, expiresAt: 604800001 }),
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(
        "Sesame resident entry pass, version 1",
      ),
    },
    record.key,
    bytes,
  );
  await raw(database, { ...record, iv, ciphertext });
  assert.deepEqual((await store.load()).pass, pass);
  assert.equal((await store.load()).expiresAt, undefined);
});
