import { AppError } from "./errors.mjs";
import { SITE_CONFIG } from "./config.mjs";
import {
  QUOTE_TTL_MS,
  bookingWindow,
  validateDate,
  identifier,
  requiredString,
  normalizeUnit,
  normalizeFacility,
  normalizeSlot,
  normalizeBooking,
} from "./model.mjs";

const sameUnit = (a, b) => a.unitId === b.unitId && a.projectId === b.projectId;
// These keys compare normalized values inside Maps; they are not credentials
// or signatures. Exact JSON comparison works identically in Node and Safari.
const comparisonKey = (value) => JSON.stringify(value);
const randomSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const array = (value) => {
  if (!Array.isArray(value))
    throw new AppError(
      "The estate service returned an unexpected list.",
      502,
      "UPSTREAM_RESPONSE",
    );
  return value;
};

export class OwnerPortal {
  constructor({
    upstream,
    readOnly = false,
    demo = false,
    now = Date.now,
    payment = SITE_CONFIG.payment,
  }) {
    this.upstream = upstream;
    this.readOnly = readOnly;
    this.demo = demo;
    this.now = now;
    this.payment = demo ? null : payment;
    this.actions = new Map();
    this.reservationActions = new Map();
    this.reservationOrders = new Map();
  }

  context(session, unit = session.unit) {
    if (!unit)
      throw new AppError(
        "No active owner unit is associated with this login.",
        403,
        "NO_OWNER_UNIT",
      );
    return { token: session.token, ...unit };
  }

  configuration() {
    return {
      readOnly: this.readOnly,
      demo: this.demo,
      payment: this.payment,
      ...bookingWindow(this.now()),
    };
  }

  sessionView(session) {
    return {
      user: session.user,
      units: session.units,
      unit: session.unit,
      csrfToken: session.csrf,
      ...this.configuration(),
    };
  }

  async login(body) {
    const phoneOrEmail = requiredString(
      body.phoneOrEmail,
      "email, phone number or username",
    );
    // Passwords are not trimmed: spaces may be intentional.
    if (
      typeof body.cipher !== "string" ||
      !body.cipher ||
      body.cipher.length > 300
    ) {
      throw new AppError("Enter your password.");
    }
    const result = await this.upstream("login", {
      phoneOrEmail,
      cipher: body.cipher,
      identity: "Owner",
      type: 0,
      api: "",
    });
    if (
      typeof result.token !== "string" ||
      !result.token ||
      !result.ownerLoginOutDTO?.id
    ) {
      throw new AppError(
        "An owner session was not returned. Check your login details.",
        401,
        "LOGIN_FAILED",
      );
    }
    const owner = result.ownerLoginOutDTO;
    const listed = array(
      await this.upstream(
        "units",
        {
          userId: owner.id,
          activation: 1,
          status: 0,
        },
        { token: result.token, userType: 0 },
      ),
    );
    const units = listed
      .filter(
        (u) =>
          Number(u.userType) === 0 &&
          Number(u.activation) === 1 &&
          Number(u.status) === 0,
      )
      .map(normalizeUnit);
    return {
      token: result.token,
      user: {
        id: identifier(owner.id, "owner"),
        name: String(owner.username || "Resident"),
      },
      units,
      unit: units[0] ?? null,
      csrf: randomSecret(),
      quotes: new Map(),
      facilities: new Map(),
    };
  }

  assertWritable() {
    if (this.readOnly)
      throw new AppError(
        "This server is in read-only mode. Submissions are disabled.",
        403,
        "READ_ONLY",
      );
  }

  scope(session, unit = session.unit) {
    return comparisonKey([session.user.id, unit?.unitId]);
  }

