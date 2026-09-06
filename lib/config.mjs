import deployment from "./deployment.mjs";

export function normalizeSiteConfig(value = {}) {
  const apiOrigin = value.apiOrigin || "https://estate.example.invalid";
  // One exact HTTPS origin, without credentials, paths, ports or CSP syntax.
  if (
    typeof apiOrigin !== "string" ||
    !/^https:\/\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(apiOrigin) ||
    new URL(apiOrigin).origin !== apiOrigin
  )
    throw new Error("Configure one plain HTTPS estate origin.");
  let payment = null;
  if (value.payment) {
    payment = {};
    for (const key of [
      "payee",
      "uen",
      "bankName",
      "bankAccount",
      "email",
      "qrText",
    ]) {
      const text = value.payment[key];
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > (key === "qrText" ? 4096 : 200)
      )
        throw new Error("Payment configuration is incomplete or invalid.");
      payment[key] = text;
    }
    if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(payment.email))
      throw new Error("Configure a valid payment contact email.");
    Object.freeze(payment);
  }
  // Explicit fields prevent unrelated environment data entering the artifact.
  return Object.freeze({ apiOrigin, payment });
}

export function parseSiteConfig(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("SESAME_SITE_CONFIG must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SESAME_SITE_CONFIG must be a JSON object.");
  return normalizeSiteConfig(value);
}

const environment =
  typeof process === "object" && process.versions?.node
    ? process.env.SESAME_SITE_CONFIG
    : undefined;
export const SITE_CONFIG = environment
  ? parseSiteConfig(environment)
  : normalizeSiteConfig(deployment);
