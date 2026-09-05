import { execFileSync } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
if (!files.length)
  throw new Error(
    "Stage the reviewed public files before auditing publication.",
  );
const blocked =
  /(^|\/)(?:\.local|\.git|node_modules|dist|analysis|\.tools|test-results|temp-creds(?:\.[^/]*)?)(\/|$)|\.(?:apk|aab|zip|pem|key|log)$/i;
const secretPattern =
  /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16})/;
let privateValues = [];
const flag = process.argv.indexOf("--credentials-file");
if (flag !== -1) {
  const data = (await readFile(resolve(process.argv[flag + 1]), "utf8")).trim();
  privateValues = data.startsWith("{")
    ? Object.values(JSON.parse(data)).filter(
        (value) => typeof value === "string",
      )
    : data
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) =>
          line
            .replace(/^[a-z][a-z ()_-]*\s*[:=]\s*/i, "")
            .trim()
            .replace(/^(["'`])(.*)\1$/, "$2"),
        );
  if (
    privateValues.length < 2 ||
    privateValues.some((value) => value.length < 4)
  )
    throw new Error("Could not safely compare the private credentials file.");
}
for (const file of files) {
  if (
    blocked.test(file) ||
    (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith(".env.example"))
  )
    throw new Error(`Private or generated path would be published: ${file}`);
  const path = resolve(root, file);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Non-regular public file: ${file}`);
  if (/\.(?:jpg|png|ico)$/i.test(file)) continue;
  const source = await readFile(path, "utf8");
  if (
    secretPattern.test(source) ||
    privateValues.some((value) => source.includes(value))
  )
    throw new Error(
      `Potential credential found in ${file}. Its value has not been logged.`,
    );
}
console.log(
  `Audited ${files.length} tracked public files. No private paths or matched credentials found.`,
);
