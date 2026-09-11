import { AppError } from "./errors.mjs";
import {
  addDays,
  freeTennisCancellationCandidate,
  normalizeBooking,
  singaporeDate,
} from "./model.mjs";

// This sample PNG encodes only “DEMO ONLY - NOT VALID FOR FACILITY ENTRY”.
// No resident, booking ID, unit ID or working access credential is encoded.
const DEMO_BOOKING_QR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJQAAACUCAAAAABQV18IAAABp0lEQVR4nO3WzW7GMAhE0bz/S7erStF0Bki7+CJ82ThxDBwk9+f6emFcnwa4ADUNUNMANQ1Q0wA1DVDTADWNX6irCD3z8+z2Uk5VF9RelO655t3707qg9qNcM1fk/u7OT+uCOht130/5rh4oUCnZoa4QT+qC2o16uu8Af60Lah+qurT/WbsfBlA7UV0kZHX+cQ9Qq1CpSELoRU6592/VJQe1E9XBEn4Cc0BQ+1HV6hpcctl1T9cKD2onygHSt1i4+CXb5YPahVJMurAVwJ13tWJvUKtQikmFXU7CdAOAOgOlBfS5widMGgrUblQCarOugQNqbqoBah/KNXbPWtS9V0PHgUCtQnVFHcjluGE0H9Q5qBS2QPNHuMPYwUGtQ1XNXFFbuBgifQO1G6VAvaiTC+tyOxCofag2ITRJSLfvBge1F+WaaiFXXBsoKq12cFDrUPag+YetazYdBtQZKL3gVTM952qkAAXKndU8t2pe+R3UcSh9djluv6oDaj9qul+dm4JB7UelSI1i8fCtGxDULtQbAtQ0QE0D1DRATQPUNEBNA9Q0Xon6BncpBlSb26tzAAAAAElFTkSuQmCC";

function demoBookingTime(booking, field) {
  const value = normalizeBooking(booking, "current")[field];
  if (!value) return NaN;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  return Date.parse(value.replace(" ", "T") + (hasOffset ? "" : "+08:00"));
}

export function demoBookingTab(booking, now = Date.now()) {
  if (Number(booking.status) === 0) return "unpaid";
  if (Number(booking.status) !== 1) return null;
  return demoBookingTime(booking, "endTime") > now ? "current" : "history";
}

const isZero = (value) =>
  ["number", "string"].includes(typeof value) &&
  String(value).trim() !== "" &&
  Number(value) === 0;

export function demoCanCancelBooking(booking, order, now = Date.now()) {
  const tab = demoBookingTab(booking, now);
  if (tab === "unpaid") return Number(order?.status) !== 2;
  return (
    freeTennisCancellationCandidate(normalizeBooking(booking, tab), now) &&
    isZero(booking.pricing) &&
    isZero(booking.paidTotal) &&
    Number(order?.status) === 2 &&
    [order.price, order.transAmount, order.tipsAmount].every(isZero)
  );
}

export function demoBookingQr(booking, unitId, now = Date.now()) {
  if (!booking || booking.unitId !== unitId)
    throw new AppError("Demo booking not found.", 404, "BOOKING_NOT_FOUND");
  if (demoBookingTab(booking, now) !== "current")
    throw new AppError(
      "A current confirmed demo booking is needed to show its sample QR.",
      409,
      "BOOKING_QR_UNAVAILABLE",
    );
  return [DEMO_BOOKING_QR];
}