  switchUnit(session, unitId) {
    const action = this.actions.get(this.scope(session));
    if (
      action?.processing ||
      [...this.reservationActions.values()].some(
        (pending) => pending.scope === this.scope(session),
      )
    )
      throw new AppError(
        "Wait for the booking submission to finish before changing units.",
        409,
        "BOOKING_IN_PROGRESS",
      );
    const unit = session.units.find(
      (u) => u.unitId === identifier(unitId, "unit"),
    );
    if (!unit)
      throw new AppError(
        "This unit is not in your activated owner associations.",
        403,
        "UNIT_NOT_ALLOWED",
      );
    session.unit = unit;
    for (const [key, quote] of session.quotes)
      if (!quote.attempted) session.quotes.delete(key);
    return this.sessionView(session);
  }

  async facilities(session, { fresh = false, unit = session.unit } = {}) {
    const context = this.context(session, unit);
    const cached = session.facilities.get(unit.projectId);
    if (!fresh && cached && this.now() - cached.at < 60_000) return cached.data;
    const result = array(
      await this.upstream(
        "facilities",
        { projectId: unit.projectId, status: 1 },
        context,
      ),
    );
    const data = result
      .filter(
        (f) =>
          Number(f.status) === 1 &&
          Number(f.isDelete || 0) !== 1 &&
          (f.projectId == null || String(f.projectId) === unit.projectId),
      )
      .map(normalizeFacility);
    session.facilities.set(unit.projectId, { at: this.now(), data });
    return data;
  }

  async allowedFacility(
    session,
    id,
    { fresh = false, unit = session.unit } = {},
  ) {
    const facilityId = identifier(id, "facility");
    const facilities = await this.facilities(session, { fresh, unit });
    const facility = facilities.find((f) => f.id === facilityId);
    if (!facility)
      throw new AppError(
        "This facility is not available for your property.",
        404,
        "FACILITY_NOT_FOUND",
      );
    return facility;
  }

  async facility(session, id, { unit = session.unit, fresh = false } = {}) {
    await this.allowedFacility(session, id, { unit, fresh });
    const context = this.context(session, unit);
    const raw = await this.upstream("facility", { id }, context);
    if (
      String(raw.id) !== id ||
      Number(raw.status) !== 1 ||
      (raw.projectId != null && String(raw.projectId) !== unit.projectId)
    ) {
      throw new AppError(
        "This facility is no longer available.",
        409,
        "FACILITY_UNAVAILABLE",
      );
    }
    return normalizeFacility(raw);
  }

  async availability(
    session,
    id,
    date,
    { unit = session.unit, facility } = {},
  ) {
    validateDate(date, this.now());
    facility ??= await this.allowedFacility(session, id, { unit });
    const raw = array(
      await this.upstream(
        "availability",
        { facilityId: id, dateTime: date },
        this.context(session, unit),
      ),
    );
    const slots = raw
      .filter(
        (s) =>
          String(s.date).slice(0, 10) === date &&
          (s.facilityId == null || String(s.facilityId) === id),
      )
      .map((s) => normalizeSlot(s, facility, this.now()));
    return {
      date,
      slots,
      checkedAt: new Date(this.now()).toISOString(),
      ...bookingWindow(this.now()),
    };
  }

  async bookings(session, tab = "current", { unit = session.unit } = {}) {
    const filters = {
      current: { status: 1, type: 0 },
      history: { status: 1, type: 1 },
      unpaid: { status: 0 },
    };
    if (!Object.hasOwn(filters, tab))
      throw new AppError("Unknown booking list.");
    const raw = array(
      await this.upstream(
        "bookings",
        filters[tab],
        this.context(session, unit),
      ),
    );
    return raw
      .filter(
        (b) =>
          (b.unitId == null || String(b.unitId) === unit.unitId) &&
          (b.projectId == null || String(b.projectId) === unit.projectId),
      )
      .map((b) => {
        const record = normalizeBooking(b, tab);
        const quote = [...session.quotes.values()].find(
          (q) => q.result?.bookingId === record.id && sameUnit(q.unit, unit),
        );
        if (quote?.result) record.receipt = quote.result;
        record.unit =
          String(b.unitId ?? "") === unit.unitId || quote?.result
            ? { ...unit }
            : null;
        return record;
      });
  }

