import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { normalizeSiteConfig, parseSiteConfig } from "../lib/config.mjs";
import { buildPages } from "../scripts/build-pages.mjs";

test("deployment origin cannot inject CSP directives, redirect credentials or permit arbitrary hosts", () => {
  for (const apiOrigin of [
    "http://estate.example.invalid",
    "https://user:password@estate.example.invalid",
    "https://estate.example.invalid/path",
    "https://estate.example.invalid?origin=evil.invalid",
    "https://estate.example.invalid#fragment",
    "https://estate.example.invalid:8443",
    "https://estate.example.invalid; connect-src *",
    'https://estate.example.invalid\"><script>',
    "https://*.example.invalid",
  ])
    assert.throws(() => normalizeSiteConfig({ apiOrigin }));
  assert.throws(
    () => parseSiteConfig("invalid-sensitive-value"),
    (error) => !error.message.includes("invalid-sensitive-value"),
  );
  assert.throws(() => parseSiteConfig("null"));
  const clean = normalizeSiteConfig({
    apiOrigin: "https://estate.example.invalid",
    token: "do-not-publish",
    password: "do-not-publish",
  });
  assert.equal(JSON.stringify(clean).includes("do-not-publish"), false);
});

test("configured build keeps the source neutral and constrains requests and images to the same deployment origin", async (t) => {
  const sourcePath = new URL("../lib/deployment.mjs", import.meta.url);
  const source = await readFile(sourcePath, "utf8");
  const local = fileURLToPath(new URL("../.local/", import.meta.url));
  await mkdir(local, { recursive: true });
  const output = await mkdtemp(join(local, "config-test-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const config = { apiOrigin: "https://configured.example.invalid" };
  await buildPages(output, config);
  const html = await readFile(join(output, "index.html"), "utf8");
  assert.ok(html.includes("connect-src " + config.apiOrigin));
  assert.ok(html.includes("img-src 'self' " + config.apiOrigin));
  const built = await import(
    pathToFileURL(join(output, "lib/upstream.mjs")).href
  );
  assert.equal(built.API_BASE, config.apiOrigin + "/api");
  const model = await import(pathToFileURL(join(output, "lib/model.mjs")).href);
  assert.equal(
    model.safeImage(config.apiOrigin + "/facility.png"),
    config.apiOrigin + "/facility.png",
  );
  assert.equal(
    model.safeImage("https://other.example.invalid/facility.png"),
    "",
  );
  assert.equal(await readFile(sourcePath, "utf8"), source);
  const firstVersion = /name="sesame-build" content="([^"]+)/.exec(html)[1];
  await buildPages(output, { apiOrigin: "https://changed.example.invalid" });
  const changed = await readFile(join(output, "index.html"), "utf8");
  assert.notEqual(
    /name="sesame-build" content="([^"]+)/.exec(changed)[1],
    firstVersion,
  );
});