// Synthetic identities and reservations only. This adapter never calls fetch.
export function createDemoUpstream({ now = Date.now } = {}) {
  const projectId = "demo-project";
  const units = [
    {
      unitId: "demo-unit-1",
      unitName: "#08-01",
      buildingName: "Block 2",
      projectId,
      projectName: "Sample estate",
      userType: 0,
      status: 0,
      activation: 1,
    },
    {
      unitId: "demo-unit-2",
      unitName: "#12-03",
      buildingName: "Block 6",
      projectId,
      projectName: "Sample estate",
      userType: 0,
      status: 0,
      activation: 1,
    },
  ];
  const names = [
    "Jewel Function Room 1",
    "Jewel Function Room 2",
    "Jewel Function Room 3",
    "Pool Function Room 1",
    "Pool Function Room 2",
    "Tennis Court (Off-Peak)",
    "Golf Simulator / Games Room",
    "BBQ Pavilion 1",
    "BBQ Pavilion 2",
    "BBQ Pavilion 3",
    "Karaoke / Music Room",
  ];
  const facilities = names.map((name, index) => ({
    id: `demo-facility-${index + 1}`,
    projectId,
    name,
    status: 1,
    isDelete: 0,
    pricing: name.includes("Tennis") ? 0 : 116.35,
    perOrderNum: name.includes("Tennis") ? 8 : 1,
    cancelDay: 0,
    num: 1,
    backgroundImageUrl: `/assets/${name.includes("Tennis") ? "tennis" : name.includes("Golf") ? "games" : name.includes("BBQ") ? "bbq" : name.includes("Karaoke") ? "music" : "function-room"}.png`,
    openTimeRange: name.includes("Tennis")
      ? Array.from({ length: 11 }, (_, index) => {
          const start = String(index + 8).padStart(2, "0");
          const end = String(index + 9).padStart(2, "0");
          return `${start}:00-${end}:00`;
        }).join(",")
      : "09:00-15:00,17:00-22:00",
    introduction: name.includes("Tennis")
      ? "Make time for a match. Free off-peak sessions run from 8 am to 7 pm, with an example monthly limit of eight sessions per unit."
      : name.includes("BBQ")
        ? "Bring your favourite people together for a relaxed afternoon and a meal in the open air."
        : name.includes("Karaoke")
          ? "Set the playlist and make an evening of it in a dedicated room for music and good company."
          : "A welcoming space for the moments you share, from family celebrations to a quiet gathering with friends.",
    regulations: `<p><strong>Demonstration facility rules</strong></p><ol><li>Bookings open up to four weeks in advance, subject to availability.</li><li>${name.includes("Tennis") ? "Free off-peak tennis has an example limit of eight sessions per unit per month. Confirmed free sessions can be cancelled before they start." : "Each unit may reserve one session, subject to the estate’s monthly limits."}</li><li>Residents must accompany their guests and leave the facility clean.</li><li>Fees and deposits are shown before you confirm.</li><li>These are example rules. Live mode displays the estate’s complete terms.</li></ol>`,
  }));
  const bookings = [];
  const orders = new Map();
  const calls = [];
  const demo = async (operation, body = {}, context = {}) => {
    calls.push({
      operation,
      body: structuredClone(body),
      context: { ...context },
    });
    if (operation === "login") {
      if (body.phoneOrEmail !== "demo" || body.cipher !== "demo")
        throw new AppError(
          "Use demo / demo to explore the demonstration.",
          401,
          "LOGIN_FAILED",
        );
      return {
        token: "local-demo-token",
        ownerLoginOutDTO: {
          id: "demo-owner",
          username: "Alex",
          email: "alex@example.com",
          phone: "",
          isTmp: 0,
          ownerUnitOutDTOS: units,
        },
      };
    }
    if (context.token !== "local-demo-token")
      throw new AppError("Sign in to the demo.", 401, "SESSION_EXPIRED");
    if (operation === "units") return structuredClone(units);
    if (operation === "project")
      return { id: projectId, name: "Sample estate" };
    if (operation === "facilities") return structuredClone(facilities);
    if (operation === "facility")
      return structuredClone(facilities.find((f) => f.id === body.id) || {});
    if (operation === "notice") return {};
    if (operation === "qrConfig" && body.code === "001") return { value: 10 };
    if (operation === "bookingQr") {
      if (body.unitId !== context.unitId)
        throw new AppError("Demo booking not found.", 404, "BOOKING_NOT_FOUND");
      return demoBookingQr(
        bookings.find((booking) => booking.id === body.bookingId),
        context.unitId,
        now(),
      );
    }
    if (operation === "availability") {
      const facility = facilities.find((f) => f.id === body.facilityId);
      if (!facility) return [];
      return facility.openTimeRange.split(",").map((range, index) => {
        const [startTime, endTime] = range.split("-");
        const id = `${facility.id}-${body.dateTime}-${index}`;
        const occupied = bookings.some((b) => b.facilityDetailId === id);
        return {
          id,
          facilityId: facility.id,
          date: body.dateTime,
          startTime,
          endTime,
          pricing: facility.pricing,
          num: 1,
          status: 1,
          ordered: occupied ? 1 : 0,
          remainingNum: occupied ? 0 : 1,
          reservation: true,
        };
      });
    }
    if (operation === "bookings") {
      const tab =
        Number(body.status) === 0
          ? "unpaid"
          : Number(body.type) === 1
            ? "history"
            : "current";
      return structuredClone(
        bookings.filter(
          (b) =>
            b.unitId === context.unitId &&
            Number(b.status) === Number(body.status) &&
            demoBookingTab(b, now()) === tab,
        ),
      );
    }
    if (operation === "insertBooking") {
      const facility = facilities.find((f) => f.id === body.facilityId);
      if (
        !facility ||
        bookings.some((b) => b.facilityDetailId === body.facilityDetailId)
      )
        throw new AppError(
          "This session has already been booked in the demo.",
          422,
          "ESTATE_REJECTED",
        );
      const id = "demo-booking-" + crypto.randomUUID();
      const [date, time] = body.orderDesc.split(" ");
      const [start, end] = time.split("-");
      bookings.push({
        id,
        facilityId: body.facilityId,
        facilityName: facility.name,
        facilityDetailId: body.facilityDetailId,
        unitId: body.unitId,
        projectId,
        bookingNum: body.bookingNum,
        startTime: `${date} ${start}:00`,
        endTime: `${date} ${end}:00`,
        pricing: facility.pricing,
        paidTotal: facility.pricing * body.bookingNum,
        status: 0,
        gmtCreate: new Date(now()).toISOString(),
        gmtModified: new Date(now()).toISOString(),
      });
      return { id };
    }
    if (operation === "createOrder") {
      const orderNo = "DEMO-" + (orders.size + 1).toString().padStart(5, "0");
      const booking = bookings.find(
        (b) => b.id === body.makeId && b.unitId === context.unitId,
      );
      if (!booking) throw new AppError("Demo booking not found.", 404);
      booking.orderNo = orderNo;
      const free = isZero(booking.pricing) && isZero(booking.paidTotal);
      booking.status = free ? 1 : 0;
      booking.gmtModified = new Date(now()).toISOString();
      orders.set(orderNo, {
        ...body,
        unitId: booking.unitId,
        projectId,
        price: Math.round(booking.pricing * 100),
        transAmount: Math.round(booking.paidTotal * 100),
        tipsAmount: 0,
        requestNo: orderNo,
        status: free ? 2 : 1,
        gmtCreate: new Date(now()).toISOString(),
        gmtModified: new Date(now()).toISOString(),
      });
      return { data: { orderNo, codeUrl: "" } };
    }
    if (operation === "orderStatus")
      return { data: orders.get(body.orderNo)?.status ?? 4 };
    if (operation === "orders") {
      const listed = [...orders.values()].filter(
        (order) =>
          order.unitId === context.unitId && body.status.includes(order.status),
      );
      return {
        list: listed.slice(
          (body.pageIndex - 1) * body.pageSize,
          body.pageIndex * body.pageSize,
        ),
        total: listed.length,
      };
    }
    if (operation === "cancelBooking") {
      const index = bookings.findIndex(
        (b) =>
          b.id === body.id &&
          b.unitId === context.unitId &&
          demoCanCancelBooking(b, orders.get(b.orderNo), now()),
      );
      if (index < 0)
        throw new AppError(
          "This demo booking cannot be cancelled.",
          422,
          "ESTATE_REJECTED",
        );
      const [booking] = bookings.splice(index, 1);
      // A cancelled free booking keeps its settled zero-value order, matching
      // the observed estate behaviour. Pending demo orders expire instead.
      const order = orders.get(booking.orderNo);
      if (order && Number(order.status) !== 2) order.status = 4;
      return {};
    }
    throw new AppError(
      "This action is not part of the offline demonstration.",
      400,
      "DEMO_UNSUPPORTED",
    );
  };
  demo.calls = calls;
  demo.facilities = facilities;
  demo.units = units;
  demo.bookings = bookings;
  demo.orders = orders;
  demo.suggestedDate = addDays(singaporeDate(now()), 1);
  return demo;
}
