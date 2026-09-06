import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  rm,
  lstat,
  readdir,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { SITE_CONFIG, normalizeSiteConfig } from "../lib/config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PAGE_FILES = Object.freeze([
  "app.js",
  "entry-pass.js",
  "pass-store.js",
  "payment-qr.js",
  "vendor/qrcode.mjs",
  "vendor/QR-LICENSE.txt",
  "styles.css",
  "site.webmanifest",
  "assets/favicon.svg",
  "assets/apple-touch-icon-home.png",
  "assets/icon-home-192.png",
  "assets/icon-home-512.png",
  "assets/estate.jpg",
  "assets/tennis.png",
  "assets/function-room.png",
  "assets/games.png",
  "assets/bbq.png",
  "assets/music.png",
  "pages/entry.js",
  "pages/live.mjs",
  "pages/runtime.mjs",
  "lib/errors.mjs",
  "lib/model.mjs",
  "lib/demo.mjs",
  "lib/portal.mjs",
  "lib/upstream.mjs",
  "lib/config.mjs",
  "lib/deployment.mjs",
]);
export const pagePolicy = (config = SITE_CONFIG) =>
  [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' ${normalizeSiteConfig(config).apiOrigin}`,
    "font-src 'none'",
    `connect-src ${normalizeSiteConfig(config).apiOrigin}`,
    "worker-src 'none'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

// Only a resolved directory within this project may be replaced. Do not follow
// symlinked ancestors or source files when collecting a public artifact.
async function checkOutput(output) {
  const child = relative(root, output);
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw new Error("The Pages output must be a subdirectory of this project.");
  if (child !== "dist" && !child.startsWith(".local" + sep))
    throw new Error("The Pages output must be dist or inside .local.");
  for (let current = output; current !== root; current = dirname(current)) {
    const info = await lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink())
      throw new Error("Pages output cannot follow symlinks.");
  }
}

async function inventory(directory, prefix = "") {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink())
      throw new Error("Pages artifacts cannot contain symlinks.");
    const name = prefix + item.name;
    if (item.isDirectory())
      files.push(...(await inventory(join(directory, item.name), name + "/")));
    else if (item.isFile()) files.push(name);
    else throw new Error("Unexpected artifact entry.");
  }
  return files.sort();
}

export async function verifyPages(
  output = join(root, "dist"),
  config = SITE_CONFIG,
) {
  output = resolve(output);
  await checkOutput(output);
  const policy = pagePolicy(config);
  const expected = [
    ...PAGE_FILES,
    "index.html",
    "404.html",
    ".nojekyll",
  ].sort();
  const actual = await inventory(output);
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      "The Pages artifact does not match its explicit file allowlist.",
    );
  const html = await readFile(join(output, "index.html"), "utf8");
  if (
    !html.includes(`content="${policy}"`) ||
    !/src="\.\/pages\/entry\.js\?v=[a-f0-9]{16}"/.test(html)
  )
    throw new Error("The Pages entry point or security policy is missing.");
  for (const file of actual.filter((name) =>
    /\.(?:js|mjs|html|css|webmanifest)$/.test(name),
  )) {
    const source = await readFile(join(output, file), "utf8");
    if (
      /node:|temp-creds|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(
        source,
      )
    )
      throw new Error(`Private or server-only content found in ${file}.`);
    // Every executable module dependency must resolve to another allowlisted file.
    const imports = [
      ...source.matchAll(
        /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g,
      ),
    ];
    for (const [, specifier] of imports) {
      const dependencyUrl = new URL(
        specifier,
        `https://sesame.invalid/${file}`,
      );
      const dependency = dependencyUrl.pathname.slice(1);
      if (
        !specifier.startsWith(".") ||
        dependencyUrl.origin !== "https://sesame.invalid" ||
        dependencyUrl.hash ||
        !/^\?v=[a-f0-9]{16}$/.test(dependencyUrl.search) ||
        !actual.includes(dependency)
      )
        throw new Error(`Unapproved module dependency in ${file}.`);
    }
  }
  return actual;
}

export async function buildPages(
  output = join(root, "dist"),
  config = SITE_CONFIG,
) {
  output = resolve(output);
  await checkOutput(output);
  config = normalizeSiteConfig(config);
  const policy = pagePolicy(config);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const file of PAGE_FILES) {
    const source = join(
      root,
      file.startsWith("lib/") || file.startsWith("pages/")
        ? file
        : "public/" + file,
    );
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Invalid public source: ${file}`);
    const destination = join(output, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await writeFile(
    join(output, "lib/deployment.mjs"),
    `export default ${JSON.stringify(config)};\n`,
  );
  let html = await readFile(join(root, "public/index.html"), "utf8");
  const digest = createHash("sha256").update(policy).update(html);
  for (const file of PAGE_FILES)
    digest.update(file).update(await readFile(join(output, file)));
  const version = digest.digest("hex").slice(0, 16);
  for (const file of PAGE_FILES.filter((name) => /\.(?:js|mjs)$/.test(name))) {
    const path = join(output, file);
    const code = await readFile(path, "utf8");
    await writeFile(
      path,
      code.replace(
        /((?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["'])(\.[^"']+)(["'])/g,
        (_, before, specifier, after) =>
          `${before}${specifier}?v=${version}${after}`,
      ),
    );
  }
  html = html
    .replace(
      '<meta charset="utf-8" />',
      `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />\n    <meta name="sesame-build" content="${version}" />`,
    )
    .replace('src="./app.js"', 'src="./pages/entry.js"')
    .replace(
      /((?:src|href)=")(\.\/[^"?]+)(")/g,
      (_, before, path, after) => `${before}${path}?v=${version}${after}`,
    );
  await writeFile(join(output, "index.html"), html);
  await writeFile(join(output, ".nojekyll"), "");
  await writeFile(
    join(output, "404.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><title>Page not found · Sesame</title></head>
<body><main><h1>This page has moved.</h1><p><a href="https://lproperty.github.io/Sesame/">Open Sesame</a></p></main></body></html>\n`,
  );
  return verifyPages(output, config);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (
    process.argv.includes("--live") &&
    (!process.env.SESAME_SITE_CONFIG ||
      SITE_CONFIG.apiOrigin.endsWith(".invalid") ||
      !SITE_CONFIG.payment)
  )
    throw new Error(
      "Live deployment requires the estate API and payment settings in SESAME_SITE_CONFIG.",
    );
  const files = await buildPages();
  console.log(
    `Built and verified ${files.length} website files in dist. The browser connects directly to the estate API; no credentials are included.`,
  );
}
