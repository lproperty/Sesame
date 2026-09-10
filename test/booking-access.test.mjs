import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBookingAccessImages,
  normalizeBookingQrRefreshMs,
  loadBookingAccess,
} from "../lib/booking-access.mjs";
import { AppError } from "../lib/errors.mjs";

// Public synthetic 1x1 PNG, not a resident or facility access credential.
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n2kAAAAASUVORK5CYII=";
const apiOrigin = "https://estate.example.invalid";
const context = {
  token: "synthetic-session-token",
  unitId: "9876543210987654321",
  userType: 0,
};
const bookingId = "1234567890123456789";
const now = 1789050000000;
const badResponse = (error) =>
  error instanceof AppError && error.code === "UPSTREAM_RESPONSE";

test("preserves multiple server-issued PNG/estate image sources without encoding them", () => {
  const remote = `${apiOrigin}/access/code.png?value=opaque%2Bdata`;
  assert.deepEqual(normalizeBookingAccessImages([png, remote], { apiOrigin }), [
    { src: png, label: "Entry code 1" },
    { src: remote, label: "Entry code 2" },
  ]);
  assert.deepEqual(normalizeBookingAccessImages([], { apiOrigin }), []);
});

test("rejects malformed arrays and active, foreign or ambiguous image sources", () => {
  const invalid = [
    null,
    {},
    png,
    { data: [png] },
    [null],
    [123],
    [""],
    new Array(1),
    ["{id:123,unitId:456,timestamp:789}"],
    ["javascript:alert(1)"],
    ["data:text/html;base64,PHNjcmlwdD4="],
    ["data:image/svg+xml;base64,PHN2Zy8+"],
    ["data:image/png;base64,PHN2Zy8+"],
    ["data:image/png;base64,%%%"],
    [png.slice(0, -1)],
    [png.replace(/.$/, "A")],
    [`http://estate.example.invalid/qr.png`],
    [`${apiOrigin}.attacker.invalid/qr.png`],
    [`https://estate.example.invalid@attacker.invalid/qr.png`],
    [`https://name:password@estate.example.invalid/qr.png`],
    [`${apiOrigin}/qr.png#secret`],
    [`${apiOrigin}/qr.png\n`],
    [`${apiOrigin}/\"onerror=alert(1)`],
    [`${apiOrigin}\\@attacker.invalid/qr.png`],
    ["/qr.png"],
    ["//estate.example.invalid/qr.png"],
    [png, "https://attacker.invalid/qr.png"],
  ];
  for (const value of invalid)
    assert.throws(
      () => normalizeBookingAccessImages(value, { apiOrigin }),
      badResponse,
    );
});

test("bounds PNG dimensions, encoded sizes, total imagery and image count", () => {
  const bytes = Buffer.from(png.split(",")[1], "base64");
  bytes.writeUInt32BE(100_000, 16);
  assert.throws(
    () =>
      normalizeBookingAccessImages([
        "data:image/png;base64," + bytes.toString("base64"),
      ]),
    badResponse,
  );
  assert.throws(
    () => normalizeBookingAccessImages(Array(17).fill(png)),
    badResponse,
  );
  assert.throws(
    () =>
      normalizeBookingAccessImages([
        "data:image/png;base64," + "A".repeat(1_048_576),
      ]),
    badResponse,
  );
  assert.throws(
    () => normalizeBookingAccessImages([`${apiOrigin}/${"a".repeat(8192)}`]),
    badResponse,
  );
  // Preserve a bounded PNG envelope while padding a synthetic ancillary area;
  // the client bounds encoded imagery and leaves full raster decoding to <img>.
  const envelope = Buffer.from(png.split(",")[1], "base64");
  const large = Buffer.concat([
    envelope.subarray(0, -12),
    Buffer.alloc(700_000),
    envelope.subarray(-12),
  ]);
  const largeSource = "data:image/png;base64," + large.toString("base64");
  assert.throws(
    () => normalizeBookingAccessImages(Array(5).fill(largeSource)),
    badResponse,
  );
});

test("uses valid config 001 seconds and defaults malformed values to ten seconds", () => {
  for (const value of [1, 10, "10", 2.5, "2.5", 3600])
    assert.equal(normalizeBookingQrRefreshMs({ value }), Number(value) * 1000);
  for (const value of [
    undefined,
    null,
    "",
    " ",
    0,
    -1,
    0.001,
    3601,
    Infinity,
    NaN,
    true,
    {},
    "1e-9",
    "0x10",
  ])
    assert.equal(normalizeBookingQrRefreshMs({ value }), 10_000);
  assert.equal(normalizeBookingQrRefreshMs(null), 10_000);
});

test("loads exact config/booking requests using an immutable unit snapshot", async () => {
  const mutable = { ...context, ignoredPrivateField: "never-forward-this" };
  const calls = [];
  const result = await loadBookingAccess({
    context: mutable,
    bookingId,
    now: () => now,
    upstream: async (operation, body, headers) => {
      calls.push({ operation, body, headers: { ...headers } });
      if (operation === "qrConfig") {
        mutable.unitId = "changed-unit";
        headers.unitId = "mutated-by-upstream";
        return { value: 15 };
      }
      return [png];
    },
  });
  assert.deepEqual(calls, [
    { operation: "qrConfig", body: { code: "001" }, headers: context },
    {
      operation: "bookingQr",
      body: { unitId: context.unitId, bookingId },
      headers: context,
    },
  ]);
  assert.deepEqual(result, {
    images: [{ src: png, label: "Entry code 1" }],
    refreshMs: 15_000,
    updatedAt: now,
  });
  assert.equal(JSON.stringify(result).includes(context.token), false);
});

test("configuration outages default the interval while booking errors propagate", async () => {
  const calls = [];
  const result = await loadBookingAccess({
    context,
    bookingId,
    now,
    upstream: async (operation) => {
      calls.push(operation);
      if (operation === "qrConfig")
        throw new AppError("Unavailable", 502, "UPSTREAM_UNREACHABLE");
      return [];
    },
  });
  assert.deepEqual(calls, ["qrConfig", "bookingQr"]);
  assert.deepEqual(result, { images: [], refreshMs: 10_000, updatedAt: now });
  const rejected = new AppError(
    "Not available for this reservation",
    422,
    "ESTATE_REJECTED",
  );
  await assert.rejects(
    loadBookingAccess({
      context,
      bookingId,
      upstream: async (operation) => {
        if (operation === "qrConfig") return { value: 10 };
        throw rejected;
      },
    }),
    (error) => error === rejected,
  );
});

test("expiry stops before requesting codes and invalid identifiers never contact upstream", async () => {
  const expired = new AppError("Expired", 401, "SESSION_EXPIRED");
  const calls = [];
  await assert.rejects(
    loadBookingAccess({
      context,
      bookingId,
      upstream: async (op) => {
        calls.push(op);
        throw expired;
      },
    }),
    (error) => error === expired,
  );
  assert.deepEqual(calls, ["qrConfig"]);
  let count = 0;
  for (const options of [
    { context: { ...context, token: "" }, bookingId },
    { context, bookingId: 1234567890123456789 },
    { context: { ...context, unitId: "" }, bookingId },
  ])
    await assert.rejects(
      loadBookingAccess({
        ...options,
        upstream: async () => {
          count++;
        },
      }),
    );
  assert.equal(count, 0);
});
