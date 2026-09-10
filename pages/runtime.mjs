import {
  createDemoUpstream,
  demoBookingQr,
  demoBookingTab,
  demoCanCancelBooking,
} from "../lib/demo.mjs";
import { AppError } from "../lib/errors.mjs";
import {
  bookingWindow,
  validateDate,
  normalizeUnit,
  normalizeFacility,
  normalizeSlot,
  normalizeBooking,
  QUOTE_TTL_MS,
} from "../lib/model.mjs";

// An isolated, disposable simulation. There is deliberately no network client,
// cookie, browser storage, real credential or configurable API origin here.
export function createDemoRequest({ now = Date.now } = {}) {
  const seed = createDemoUpstream({ now });
  const units = seed.units.map(normalizeUnit);
  const bookings = seed.bookings;
  const orders = seed.orders;
  const reviews = new Map();
  let unit = units[0];
  let signedIn = false;
  const configuration = () => ({
    ...bookingWindow(now()),
    demo: true,
    staticDemo: true,
    readOnly: false,
  });
  const session = () => ({
    ...configuration(),
    units,
    unit,
    csrfToken: "demo-only",
    user: {
      id: "demo-owner",
      name: "Alex",
      email: "alex@example.com",
      phone: "",
      needsEmail: false,
      needsPasswordChange: false,
    },
  });
  const facility = (id) => {
    const value = seed.facilities.find((f) => f.id === id);
    if (!value) throw new AppError("Demo facility not found.", 404);
    return { ...normalizeFacility(value), notice: { show: false, text: "" } };
  };
  const availability = (id, date) => {
    validateDate(date, now());
    const selected = facility(id);
    return {
      ...bookingWindow(now()),
      date,
      checkedAt: new Date(now()).toISOString(),
      slots: selected.openingHours.split(",").map((time, index) => {
        const slotId = `${id}-${date}-${index}`;
        const [startTime, endTime] = time.split("-");
        const occupied = bookings.some((b) => b.facilityDetailId === slotId);
        return normalizeSlot(
          {
            id: slotId,
            facilityId: id,
            date,
            startTime,
            endTime,
            pricing: selected.indicativePrice / 100,
            num: 1,
            status: 1,
            ordered: occupied ? 1 : 0,
            remainingNum: occupied ? 0 : 1,
            reservation: true,
          },
          selected,
          now(),
        );
      }),
    };
  };
  const reviewBooking = (body) => {
    const selected = facility(body.facilityId);
    const slot = availability(selected.id, body.date).slots.find(
      (s) => s.id === body.slotId,
    );
    if (!slot?.enabled)
      throw new AppError(
        "Choose an available demonstration time.",
        409,
        "SLOT_UNAVAILABLE",
      );
    if (body.quantity !== 1)
      throw new AppError("This demonstration allows one session at a time.");
    if (reviews.size >= 100)
      throw new AppError("Refresh to start a new demonstration.", 429);
    const preview = {
      previewId: crypto.randomUUID(),
      unit: { ...unit },
      facility: { id: selected.id, name: selected.name, image: selected.image },
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      quantity: 1,
      unitPrice: slot.price,
      amount: slot.price,
      paymentMethod:
        slot.price === 0
          ? "No payment required"
          : "Simulated payment — no money is collected",
      expiresAt: new Date(now() + QUOTE_TTL_MS).toISOString(),
    };
    reviews.set(preview.previewId, { preview, slotId: slot.id, result: null });
    return preview;
  };
  const commitBooking = (body) => {
    if (body.confirm !== true)
      throw new AppError("Confirm the demo booking to continue.");
    const review = reviews.get(body.previewId);
    if (!review || review.preview.unit.unitId !== unit.unitId)
      throw new AppError(
        "Review a booking for your selected demo unit.",
        409,
        "PREVIEW_CHANGED",
      );
    if (review.result) return review.result;
    const preview = review.preview;
    if (Date.parse(preview.expiresAt) <= now())
      throw new AppError(
        "Review expired. Choose a time again.",
        409,
        "PREVIEW_EXPIRED",
      );
    if (
      !availability(preview.facility.id, preview.date).slots.find(
        (s) => s.id === review.slotId,
      )?.enabled
    )
      throw new AppError(
        "This demo time has already been reserved.",
        409,
        "SLOT_UNAVAILABLE",
      );
    const bookingId = "demo-booking-" + crypto.randomUUID();
    const orderNo = "DEMO-" + String(orders.size + 1).padStart(5, "0");
    const free = preview.amount === 0;
    review.result = {
      ...preview,
      bookingId,
      orderNo,
      status: free ? "confirmed_free" : "payment_pending",
      message: free
        ? "Your free demo booking is confirmed. No payment is needed."
        : "Simulated booking only. No payment is needed.",
    };
    bookings.push({
      id: bookingId,
      facilityId: preview.facility.id,
      facilityName: preview.facility.name,
      facilityDetailId: review.slotId,
      unitId: unit.unitId,
      projectId: unit.projectId,
      bookingNum: 1,
      startTime: `${preview.date} ${preview.startTime}:00`,
      endTime: `${preview.date} ${preview.endTime}:00`,
      paidTotal: preview.amount / 100,
      pricing: preview.unitPrice / 100,
      status: free ? 1 : 0,
      orderNo,
      gmtCreate: new Date(now()).toISOString(),
      gmtModified: new Date(now()).toISOString(),
      receipt: review.result,
    });
    orders.set(orderNo, {
      requestNo: orderNo,
      makeId: bookingId,
      unitId: unit.unitId,
      projectId: unit.projectId,
      orderType: 0,
      status: free ? 2 : 1,
      price: preview.unitPrice,
      quantity: 1,
      transAmount: preview.amount,
      tipsAmount: 0,
      gmtCreate: new Date(now()).toISOString(),
      gmtModified: new Date(now()).toISOString(),
    });
    return review.result;
  };
  const bookingView = (booking) => ({
    ...normalizeBooking(booking, demoBookingTab(booking, now())),
    unit: { ...unit },
    receipt: booking.receipt,
  });
  const handle = (path, init) => {
    const url = new URL(path, "https://demo.invalid");
    if (
      url.origin !== "https://demo.invalid" ||
      !url.pathname.startsWith("/api/")
    )
      throw new AppError(
        "This demo does not make network requests.",
        403,
        "DEMO_ONLY",
      );
    const method = init.method || "GET";
    if (!["GET", "POST"].includes(method))
      throw new AppError("Method not allowed.", 405);
    let body = {};
    if (method === "POST") {
      if (typeof init.body !== "string" || init.body.length > 16_384)
        throw new AppError("Invalid demo request.");
      try {
        body = JSON.parse(init.body);
      } catch {
        throw new AppError("Invalid JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new AppError("Expected a JSON object.");
    }
    const route = `${method} ${url.pathname}`;
    if (route === "GET /api/config") return configuration();
    if (route === "POST /api/login") {
      if (body.phoneOrEmail !== "demo" || body.cipher !== "demo")
        throw new AppError(
          "Real account sign-in is unavailable on this demonstration.",
          403,
          "DEMO_ONLY",
        );
      signedIn = true;
      return session();
    }
    if (!signedIn)
      throw new AppError("Open the demo to continue.", 401, "SIGN_IN_REQUIRED");
    if (route === "GET /api/session") return session();
    if (
      method === "POST" &&
      new Headers(init.headers).get("x-csrf-token") !== "demo-only"
    )
      throw new AppError("Refresh the demonstration and try again.", 403);
    if (route === "POST /api/logout") {
      signedIn = false;
      reviews.clear();
      bookings.length = 0;
      orders.clear();
      unit = units[0];
      return { signedOut: true };
    }
    if (route === "POST /api/unit") {
      const next = units.find((u) => u.unitId === body.unitId);
      if (!next) throw new AppError("Choose a demonstration unit.", 403);
      unit = next;
      return session();
    }
    if (route === "GET /api/facilities")
      return seed.facilities.map(normalizeFacility);
    const facilityMatch =
      /^\/api\/facilities\/([a-zA-Z0-9_-]+)(\/availability)?$/.exec(
        url.pathname,
      );
    if (method === "GET" && facilityMatch)
      return facilityMatch[2]
        ? availability(facilityMatch[1], url.searchParams.get("date"))
        : facility(facilityMatch[1]);
    if (route === "POST /api/bookings") {
      if (body.confirm !== true)
        throw new AppError("Use the Book button to submit a reservation.");
      const previous = [...reviews.values()].find(
        (review) =>
          review.result &&
          review.preview.unit.unitId === unit.unitId &&
          review.slotId === body.slotId,
      );
      if (previous) return previous.result;
      const checked = reviewBooking(body);
      if (
        checked.amount !== body.expectedAmount ||
        checked.unit.unitId !== body.expectedUnitId ||
        checked.startTime !== body.expectedStartTime ||
        checked.endTime !== body.expectedEndTime
      )
        throw new AppError(
          "The price, time or selected unit changed. Select a time again.",
          409,
          "BOOKING_CHANGED",
        );
      return commitBooking({ previewId: checked.previewId, confirm: true });
    }
    if (route === "POST /api/bookings/preview") return reviewBooking(body);
    if (route === "POST /api/bookings/commit") return commitBooking(body);
    const reservation =
      /^\/api\/bookings\/([a-zA-Z0-9_-]+)\/(payment|cancel|qr)$/.exec(
        url.pathname,
      );
    if (
      reservation &&
      ((method === "GET" && ["payment", "qr"].includes(reservation[2])) ||
        (method === "POST" && ["payment", "cancel"].includes(reservation[2])))
    ) {
      const booking = bookings.find(
        (b) => b.id === reservation[1] && b.unitId === unit.unitId,
      );
      if (!booking)
        throw new AppError("Demo booking not found.", 404, "BOOKING_NOT_FOUND");
      if (reservation[2] === "qr")
        return {
          booking: bookingView(booking),
          images: demoBookingQr(booking, unit.unitId, now()).map((src) => ({
            src,
            label: "Demo facility QR — not valid for entry",
          })),
          refreshMs: 10_000,
          updatedAt: now(),
        };
      if (method === "POST" && body.confirm !== true)
        throw new AppError(
          "Confirm this reservation action.",
          400,
          "CONFIRMATION_REQUIRED",
        );
      if (reservation[2] === "cancel") {
        if (!demoCanCancelBooking(booking, orders.get(booking.orderNo), now()))
          throw new AppError(
            "Only pending reservations and future confirmed free tennis bookings can be cancelled in this demo.",
            409,
            "BOOKING_NOT_PENDING",
          );
        bookings.splice(bookings.indexOf(booking), 1);
        const order = orders.get(booking.orderNo);
        if (order && Number(order.status) !== 2) order.status = 4;
        for (const [id, review] of reviews)
          if (review.result?.bookingId === booking.id) reviews.delete(id);
        return { status: "cancelled", bookingId: booking.id };
      }
      return {
        booking: bookingView(booking),
        orderNo: booking.orderNo,
        status:
          demoBookingTab(booking, now()) === "history"
            ? "expired"
            : Number(orders.get(booking.orderNo)?.status) === 2
              ? booking.paidTotal === 0
                ? "free"
                : "paid"
              : "pending",
        canCancel: demoCanCancelBooking(
          booking,
          orders.get(booking.orderNo),
          now(),
        ),
      };
    }
    if (route === "GET /api/bookings") {
      const tab = url.searchParams.get("tab") || "current";
      if (!["current", "history", "unpaid"].includes(tab))
        throw new AppError("Unknown booking list.");
      return bookings
        .filter(
          (b) => b.unitId === unit.unitId && demoBookingTab(b, now()) === tab,
        )
        .map(bookingView);
    }
    const paymentMatch = /^\/api\/payments\/([a-zA-Z0-9_-]+)$/.exec(
      url.pathname,
    );
    if (method === "GET" && paymentMatch) {
      const review = reviews.get(paymentMatch[1]);
      if (!review?.result || review.preview.unit.unitId !== unit.unitId)
        throw new AppError("Demo booking not found.", 404);
      return {
        status: review.result.status === "confirmed_free" ? "free" : "pending",
      };
    }
    throw new AppError(
      "This action is unavailable in the demonstration.",
      403,
      "DEMO_ONLY",
    );
  };
  return async (path, init = {}) => {
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    try {
      return json(handle(path, init));
    } catch (error) {
      return json(
        {
          error: {
            message:
              error instanceof AppError
                ? error.message
                : "Unable to run this demonstration.",
            code: error instanceof AppError ? error.code : "DEMO_ERROR",
          },
        },
        error instanceof AppError ? error.status : 500,
      );
    }
  };
}
