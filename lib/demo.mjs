import { AppError } from "./errors.mjs";
import { addDays, singaporeDate } from "./model.mjs";

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
    "Tennis Court",
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
    pricing: name.includes("Tennis") ? 2.18 : 116.35,
    perOrderNum: 1,
    num: 1,
    backgroundImageUrl: `/assets/${name.includes("Tennis") ? "tennis" : name.includes("Golf") ? "games" : name.includes("BBQ") ? "bbq" : name.includes("Karaoke") ? "music" : "function-room"}.png`,
    openTimeRange: name.includes("Tennis")
      ? "19:00-20:00,20:00-21:00,21:00-22:00"
      : "09:00-15:00,17:00-22:00",
    introduction: name.includes("Tennis")
      ? "Make time for a match. An outdoor court for friendly rallies and your next personal best."
      : name.includes("BBQ")
        ? "Bring your favourite people together for a relaxed afternoon and a meal in the open air."
        : name.includes("Karaoke")
          ? "Set the playlist and make an evening of it in a dedicated room for music and good company."
          : "A welcoming space for the moments you share, from family celebrations to a quiet gathering with friends.",
    regulations:
      "<p><strong>Demonstration facility rules</strong></p><ol><li>Bookings open up to four weeks in advance, subject to availability.</li><li>Each unit may reserve one session, subject to the estate’s monthly limits.</li><li>Residents must accompany their guests and leave the facility clean.</li><li>Fees and deposits are shown before you confirm.</li><li>These are example rules. Live mode displays the estate’s complete terms.</li></ol>",
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
      if (body.type === 1) return [];
      return structuredClone(
        bookings.filter(
          (b) =>
            b.unitId === context.unitId &&
            Number(b.status) === Number(body.status),
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
        bookingNum: body.bookingNum,
        startTime: `${date} ${start}:00`,
        endTime: `${date} ${end}:00`,
        pricing: facility.pricing,
        paidTotal: facility.pricing * body.bookingNum,
        status: 0,
      });
      return { id };
    }
    if (operation === "createOrder") {
      const orderNo = "DEMO-" + (orders.size + 1).toString().padStart(5, "0");
      const booking = bookings.find((b) => b.id === body.makeId);
      if (!booking) throw new AppError("Demo booking not found.", 404);
      booking.orderNo = orderNo;
      orders.set(orderNo, { ...body, requestNo: orderNo, status: 1 });
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
          b.id === body.id && b.unitId === context.unitId && b.status === 0,
      );
      if (index < 0)
        throw new AppError(
          "Pending demo reservation not found.",
          422,
          "ESTATE_REJECTED",
        );
      const [booking] = bookings.splice(index, 1);
      if (orders.has(booking.orderNo)) orders.get(booking.orderNo).status = 4;
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
