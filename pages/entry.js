// This check runs before loading any sign-in or booking controls. GitHub Pages
// cannot set a frame-ancestors response header, so embedded use fails closed.
if (window.top !== window.self) {
  document.querySelector("#app").textContent =
    "Open Sesame directly in a browser tab to sign in.";
} else if (!window.isSecureContext) {
  document.querySelector("#app").textContent =
    "Open Sesame over HTTPS to sign in securely.";
} else {
  const demo = new URL(location.href).searchParams.get("demo") === "1";
  const request = demo
    ? (await import("./runtime.mjs")).createDemoRequest()
    : (await import("./live.mjs")).createLiveRequest();
  globalThis.sesameRequest = request;
  // Clear the old page's private state, while preserving tab-scoped sign-in
  // for refreshes and Safari's back/forward-cache reload below.
  window.addEventListener("pagehide", () => {
    if (request.suspend) request.suspend();
    else request.dispose?.();
    document.querySelector("#app").replaceChildren();
    document.querySelector("#modal").close();
    document.querySelector("#modal").replaceChildren();
    document.querySelector("#toasts").replaceChildren();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) location.reload();
  });
  await import("../app.js");
}