  async preview(session, body) {
    const unit = session.unit;
    this.context(session, unit);
    const date = validateDate(body.date, this.now());
    const facilityId = identifier(body.facilityId, "facility");
    const slotId = identifier(body.slotId, "time slot");
    if (
      !Number.isInteger(body.quantity) ||
      body.quantity < 1 ||
      body.quantity > 99
    ) {
      throw new AppError("Choose a valid booking quantity.");
    }
    const facility = await this.facility(session, facilityId, {
      unit,
      fresh: true,
    });
    const availability = await this.availability(session, facilityId, date, {
      unit,
      facility,
    });
    const slot = availability.slots.find((s) => s.id === slotId);
    if (!slot?.enabled)
      throw new AppError(
        slot?.reason || "That time is no longer available.",
        409,
        "SLOT_UNAVAILABLE",
      );
    if (body.quantity > slot.maxQuantity)
      throw new AppError(
        `A maximum of ${slot.maxQuantity} can be booked for this session.`,
        409,
        "QUANTITY_UNAVAILABLE",
      );
    if (!sameUnit(unit, session.unit))
      throw new AppError(
        "Your selected unit changed. Please review again.",
        409,
        "UNIT_CHANGED",
      );
    for (const [key, quote] of session.quotes) {
      if (!quote.attempted && quote.expiresAt < this.now())
        session.quotes.delete(key);
    }
    if (session.quotes.size >= 100)
      throw new AppError(
        "Too many booking reviews. Please sign in again.",
        429,
      );
    const quote = {
      id: crypto.randomUUID(),
      unit: { ...unit },
      facility,
      slot,
      quantity: body.quantity,
      amount: slot.price * body.quantity,
      expiresAt: this.now() + QUOTE_TTL_MS,
      attempted: false,
      result: null,
    };
    session.quotes.set(quote.id, quote);
    return this.quoteView(quote);
  }

  quoteView(quote) {
    return {
      previewId: quote.id,
      expiresAt: new Date(quote.expiresAt).toISOString(),
      unit: quote.unit,
      facility: {
        id: quote.facility.id,
        name: quote.facility.name,
        image: quote.facility.image,
      },
      date: quote.slot.date,
      startTime: quote.slot.startTime,
      endTime: quote.slot.endTime,
      quantity: quote.quantity,
      unitPrice: quote.slot.price,
      amount: quote.amount,
      paymentMethod: "Bank transfer / PayNow UEN",
    };
  }

  async book(session, body) {
    this.assertWritable();
    this.context(session);
    if (body.confirm !== true)
      throw new AppError(
        "Use the Book button to submit a reservation.",
        400,
        "CONFIRMATION_REQUIRED",
      );
    if (!Number.isSafeInteger(body.expectedAmount) || body.expectedAmount < 0)
      throw new AppError("Select a time to see its current price.");
    const selection = {
      facilityId: identifier(body.facilityId, "facility"),
      slotId: identifier(body.slotId, "time slot"),
      date: body.date,
      quantity: body.quantity,
    };
    const fingerprint = comparisonKey([
      session.unit.unitId,
      selection.facilityId,
      selection.slotId,
      selection.quantity,
    ]);
    const active = this.actions.get(this.scope(session));
    if (active?.fingerprint === fingerprint && active.result)
      return active.result;
    if (active?.processing || active?.uncertain)
      throw new AppError(
        active.uncertain
          ? "A previous booking has an unconfirmed outcome. Check My bookings before trying again."
          : "A booking is already being submitted.",
        409,
        active.uncertain ? "OUTCOME_UNCERTAIN" : "BOOKING_IN_PROGRESS",
      );
    const checked = await this.preview(session, selection);
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
    const quote = session.quotes.get(checked.previewId);
    // A single Book action checks fresh data once, then inserts immediately.
    // The object identity is internal; request bodies cannot skip validation.
    return this.commit(
      session,
      { previewId: checked.previewId, confirm: true },
      { freshQuote: quote },
    );
  }

