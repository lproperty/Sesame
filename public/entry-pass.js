import qrcode from "./vendor/qrcode.mjs";

export const ENTRY_REFRESH_MS = 10_000;

const id = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("A valid owner and unit are required for the entry pass.");
  return value;
};
const label = (value) => String(value || "").slice(0, 150);

// Copy only the minimum entry identity. Passwords, API tokens, email, phone,
// booking records and arbitrary caller properties never enter a saved pass.
export function normalizeEntryPass(value) {
  return {
    ownerId: id(value?.ownerId),
    unit: {
      unitId: id(value?.unit?.unitId),
      projectId: id(value?.unit?.projectId),
      buildingName: label(value.unit.buildingName),
      unitName: label(value.unit.unitName),
      projectName: label(value.unit.projectName) || "Grand Dunman",
    },
  };
}

export function entryPassFromSession(session) {
  const unit = session?.units?.find(
    (candidate) =>
      candidate.unitId === session.unit?.unitId &&
      candidate.projectId === session.unit?.projectId &&
      candidate.userType === 0,
  );
  if (!session?.user?.id || !unit)
    throw new Error(
      "Sign in with an activated owner unit to show your entry QR.",
    );
  return normalizeEntryPass({ ownerId: session.user.id, unit });
}

export function entryPayload(value, now = Date.now()) {
  const pass = normalizeEntryPass(value);
  if (!Number.isSafeInteger(now) || now <= 0)
    throw new Error("The device clock is unavailable.");
  // Native pages/QR-access uses these keys, millisecond time, and removes JSON
  // quotes. Keep identifiers as strings so 19-digit estate IDs remain exact.
  return `{id:${pass.ownerId},unitId:${pass.unit.unitId},timestamp:${now}}`;
}

export function createEntryQr(value, now = Date.now()) {
  const code = qrcode(0, "M");
  code.addData(entryPayload(value, now), "Byte");
  code.make();
  return {
    svg: code.createSvgTag({
      cellSize: 6,
      margin: 24,
      scalable: true,
      title: "Resident entry QR",
    }),
    updatedAt: now,
  };
}
