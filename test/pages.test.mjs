import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { buildPages, verifyPages } from "../scripts/build-pages.mjs";
import { createDemoRequest } from "../pages/runtime.mjs";
import { createDemoUpstream } from "../lib/demo.mjs";
import { API_BASE, ROUTES } from "../lib/upstream.mjs";

test("public artifact is allowlisted, has an effective static CSP, and resolves every entry asset under /Sesame/", async (t) => {
  const local = fileURLToPath(new URL("../.local/", import.meta.url));
  await mkdir(local, { recursive: true });
  const output = await mkdtemp(join(local, "pages-test-"));
  assert.ok(resolve(output).startsWith(resolve(local) + sep));
  t.after(() => rm(output, { recursive: true, force: true }));
  const files = await buildPages(output);
  assert.equal(
    files.some((file) => /server|credentials|\.env|node_modules/.test(file)),
    false,
  );
  const dom = new JSDOM(await readFile(join(output, "index.html"), "utf8"));
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const policy = document.querySelector(
    'meta[http-equiv="Content-Security-Policy"]',
  ).content;
  for (const directive of [
    "default-src 'none'",
    "connect-src https://granddunman.intelliving.app",
    "form-action 'none'",
    "base-uri 'none'",
    "worker-src 'none'",
  ])
    assert.ok(policy.includes(directive), directive);
  assert.equal(/unsafe-inline|unsafe-eval/.test(policy), false);
  assert.equal(
    document.querySelector('meta[name="referrer"]').content,
    "no-referrer",
  );
  assert.match(
    document.querySelector('meta[name="viewport"]').content,
    /viewport-fit=cover/,
  );
  for (const element of document.querySelectorAll("script[src], link[href]")) {
    const target = new URL(
      element.getAttribute("src") || element.getAttribute("href"),
      "https://lproperty.github.io/Sesame/",
    );
    assert.equal(target.origin, "https://lproperty.github.io");
    assert.ok(target.pathname.startsWith("/Sesame/"));
    assert.ok(files.includes(target.pathname.slice("/Sesame/".length)));
  }
  const version = document.querySelector('meta[name="sesame-build"]').content;
  assert.match(version, /^[a-f0-9]{16}$/);
  assert.equal(
    document.querySelector("script").getAttribute("src"),
    `./pages/entry.js?v=${version}`,
  );
  const built = await import(
    pathToFileURL(join(output, "pages/live.mjs")).href
  );
  const seed = createDemoUpstream();
  const client = built.createLiveRequest({
    fetchImpl: async (url, init) => {
      const operation = Object.keys(ROUTES).find(
        (key) => API_BASE + ROUTES[key] === url,
      );
      assert.ok(operation);
      assert.equal(init.credentials, "omit");
      const headers = new Headers(init.headers);
      const data = await seed(operation, JSON.parse(init.body), {
        token: headers.get("token"),
        unitId: headers.get("unitId"),
        userType: headers.get("userType"),
      });
      return new Response(JSON.stringify({ code: 1200, data }));
    },
  });
  const config = await (await client("/api/config")).json();
  assert.equal(config.demo, false);
  assert.equal(config.browserClient, true);
  assert.equal(
    (
      await client("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phoneOrEmail: "demo", cipher: "demo" }),
      })
    ).status,
    200,
  );
  assert.equal((await (await client("/api/facilities")).json()).length, 11);
  client.dispose();
  const manifest = JSON.parse(
    await readFile(join(output, "site.webmanifest"), "utf8"),
  );
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.display, "standalone");
  await writeFile(join(output, "server.mjs"), "private server placeholder");
  await assert.rejects(verifyPages(output), /allowlist/);
  await rm(join(output, "server.mjs"));
  await writeFile(
    join(output, "pages/entry.js"),
    'import "https://example.com/client.js";',
  );
  await assert.rejects(verifyPages(output), /Unapproved module dependency/);
});

test("Pages bootstrap refuses sign-in inside a frame or an insecure context", async () => {
  const entry = await readFile(
    new URL("../pages/entry.js", import.meta.url),
    "utf8",
  );
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "window",
    "document",
    entry,
  );
  for (const framed of [true, false]) {
    const dom = new JSDOM('<div id="app"></div>');
    const window = { isSecureContext: framed };
    window.self = window;
    window.top = framed ? {} : window;
    await run(window, dom.window.document);
    assert.equal(dom.window.document.querySelector("input"), null);
    assert.match(
      dom.window.document.body.textContent,
      framed ? /directly in a browser tab/ : /over HTTPS/,
    );
    dom.window.close();
  }
});

test("Pages builder refuses to replace source directories or escape the project", async () => {
  await assert.rejects(
    buildPages(fileURLToPath(new URL("../public", import.meta.url))),
    /must be dist/,
  );
  await assert.rejects(
    buildPages(fileURLToPath(new URL("../../outside", import.meta.url))),
    /subdirectory/,
  );
  await assert.rejects(
    buildPages(fileURLToPath(new URL("../.local", import.meta.url))),
    /must be dist/,
  );
});

test("static demo rejects real credentials, foreign requests and profile mutations without network or persistence", async (t) => {
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", () => {
    networkCalls++;
    throw new Error("Network forbidden in the Pages demo");
  });
  const demo = createDemoRequest();
  const post = (path, body) =>
    demo(path, {
      method: "POST",
      headers: { "x-csrf-token": "demo-only" },
      body: JSON.stringify(body),
    });
  assert.equal((await demo("/api/session")).status, 401);
  assert.equal(
    (
      await post("/api/login", {
        phoneOrEmail: "resident@example.com",
        cipher: "not-a-real-password",
      })
    ).status,
    403,
  );
  assert.equal((await demo("https://example.com/api/config")).status, 403);
  assert.equal(
    (await post("/api/login", { phoneOrEmail: "demo", cipher: "demo" })).status,
    200,
  );
  assert.equal(
    (await post("/api/profile/code", { email: "resident@example.com" })).status,
    403,
  );
  assert.equal(
    (await post("/api/profile/complete", { confirm: true })).status,
    403,
  );
  assert.equal(
    (await post("/api/unit", { unitId: "foreign-unit" })).status,
    403,
  );
  assert.equal((await createDemoRequest()("/api/session")).status, 401);
  assert.equal((await post("/api/logout", {})).status, 200);
  assert.equal((await demo("/api/facilities")).status, 401);
  assert.equal(networkCalls, 0);
});
