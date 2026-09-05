import { createDemoRequest } from "./runtime.mjs";

// Set once, before app.js starts. The app captures and removes this bootstrap
// reference. The deployed CSP blocks all API connections as a second boundary.
globalThis.sesameDemoRequest = createDemoRequest();
await import("../app.js");
