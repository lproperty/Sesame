import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import jsQR from "jsqr";
import { createDemoUpstream } from "../lib/demo.mjs";
import { createDemoRequest } from "../pages/runtime.mjs";

const FIXED_NOW = Date.parse("2026-09-10T04:00:00Z");
const DAY = "2026-09-11";
const TENNIS = "demo-facility-6";
const UNIT = "demo-unit-1";
const credentials = { phoneOrEmail: "demo", cipher: "demo" };

function decodeDemoPng(src) {
  assert.match(src, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  const png = Buffer.from(src.split(",")[1], "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const compressed = [];
  let width;
  let height;
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8);
      assert.equal(data[9], 0);
    }
    if (type === "IDAT") compressed.push(data);
    offset += length + 12;
  }
  const grayscale = inflateSync(Buffer.concat(compressed));
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(grayscale[y * (width + 1)], 0);
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      pixels.fill(grayscale[y * (width + 1) + x + 1], index, index + 3);
      pixels[index + 3] = 255;
    }
  }
  return jsQR(pixels, width, height)?.data;
}

async function upstreamFixture() {
  const clock = { value: FIXED_NOW };
  const demo = createDemoUpstream({ now: () => clock.value });
  const login = await demo("login", credentials);
  const context = { token: login.token, unitId: UNIT };
  const reserve = async ({
    facilityId = TENNIS,
    slotIndex = 0,
    settle = true,
  } = {}) => {
    const [facility, slots] = await Promise.all([
      demo("facility", { id: facilityId }, context),
      demo("availability", { facilityId, dateTime: DAY }, context),
    ]);
    const slot = slots[slotIndex];
    const body = {
      facilityId,
      facilityDetailId: slot.id,
      unitId: UNIT,
      bookingNum: 1,
      orderDesc: `${DAY} ${slot.startTime}-${slot.endTime}`,
    };
    const { id } = await demo("insertBooking", body, context);
    const orderBody = {
      makeId: id,
      unitId: UNIT,
      projectId: "demo-project",
      orderSpeciesId: facilityId,
      orderType: 0,
      quantity: 1,
      price: facility.pricing * 100,
      transAmount: facility.pricing * 100,
    };
    const order = settle ? await demo("createOrder", orderBody, context) : null;
    return { id, slot, orderBody, orderNo: order?.data.orderNo };
  };
  return { demo, context, reserve, clock };
}

async function browserFixture() {
  const clock = { value: FIXED_NOW };
  const request = createDemoRequest({ now: () => clock.value });
  const post = (path, body) =>
    request(path, {
      method: "POST",
      headers: { "x-csrf-token": "demo-only" },
      body: JSON.stringify(body),
    });
  const read = async (path) => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const mutate = async (path, body) => {
    const response = await post(path, body);
    assert.equal(response.status, 200, path);
    return response.json();
  };
  await mutate("/api/login", credentials);
  const reserve = async ({ facilityId = TENNIS, slotIndex = 0 } = {}) => {
    const availability = await read(
      `/api/facilities/${facilityId}/availability?date=${DAY}`,
    );
    const slot = availability.slots[slotIndex];
    const preview = await mutate("/api/bookings/preview", {
      facilityId,
      slotId: slot.id,
      date: DAY,
      quantity: 1,
    });
    const receipt = await mutate("/api/bookings/commit", {
      previewId: preview.previewId,
      confirm: true,
    });
    return { slot, preview, receipt };
  };
  return { request, post, read, mutate, reserve, clock };
}