  async commit(session, body, { freshQuote } = {}) {
    // This check precedes all upstream work, including in tests.
    this.assertWritable();
    if (body.confirm !== true)
      throw new AppError(
        "Explicit booking confirmation is required.",
        400,
        "CONFIRMATION_REQUIRED",
      );
    const quote = session.quotes.get(
      requiredString(body.previewId, "booking review ID", 100),
    );
    if (!quote)
      throw new AppError(
        "Please review your booking again.",
        409,
        "PREVIEW_NOT_FOUND",
      );
    if (quote.result) return quote.result;
    if (quote.promise) return quote.promise;
    if (quote.attempted)
      throw new AppError(
        "This booking was already submitted. Check My bookings.",
        409,
        "ALREADY_ATTEMPTED",
      );
    if (!sameUnit(quote.unit, session.unit))
      throw new AppError(
        "Your selected unit changed. Please review again.",
        409,
        "UNIT_CHANGED",
      );
    if (quote.expiresAt <= this.now())
      throw new AppError(
        "Your booking review expired. Please check availability again.",
        409,
        "PREVIEW_EXPIRED",
      );
    const scope = this.scope(session, quote.unit);
    const active = this.actions.get(scope);
    if (active?.processing || active?.uncertain) {
      throw new AppError(
        active.uncertain
          ? "A previous submission has an unconfirmed outcome. Check My bookings and the estate app before trying again."
          : "A booking submission is already in progress for this unit.",
        409,
        active.uncertain ? "OUTCOME_UNCERTAIN" : "BOOKING_IN_PROGRESS",
      );
    }
    const fingerprint = comparisonKey([
      quote.unit.unitId,
      quote.facility.id,
      quote.slot.id,
      quote.quantity,
    ]);
    if (active?.fingerprint === fingerprint && active.result)
      return active.result;
    const action = { processing: true, uncertain: false, fingerprint };
    this.actions.set(scope, action);
    quote.promise = this.submitQuote(
      session,
      quote,
      action,
      freshQuote === quote,
    ).finally(() => {
      action.processing = false;
      quote.promise = null;
    });
    return quote.promise;
  }

