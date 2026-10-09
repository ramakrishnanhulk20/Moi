// npm run check:leaks: builds the app into .next-verify, then fails if any value from the repo-root
// .env appears anywhere in that output. It prints variable names and counts, never a value.
// Not covered: a value that reaches the output transformed (encoded, split or hashed), and
// variables that are set only in a host's settings rather than in this .env.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const WEB_DIR = fileURLToPath(new URL("../", import.meta.url));
const ROOT_ENV_FILE = fileURLToPath(new URL("../../../.env", import.meta.url));
const DIST_DIR = ".next-verify";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x[0-9a-fA-F]+$/;
// The shortest secret core accepts is 8 characters (env.ts credential), so anything shorter is a
// setting such as a price, a count or a flag, and would match unrelated text by chance.
const MIN_SECRET_CHARS = 8;

// A URL on this machine (http://localhost:3000 for the public origin in local runs) is no secret,
// and Next's own source quotes it in examples.
function isLoopbackUrl(value) {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`check:leaks FAILED: ${message}`);
  process.exit(1);
}

function readEnv() {
  if (!existsSync(ROOT_ENV_FILE)) fail("there is no repo-root .env, so there is nothing to check against.");
  try {
    return parseEnv(readFileSync(ROOT_ENV_FILE, "utf8"));
  } catch {
    fail("the repo-root .env could not be read or parsed.");
  }
}

// Each value is searched for as written. A hex value is also searched for without its 0x and in
// any letter case, since a key can be printed either way.
function needlesFor(env) {
  const checked = [];
  const skipped = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = raw.trim();
    if (value === "") continue;
    if (name.startsWith("NEXT_PUBLIC_")) skipped.push(`${name} (public by design)`);
    else if (ADDRESS.test(value)) skipped.push(`${name} (an address)`);
    else if (value.length < MIN_SECRET_CHARS) skipped.push(`${name} (shorter than ${MIN_SECRET_CHARS} characters)`);
    else if (isLoopbackUrl(value)) skipped.push(`${name} (a loopback URL)`);
    else if (HEX.test(value)) checked.push({ name, exact: null, folded: value.slice(2).toLowerCase() });
    else checked.push({ name, exact: Buffer.from(value, "utf8").toString("latin1"), folded: null });
  }
  return { checked, skipped };
}

function* filesUnder(dir, top = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // WHY: the build's own cache is never deployed, and its packs grow past the longest string
    // Node can hold, which crashed the scan once enough builds had run.
    if (entry.isDirectory() && dir === top && entry.name === "cache") continue;
    if (entry.isDirectory()) yield* filesUnder(path, top);
    else if (entry.isFile()) yield path;
  }
}

function build() {
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
    cwd: WEB_DIR,
    env: { ...process.env, NEXT_DIST_DIR: DIST_DIR },
    stdio: "inherit",
  });
  if (result.status !== 0) fail("the verification build did not finish.");
}

const { checked, skipped } = needlesFor(readEnv());
if (checked.length === 0) fail("the repo-root .env holds no value to check.");
build();

const outDir = join(WEB_DIR, DIST_DIR);
if (!existsSync(outDir)) fail(`the build left no ${DIST_DIR} folder.`);
const hits = new Map();
let files = 0;
for (const file of filesUnder(outDir)) {
  files += 1;
  const text = readFileSync(file).toString("latin1");
  const lower = text.toLowerCase();
  for (const needle of checked) {
    const found = needle.exact !== null ? text.includes(needle.exact) : lower.includes(needle.folded);
    if (found) hits.set(needle.name, (hits.get(needle.name) ?? 0) + 1);
  }
}

if (skipped.length > 0) console.log(`Skipped: ${skipped.join(", ")}.`);
console.log(`Checked ${checked.length} values from the repo-root .env against ${files} files in ${DIST_DIR}.`);
if (hits.size > 0) {
  for (const [name, count] of hits) console.error(`LEAK: the value of ${name} appears in ${count} file(s).`);
  fail(`${hits.size} value(s) found in the build output.`);
}
console.log("No value found. check:leaks passed.");