test("loopback demo auto-confirms free tennis, emits only a nonfunctional QR, and releases only the cancelled slot", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Demo must stay offline"),
  );
  const f = await upstreamFixture();
  const facility = await f.demo("facility", { id: TENNIS }, f.context);
  assert.equal(f.demo.facilities.length, 11);
  assert.match(facility.name, /Tennis.*Off-Peak/);
  assert.equal(facility.pricing, 0);
  assert.equal(facility.perOrderNum, 8);
  assert.equal(facility.openTimeRange.split(",").length, 11);
  assert.match(facility.openTimeRange, /^08:00-09:00,.*18:00-19:00$/);

  const first = await f.reserve({ settle: false });
  await assert.rejects(
    f.demo("bookingQr", { unitId: UNIT, bookingId: first.id }, f.context),
    { code: "BOOKING_QR_UNAVAILABLE" },
  );
  const orderResponse = await f.demo("createOrder", first.orderBody, f.context);
  const order = f.demo.orders.get(orderResponse.data.orderNo);
  for (const field of ["price", "transAmount", "tipsAmount"])
    assert.equal(order[field], 0);
  assert.equal(order.unitId, UNIT);
  assert.equal(order.projectId, "demo-project");
  assert.equal(order.makeId, first.id);
  assert.equal(order.status, 2);
  const second = await f.reserve({ slotIndex: 1 });
  const current = await f.demo("bookings", { status: 1, type: 0 }, f.context);
  assert.equal(current.length, 2);
  assert.ok(current.every((booking) => booking.gmtCreate));
  assert.deepEqual(await f.demo("bookings", { status: 0 }, f.context), []);
  assert.deepEqual(await f.demo("qrConfig", { code: "001" }, f.context), {
    value: 10,
  });
  const images = await f.demo(
    "bookingQr",
    { unitId: UNIT, bookingId: first.id },
    f.context,
  );
  assert.equal(images.length, 1);
  assert.equal(
    decodeDemoPng(images[0]),
    "DEMO ONLY - NOT VALID FOR FACILITY ENTRY",
  );

  await f.demo("cancelBooking", { id: first.id }, f.context);
  assert.equal(order.status, 2, "Settled zero-value orders remain in history");
  assert.deepEqual(
    (await f.demo("bookings", { status: 1, type: 0 }, f.context)).map(
      (booking) => booking.id,
    ),
    [second.id],
  );
  const slots = await f.demo(
    "availability",
    { facilityId: TENNIS, dateTime: DAY },
    f.context,
  );
  assert.equal(slots[0].remainingNum, 1);
  assert.equal(slots[1].remainingNum, 0);
  await assert.rejects(
    f.demo("bookingQr", { unitId: UNIT, bookingId: first.id }, f.context),
    { code: "BOOKING_NOT_FOUND" },
  );
});

test("loopback QR rejects missing, cross-unit and expired bookings, while paid confirmations remain non-cancellable", async () => {
  const f = await upstreamFixture();
  const free = await f.reserve();
  for (const [body, context] of [
    [{ unitId: UNIT, bookingId: "missing" }, f.context],
    [{ unitId: "demo-unit-2", bookingId: free.id }, f.context],
    [
      { unitId: "demo-unit-2", bookingId: free.id },
      { ...f.context, unitId: "demo-unit-2" },
    ],
  ])
    await assert.rejects(f.demo("bookingQr", body, context), {
      code: "BOOKING_NOT_FOUND",
    });
  const paid = await f.reserve({ facilityId: "demo-facility-1" });
  assert.equal(f.demo.orders.get(paid.orderNo).status, 1);
  const booking = f.demo.bookings.find((record) => record.id === paid.id);
  booking.status = 1;
  f.demo.orders.get(paid.orderNo).status = 2;
  assert.equal(
    (await f.demo("bookingQr", { unitId: UNIT, bookingId: paid.id }, f.context))
      .length,
    1,
  );
  await assert.rejects(f.demo("cancelBooking", { id: paid.id }, f.context), {
    code: "ESTATE_REJECTED",
  });
  assert.ok(f.demo.bookings.includes(booking));

  f.clock.value = Date.parse(`${DAY}T09:00:00+08:00`);
  await assert.rejects(
    f.demo("bookingQr", { unitId: UNIT, bookingId: free.id }, f.context),
    { code: "BOOKING_QR_UNAVAILABLE" },
  );
  assert.equal(
    (await f.demo("bookings", { status: 1, type: 1 }, f.context))[0].id,
    free.id,
  );
  await f.demo("cancelBooking", { id: free.id }, f.context);
  assert.deepEqual(await f.demo("bookings", { status: 1, type: 1 }, f.context), []);
  assert.equal(f.demo.orders.get(free.orderNo).status, 2);
  assert.ok(f.demo.bookings.includes(booking), "The paid booking is preserved");
});