  async submitQuote(session, quote, action, alreadyChecked = false) {
    const unit = quote.unit;
    const context = this.context(session, unit);
    const facility = alreadyChecked
      ? quote.facility
      : await this.facility(session, quote.facility.id, {
          unit,
          fresh: true,
        });
    const availability = alreadyChecked
      ? null
      : await this.availability(session, facility.id, quote.slot.date, {
          unit,
          facility,
        });
    const current = alreadyChecked
      ? quote.slot
      : availability.slots.find((s) => s.id === quote.slot.id);
    if (!current?.enabled || current.maxQuantity < quote.quantity) {
      throw new AppError(
        "That session is no longer available. Please choose another time.",
        409,
        "SLOT_UNAVAILABLE",
      );
    }
    if (
      current.price !== quote.slot.price ||
      current.startTime !== quote.slot.startTime ||
      current.endTime !== quote.slot.endTime
    ) {
      throw new AppError(
        "The time or price changed. Select a time again.",
        409,
        "PREVIEW_CHANGED",
      );
    }
    if (quote.expiresAt <= this.now())
      throw new AppError(
        "Your booking review expired. Please review again.",
        409,
        "PREVIEW_EXPIRED",
      );
    quote.attempted = true;
    const orderDesc = `${quote.slot.date} ${quote.slot.startTime}-${quote.slot.endTime}`;
    let inserted;
    try {
      inserted = await this.upstream(
        "insertBooking",
        {
          facilityId: facility.id,
          facilityDetailId: quote.slot.id,
          bookingNum: quote.quantity,
          goodsDetail: facility.name,
          orderDesc,
          unitId: unit.unitId,
        },
        context,
      );
    } catch (error) {
      if (["ESTATE_REJECTED", "SESSION_EXPIRED"].includes(error.code))
        throw error;
      action.uncertain = true;
      quote.result = {
        ...this.quoteView(quote),
        status: "outcome_unknown",
        message:
          "The estate did not confirm the result. A reservation may have been created. Check My bookings or the estate app before trying again.",
      };
      action.result = quote.result;
      return quote.result;
    }
    if (inserted?.maxShow) {
      throw new AppError(
        String(inserted.notice || "The estate booking limit has been reached."),
        409,
        "BOOKING_LIMIT",
      );
    }
    if (!inserted?.id) {
      action.uncertain = true;
      quote.result = {
        ...this.quoteView(quote),
        status: "outcome_unknown",
        message:
          "The estate did not return a reservation reference. Check My bookings before trying again.",
      };
      action.result = quote.result;
      return quote.result;
    }
    let bookingId;
    try {
      bookingId = identifier(inserted.id, "booking");
    } catch {
      action.uncertain = true;
      quote.result = {
        ...this.quoteView(quote),
        status: "outcome_unknown",
        message:
          "The estate returned an unreadable reservation reference. Check My bookings before trying again.",
      };
      action.result = quote.result;
      return quote.result;
    }
    let order;
    try {
      const response = await this.upstream(
        "createOrder",
        {
          orderSpeciesId: facility.id,
          makeId: bookingId,
          price: quote.slot.price,
          quantity: quote.quantity,
          orderType: 0,
          transAmount: quote.amount,
          goodsDetail: facility.name,
          orderDesc,
          transType: "LOCAL_CASH",
          unitId: unit.unitId,
          projectId: unit.projectId,
        },
        context,
      );
      // This endpoint has an additional data envelope in the APK's handlers.
      order = response?.data ?? response;
      if (!order?.orderNo)
        throw new AppError(
          "Order reference missing.",
          502,
          "UPSTREAM_RESPONSE",
        );
    } catch {
      action.uncertain = true;
      quote.result = {
        ...this.quoteView(quote),
        bookingId,
        status: "order_unconfirmed",
        message:
          "Your reservation was created, but payment setup was not confirmed. Do not submit it again. Check pending payments in My bookings or finish in the estate app.",
      };
      action.result = quote.result;
      return quote.result;
    }
    quote.result = {
      ...this.quoteView(quote),
      bookingId,
      orderNo: String(order.orderNo),
      status: "payment_pending",
      message:
        "Your booking was submitted. Complete the bank transfer or PayNow UEN payment and send proof of payment to management.",
    };
    action.result = quote.result;
    return quote.result;
  }

  async paymentStatus(session, previewId) {
    const quote = session.quotes.get(previewId);
    if (!quote?.result?.orderNo)
      throw new AppError(
        "Order not found in this session.",
        404,
        "ORDER_NOT_FOUND",
      );
    if (!sameUnit(quote.unit, session.unit))
      throw new AppError(
        "This booking belongs to a different unit.",
        403,
        "UNIT_CHANGED",
      );
    return this.orderStatus(session, quote.unit, quote.result.orderNo);
  }

  async orderStatus(session, unit, orderNo) {
    const result = await this.upstream(
      "orderStatus",
      { orderNo },
      this.context(session, unit),
    );
    const raw = result?.data ?? result;
    if (![0, 1, 2, 3, 4, "0", "1", "2", "3", "4"].includes(raw))
      throw new AppError(
        "The estate did not confirm the payment status. Please try checking again.",
        502,
        "UPSTREAM_RESPONSE",
      );
    const code = Number(raw);
    const status =
      code === 2 ? "paid" : [3, 4].includes(code) ? "expired" : "pending";
    return { status };
  }

  async reservation(session, id, unit) {
    identifier(id, "booking");
    // Resolve IDs only from the authenticated unit's lists, never from client
    // supplied prices, order references, or unit/project fields.
    for (const tab of ["unpaid", "current"]) {
      const booking = (await this.bookings(session, tab, { unit })).find(
        (b) => b.id === id,
      );
      if (booking) return booking;
    }
    throw new AppError(
      "This reservation is no longer active. Refresh My bookings.",
      404,
      "BOOKING_NOT_FOUND",
    );
  }

