import { AppError } from "./errors.mjs";
import {
  QUOTE_TTL_MS,
  bookingWindow,
  validateDate,
  identifier,
  requiredString,
  normalizeUnit,
  normalizeFacility,
  normalizeNotice,
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
  constructor({ upstream, readOnly = false, demo = false, now = Date.now }) {
    this.upstream = upstream;
    this.readOnly = readOnly;
    this.demo = demo;
    this.now = now;
    this.actions = new Map();
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
        email: String(owner.email || ""),
        phone: String(owner.phone || ""),
        needsEmail: !owner.email,
        needsPasswordChange: Number(owner.isTmp) === 1,
      },
      units,
      unit: units[0] ?? null,
      csrf: randomSecret(),
      quotes: new Map(),
      facilities: new Map(),
      lastCodeSentAt: 0,
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

  assertProfileReady(session) {
    if (session.user.needsEmail || session.user.needsPasswordChange) {
      throw new AppError(
        "Complete your owner profile before submitting a booking.",
        409,
        "PROFILE_INCOMPLETE",
      );
    }
  }

  scope(session, unit = session.unit) {
    return comparisonKey([session.user.id, unit?.unitId]);
  }

  switchUnit(session, unitId) {
    const action = this.actions.get(this.scope(session));
    if (action?.processing)
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
    const [raw, notice] = await Promise.all([
      this.upstream("facility", { id }, context),
      this.upstream("notice", { id, unitId: unit.unitId }, context),
    ]);
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
    return { ...normalizeFacility(raw), notice: normalizeNotice(notice) };
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

  async bookings(session, tab = "current") {
    const filters = {
      current: { status: 1, type: 0 },
      history: { status: 1, type: 1 },
      unpaid: { status: 0 },
    };
    if (!Object.hasOwn(filters, tab))
      throw new AppError("Unknown booking list.");
    const unit = session.unit;
    const raw = array(
      await this.upstream(
        "bookings",
        filters[tab],
        this.context(session, unit),
      ),
    );
    return raw
      .filter((b) => b.unitId == null || String(b.unitId) === unit.unitId)
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
    if (body.rulesAccepted !== true)
      throw new AppError(
        "Please read and accept the facility rules.",
        400,
        "RULES_REQUIRED",
      );
    const facility = await this.facility(session, facilityId, {
      unit,
      fresh: true,
    });
    if (facility.notice.show && body.noticeAccepted !== true) {
      throw new AppError(
        "Please acknowledge the facility notice before continuing.",
        400,
        "NOTICE_REQUIRED",
        { notice: facility.notice },
      );
    }
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
      termsKey: comparisonKey([facility.regulations, facility.notice]),
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

  async commit(session, body) {
    // This check precedes all upstream work, including in tests.
    this.assertWritable();
    this.assertProfileReady(session);
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
          ? "A previous submission has an unconfirmed outcome. Check My bookings and the Intelliving app before trying again."
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
    quote.promise = this.submitQuote(session, quote, action).finally(() => {
      action.processing = false;
      quote.promise = null;
    });
    return quote.promise;
  }

  async submitQuote(session, quote, action) {
    const unit = quote.unit;
    const context = this.context(session, unit);
    // Refresh both pricing and rules immediately before the one permitted insertion.
    const facility = await this.facility(session, quote.facility.id, {
      unit,
      fresh: true,
    });
    const availability = await this.availability(
      session,
      facility.id,
      quote.slot.date,
      { unit, facility },
    );
    const current = availability.slots.find((s) => s.id === quote.slot.id);
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
      current.endTime !== quote.slot.endTime ||
      facility.name !== quote.facility.name ||
      comparisonKey([facility.regulations, facility.notice]) !== quote.termsKey
    ) {
      throw new AppError(
        "The time, price or facility rules changed. Please review the updated booking.",
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
          "The estate did not confirm the result. A reservation may have been created. Check My bookings or the Intelliving app before trying again.",
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
          "Your reservation was created, but payment setup was not confirmed. Do not submit it again. Check pending payments in My bookings or finish in the Intelliving app.",
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
    const result = await this.upstream(
      "orderStatus",
      { orderNo: quote.result.orderNo },
      this.context(session, quote.unit),
    );
    const code = Number(result?.data ?? result);
    const status =
      code === 2 ? "paid" : [3, 4].includes(code) ? "expired" : "pending";
    return { status };
  }

  async sendCode(session, body) {
    this.assertWritable();
    const email = requiredString(body.email, "email address", 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new AppError("Enter a valid email address.");
    if (!session.user.needsEmail && !session.user.needsPasswordChange)
      throw new AppError("Your profile is already complete.");
    if (!session.user.needsEmail && email !== session.user.email)
      throw new AppError("Use the email address on your owner account.");
    if (
      session.lastCodeSentAt &&
      this.now() - session.lastCodeSentAt < 60_000
    ) {
      throw new AppError(
        "Please wait one minute before requesting another code.",
        429,
        "CODE_COOLDOWN",
      );
    }
    session.lastCodeSentAt = this.now();
    await this.upstream(
      session.user.needsEmail ? "profileCode" : "passwordCode",
      { email },
      { token: session.token, userType: 0 },
    );
    return { sent: true };
  }

  async completeProfile(session, body) {
    this.assertWritable();
    if (body.confirm !== true)
      throw new AppError("Confirm the profile update before continuing.");
    if (!session.user.needsEmail && !session.user.needsPasswordChange)
      throw new AppError("Your profile is already complete.");
    const cipher = body.cipher;
    if (
      typeof cipher !== "string" ||
      !cipher ||
      cipher.length > 300 ||
      cipher !== body.confirmPassword
    ) {
      throw new AppError("Enter matching new passwords.");
    }
    const verification = requiredString(
      body.verification,
      "verification code",
      32,
    );
    if (session.user.needsEmail) {
      const email = requiredString(body.email, "email address", 254);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new AppError("Enter a valid email address.");
      await this.upstream(
        "completeProfile",
        {
          email,
          cipher,
          verification,
          username: requiredString(body.username, "name", 120),
          phone: String(body.phone || "").slice(0, 40),
        },
        { token: session.token, userType: 0 },
      );
    } else {
      await this.upstream(
        "changeTemporaryPassword",
        {
          phoneOrEmail: session.user.email,
          cipher,
          verification,
          commitPassword: body.confirmPassword,
          api: "",
        },
        { token: session.token, userType: 0 },
      );
    }
    return { signInAgain: true };
  }
}
