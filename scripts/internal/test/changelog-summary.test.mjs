import assert from "node:assert/strict";
import { timingSafeEqual, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDir = fileURLToPath(new URL("../../..", import.meta.url));
const KEY = "test-internal-key";
const dir = mkdtempSync(join(tmpdir(), "internal-route-"));
let internal;
let app;

// Minimal D1 stand-in over node:sqlite; the route only uses prepare/bind/first.
function d1(sqlite) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => sqlite.prepare(sql).run(...params),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
  });
  return { prepare: (sql) => stmt(sql) };
}

// workerd provides crypto.subtle.timingSafeEqual; Node does not.
webcrypto.subtle.timingSafeEqual ??= (a, b) =>
  timingSafeEqual(new Uint8Array(a), new Uint8Array(b));

before(async () => {
  const outfile = join(dir, "internal.mjs");
  await build({
    entryPoints: [join(apiDir, "src/routes/internal.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  internal = (await import(pathToFileURL(outfile).href)).default;

  const appFile = join(dir, "app.mjs");
  await build({
    entryPoints: [join(apiDir, "src/index.ts")],
    outfile: appFile,
    bundle: true,
    // The verse-words fallback globs a data dir that is not in the repo; it is never hit here.
    plugins: [
      {
        name: "stub-word-data",
        setup: (b) =>
          b.onLoad({ filter: /src[\\/]index\.ts$/ }, async (a) => ({
            contents: (await readFile(a.path, "utf8")).replace(
              /import\(`\.\.\/data\/quran-words\/[^`]*`\)/,
              "Promise.reject(new Error('quran-words data not bundled'))",
            ),
            loader: "ts",
          })),
      },
    ],
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  app = (await import(pathToFileURL(appFile).href)).default;
});

after(() => rmSync(dir, { recursive: true, force: true }));

function seeded(rows) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    translation_id INTEGER,
    old_text TEXT NOT NULL,
    new_text TEXT NOT NULL,
    version_tag TEXT NOT NULL,
    changed_at INTEGER
  )`);
  const insert = sqlite.prepare(
    "INSERT INTO changelog (id, old_text, new_text, version_tag) VALUES (?, 'a', 'b', 'v1')",
  );
  for (const id of rows) insert.run(id);
  return { DB: d1(sqlite), INTERNAL_KEY: KEY, JWT_SECRET: "s" };
}

test("GET /changelog/summary returns 401 without the internal key", async () => {
  const res = await internal.request("/changelog/summary", {}, seeded([1]));
  assert.equal(res.status, 401);
});

test("GET /changelog/summary returns 401 with a wrong key", async () => {
  const res = await internal.request(
    "/changelog/summary",
    { headers: { "X-Internal-Key": "nope" } },
    seeded([1]),
  );
  assert.equal(res.status, 401);
});

test("GET /changelog/summary returns maxId and count for seeded rows", async () => {
  const res = await internal.request(
    "/changelog/summary",
    { headers: { "X-Internal-Key": KEY } },
    seeded([3, 7, 12]),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, maxId: 12, count: 3 });
});

test("GET /changelog/summary returns zeros for an empty table", async () => {
  const res = await internal.request(
    "/changelog/summary",
    { headers: { "X-Internal-Key": KEY } },
    seeded([]),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true, maxId: 0, count: 0 });
});

// A D1 stand-in that records any use, to prove rejected requests never touch the DB.
function spyEnv(extra) {
  const touched = [];
  const DB = {
    prepare: (sql) => {
      touched.push(sql);
      throw new Error("DB must not be touched");
    },
  };
  return { env: { DB, JWT_SECRET: "s", ...extra }, touched };
}

for (const [label, extra] of [
  ["unset", {}],
  ["empty", { INTERNAL_KEY: "" }],
]) {
  test(`INTERNAL_KEY ${label}: 401 and DB untouched, even with a key header`, async () => {
    for (const header of ["", "anything"]) {
      const { env, touched } = spyEnv(extra);
      const res = await internal.request(
        "/changelog/summary",
        { headers: { "X-Internal-Key": header } },
        env,
      );
      assert.equal(res.status, 401);
      assert.equal(touched.length, 0);
    }
  });
}

test("responses carry Cache-Control: no-store on 200 and 401", async () => {
  const ok = await internal.request(
    "/changelog/summary",
    { headers: { "X-Internal-Key": KEY } },
    seeded([1]),
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");

  const denied = await internal.request("/changelog/summary", {}, seeded([1]));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("Cache-Control"), "no-store");
});

test("mounted app: /internal preflight gets no CORS grant, public routes keep cors()", async () => {
  const preflight = (path) =>
    app.request(
      path,
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "x-internal-key",
        },
      },
      seeded([1]),
    );

  const internalRes = await preflight("/internal/changelog/summary");
  const allowHeaders = internalRes.headers.get("Access-Control-Allow-Headers");
  assert.ok(!(allowHeaders ?? "").toLowerCase().includes("x-internal-key"));
  assert.notEqual(internalRes.headers.get("Access-Control-Allow-Origin"), "*");

  const publicRes = await preflight("/surahs");
  assert.equal(publicRes.headers.get("Access-Control-Allow-Origin"), "*");
});

test("mounted app: /doc does not expose /internal routes", async () => {
  const res = await app.request("/doc", {}, seeded([1]));
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes("/internal/"));
});

test("mounted app: /internal still enforces the key", async () => {
  const res = await app.request("/internal/changelog/summary", {}, seeded([1]));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});