  reservationKey(session, unit, id) {
    return comparisonKey([session.user.id, unit.projectId, unit.unitId, id]);
  }

  async reservationOrder(session, unit, booking) {
    const key = this.reservationKey(session, unit, booking.id);
    const cached = this.reservationOrders.get(key);
    const orderNo =
      cached?.orderNo || booking.orderNo || booking.receipt?.orderNo;
    if (orderNo && !cached?.uncertain) return { ...cached, orderNo };
    // The native order list uses requestNo, while getOrder uses orderNo.
    // Search all pages so an older reservation does not create a duplicate order.
    const matching = [];
    let unlinked = false;
    for (let pageIndex = 1; pageIndex <= 20; pageIndex++) {
      const response = await this.upstream(
        "orders",
        {
          pageIndex,
          pageSize: 50,
          status: [1, 2, 3, 4],
        },
        this.context(session, unit),
      );
      const records = array(response?.list);
      matching.push(
        ...records.filter(
          (order) =>
            String(order.makeId) === booking.id &&
            Number(order.orderType) === 0 &&
            (order.unitId == null || String(order.unitId) === unit.unitId) &&
            (order.projectId == null ||
              String(order.projectId) === unit.projectId),
        ),
      );
      unlinked ||= records.some(
        (order) =>
          order.orderType == null ||
          (Number(order.orderType) === 0 && !order.makeId),
      );
      const total = Number(response.total);
      if (
        (response.total != null &&
          Number.isFinite(total) &&
          pageIndex * 50 >= total) ||
        (response.total == null && records.length < 50)
      ) {
        const paid = matching.find((order) => Number(order.status) === 2);
        const pending = matching.filter((order) => Number(order.status) === 1);
        if (!paid && pending.length > 1)
          throw new AppError(
            "Multiple payment orders were returned for this reservation. Please check with estate management.",
            409,
            "ORDER_AMBIGUOUS",
          );
        const order = paid || pending[0] || matching[0];
        if (order) {
          const reference = requiredString(
            order.requestNo || order.orderNo,
            "order reference",
            200,
          );
          const found = {
            orderNo: reference,
            codeUrl: typeof order.codeUrl === "string" ? order.codeUrl : "",
            transType: String(order.transType || ""),
          };
          if (!cached?.uncertain || reference !== cached.previousOrderNo)
            this.reservationOrders.set(key, found);
          return found;
        }
        if (unlinked)
          throw new AppError(
            "The estate did not link its payment orders to this reservation. Please check with estate management before starting another payment.",
            409,
            "ORDER_UNCONFIRMED",
          );
        return null;
      }
    }
    throw new AppError(
      "The payment order list could not be fully checked. Please try again later.",
      502,
      "UPSTREAM_RESPONSE",
    );
  }

  async bookingPayment(session, id) {
    const unit = { ...session.unit };
    this.context(session);
    const booking = await this.reservation(session, id, unit);
    if (booking.tab === "current") return { booking, status: "paid" };
    const order = await this.reservationOrder(session, unit, booking);
    const status = order
      ? (await this.orderStatus(session, unit, order.orderNo)).status
      : "not_started";
    const submission = this.actions.get(this.scope(session, unit));
    if (order && submission?.result?.bookingId === id && !submission.processing)
      submission.uncertain = false;
    return {
      booking: status === "paid" ? { ...booking, tab: "current" } : booking,
      ...order,
      status,
    };
  }

  async reservationMutation(session, id, callback) {
    this.assertWritable();
    this.context(session);
    identifier(id, "booking");
    const unit = { ...session.unit };
    const key = this.reservationKey(session, unit, id);
    if (
      this.reservationActions.has(key) ||
      this.actions.get(this.scope(session))?.processing
    )
      throw new AppError(
        "A reservation action is already in progress. Please wait.",
        409,
        "BOOKING_IN_PROGRESS",
      );
    this.reservationActions.set(key, { scope: this.scope(session) });
    try {
      return await callback(unit, key);
    } finally {
      this.reservationActions.delete(key);
    }
  }