test("browser demo confirms free tennis, scopes its QR and cancellation, and permits a new reservation after release", async (t) => {
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("Demo must stay offline"),
  );
  const f = await browserFixture();
  const first = await f.reserve();
  const second = await f.reserve({ slotIndex: 1 });
  assert.equal(first.preview.amount, 0);
  assert.equal(first.receipt.status, "confirmed_free");
  assert.match(first.receipt.message, /confirmed.*No payment/);
  assert.equal((await f.read("/api/bookings?tab=current")).length, 2);
  assert.deepEqual(await f.read("/api/bookings?tab=unpaid"), []);
  const payment = await f.read(
    `/api/bookings/${first.receipt.bookingId}/payment`,
  );
  assert.equal(payment.status, "free");
  assert.equal(payment.canCancel, true);
  assert.equal(payment.booking.tab, "current");
  assert.deepEqual(await f.read(`/api/payments/${first.preview.previewId}`), {
    status: "free",
  });
  const qrPath = `/api/bookings/${first.receipt.bookingId}/qr`;
  const qr = await f.read(qrPath);
  assert.equal(qr.booking.id, first.receipt.bookingId);
  assert.equal(qr.booking.unit.unitId, UNIT);
  assert.equal(qr.refreshMs, 10_000);
  assert.equal(qr.updatedAt, FIXED_NOW);
  assert.match(qr.images[0].label, /Demo.*not valid for entry/);
  assert.equal(
    decodeDemoPng(qr.images[0].src),
    "DEMO ONLY - NOT VALID FOR FACILITY ENTRY",
  );

  await f.mutate("/api/unit", { unitId: "demo-unit-2" });
  assert.equal((await f.request(qrPath)).status, 404);
  assert.equal(
    (
      await f.post(`/api/bookings/${first.receipt.bookingId}/cancel`, {
        confirm: true,
      })
    ).status,
    404,
  );
  await f.mutate("/api/unit", { unitId: UNIT });
  assert.equal(
    (await f.post(`/api/bookings/${first.receipt.bookingId}/cancel`, {}))
      .status,
    400,
  );
  assert.equal((await f.read("/api/bookings?tab=current")).length, 2);
  assert.deepEqual(
    await f.mutate(`/api/bookings/${first.receipt.bookingId}/cancel`, {
      confirm: true,
    }),
    { status: "cancelled", bookingId: first.receipt.bookingId },
  );
  assert.equal((await f.request(qrPath)).status, 404);
  const remaining = await f.read("/api/bookings?tab=current");
  assert.deepEqual(
    remaining.map((booking) => booking.id),
    [second.receipt.bookingId],
  );
  const slots = (
    await f.read(`/api/facilities/${TENNIS}/availability?date=${DAY}`)
  ).slots;
  assert.equal(slots[0].enabled, true);
  assert.equal(slots[1].enabled, false);
  const replacement = await f.reserve();
  assert.notEqual(replacement.receipt.bookingId, first.receipt.bookingId);
  assert.notEqual(replacement.receipt.orderNo, first.receipt.orderNo);
});

test("browser demo preserves paid pending cancellation and refuses QR access without a current confirmation", async () => {
  const f = await browserFixture();
  const paid = await f.reserve({ facilityId: "demo-facility-1" });
  assert.equal(paid.receipt.status, "payment_pending");
  assert.ok(paid.preview.amount > 0);
  const payment = await f.read(
    `/api/bookings/${paid.receipt.bookingId}/payment`,
  );
  assert.equal(payment.status, "pending");
  assert.equal(payment.canCancel, true);
  assert.equal(payment.booking.tab, "unpaid");
  assert.equal(
    (await f.request(`/api/bookings/${paid.receipt.bookingId}/qr`)).status,
    409,
  );
  await f.mutate(`/api/bookings/${paid.receipt.bookingId}/cancel`, {
    confirm: true,
  });
  assert.deepEqual(await f.read("/api/bookings?tab=unpaid"), []);

  const free = await f.reserve();
  f.clock.value = Date.parse(`${DAY}T08:00:00+08:00`);
  assert.equal(
    (await f.read(`/api/bookings/${free.receipt.bookingId}/payment`)).canCancel,
    false,
  );
  assert.equal(
    (
      await f.post(`/api/bookings/${free.receipt.bookingId}/cancel`, {
        confirm: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.request(`/api/bookings/${free.receipt.bookingId}/qr`)).status,
    200,
  );
  f.clock.value = Date.parse(`${DAY}T09:00:00+08:00`);
  assert.equal(
    (await f.request(`/api/bookings/${free.receipt.bookingId}/qr`)).status,
    409,
  );
  assert.deepEqual(await f.read("/api/bookings?tab=current"), []);
  assert.equal(
    (await f.read("/api/bookings?tab=history"))[0].id,
    free.receipt.bookingId,
  );
  assert.equal(
    (await f.post(`/api/bookings/${free.receipt.bookingId}/cancel`, {})).status,
    400,
  );
  assert.deepEqual(
    await f.mutate(`/api/bookings/${free.receipt.bookingId}/cancel`, { confirm: true }),
    { status: "cancelled", bookingId: free.receipt.bookingId },
  );
  assert.deepEqual(await f.read("/api/bookings?tab=history"), []);
  assert.equal((await f.request(`/api/bookings/${free.receipt.bookingId}/qr`)).status, 404);
});
