import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPages } from "./build-pages.mjs";

const root = fileURLToPath(new URL("../dist", import.meta.url));
await verifyPages(root);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
const server = http.createServer(async (req, res) => {
  if (
    ![
      `localhost:${server.address().port}`,
      `127.0.0.1:${server.address().port}`,
    ].includes(req.headers.host)
  ) {
    res.writeHead(403).end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (["/", "/Sesame"].includes(url.pathname)) {
    res.writeHead(302, { location: "/Sesame/" }).end();
    return;
  }
  try {
    if (
      !["GET", "HEAD"].includes(req.method) ||
      !url.pathname.startsWith("/Sesame/")
    )
      throw new Error();
    const path = resolve(
      root,
      decodeURIComponent(url.pathname.slice(8) || "index.html"),
    );
    if (!path.startsWith(root + sep) || !mime[extname(path)]) throw new Error();
    const data = await readFile(path);
    res.writeHead(200, {
      "content-type": mime[extname(path)],
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res
      .writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      .end("Not found");
  }
});
const port = Number(process.env.PORT || 3213);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT.");
server.listen(port, "127.0.0.1", () =>
  console.log(`Live Pages client: http://127.0.0.1:${port}/Sesame/`),
);