  async resumePayment(session, id, body) {
    if (body.confirm !== true)
      throw new AppError(
        "Use Complete payment to continue this reservation.",
        400,
        "CONFIRMATION_REQUIRED",
      );
    return this.reservationMutation(session, id, async (unit, key) => {
      const payment = await this.bookingPayment(session, id);
      if (["paid", "pending"].includes(payment.status)) return payment;
      if (
        this.reservationOrders.get(key)?.uncertain ||
        (payment.status === "not_started" &&
          payment.booking.receipt?.status === "order_unconfirmed")
      )
        throw new AppError(
          "Payment setup has an unconfirmed outcome. Check payment again before retrying or contact estate management.",
          409,
          "OUTCOME_UNCERTAIN",
        );
      const booking = payment.booking;
      const amount = booking.amount ?? booking.price * booking.quantity;
      if (
        !Number.isSafeInteger(booking.price) ||
        booking.price < 0 ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        !Number.isInteger(booking.quantity) ||
        booking.quantity < 1
      )
        throw new AppError(
          "The estate did not return a valid payment amount. Refresh My bookings.",
          409,
          "PAYMENT_AMOUNT_UNAVAILABLE",
        );
      let order;
      try {
        const response = await this.upstream(
          "createOrder",
          {
            orderSpeciesId: identifier(booking.facilityId, "facility"),
            makeId: booking.id,
            price: booking.price,
            quantity: booking.quantity,
            orderType: 0,
            transAmount: amount,
            goodsDetail: booking.facilityName,
            orderDesc: `${booking.startTime}-${booking.endTime.slice(11)}`,
            transType: "LOCAL_CASH",
            unitId: unit.unitId,
            projectId: unit.projectId,
          },
          this.context(session, unit),
        );
        const result = response?.data ?? response;
        order = {
          orderNo: requiredString(result?.orderNo, "order reference", 200),
          transType: "LOCAL_CASH",
        };
      } catch (error) {
        if (["ESTATE_REJECTED", "SESSION_EXPIRED"].includes(error.code))
          throw error;
        this.reservationOrders.set(key, {
          uncertain: true,
          previousOrderNo: payment.orderNo,
        });
        throw new AppError(
          "Payment setup could not be confirmed. Check payment before trying again; your existing reservation has been kept.",
          502,
          "OUTCOME_UNCERTAIN",
        );
      }
      this.reservationOrders.set(key, order);
      return { booking, ...order, status: "pending" };
    });
  }

  async cancelReservation(session, id, body) {
    if (body.confirm !== true)
      throw new AppError(
        "Confirm the reservation you want to cancel.",
        400,
        "CONFIRMATION_REQUIRED",
      );
    return this.reservationMutation(session, id, async (unit, key) => {
      const payment = await this.bookingPayment(session, id);
      if (payment.status === "paid" || payment.booking.tab !== "unpaid")
        throw new AppError(
          "This reservation is already paid. Refresh My bookings or contact estate management about cancellation.",
          409,
          "BOOKING_NOT_PENDING",
        );
      try {
        await this.upstream(
          "cancelBooking",
          { id, projectId: unit.projectId },
          this.context(session, unit),
        );
      } catch (error) {
        if (["ESTATE_REJECTED", "SESSION_EXPIRED"].includes(error.code))
          throw error;
        throw new AppError(
          "Cancellation could not be confirmed. Refresh My bookings to check whether the reservation is still active.",
          502,
          "OUTCOME_UNCERTAIN",
        );
      }
      this.reservationOrders.delete(key);
      for (const [previewId, quote] of session.quotes)
        if (quote.result?.bookingId === id && sameUnit(quote.unit, unit))
          session.quotes.delete(previewId);
      if (this.actions.get(this.scope(session, unit))?.result?.bookingId === id)
        this.actions.delete(this.scope(session, unit));
      return { status: "cancelled", bookingId: id };
    });
  }
}
