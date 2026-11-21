import assert from "node:assert/strict";
import { timingSafeEqual, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const apiDir = fileURLToPath(new URL("../../..", import.meta.url));
const KEY = "test-internal-key";
const headers = { "X-Internal-Key": KEY };
const dir = mkdtempSync(join(tmpdir(), "internal-reports-"));
let internal;

function d1(sqlite) {
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
    run: async () => sqlite.prepare(sql).run(...params),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
  });
  return { prepare: (sql) => stmt(sql) };
}

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
});

after(() => rmSync(dir, { recursive: true, force: true }));

function seeded(reports = []) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE translation_sources (id INTEGER PRIMARY KEY, is_default INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE verse_translations (
      id INTEGER PRIMARY KEY, source_id INTEGER, surah_number INTEGER,
      verse_number INTEGER, translation_text TEXT
    );
    CREATE TABLE issue_reports (
      id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, report_type TEXT NOT NULL DEFAULT 'quick',
      suggested_text TEXT, contact_name TEXT, user_id INTEGER, status TEXT NOT NULL DEFAULT 'open',
      source_id INTEGER, surah_number INTEGER, verse_number INTEGER,
      verse_translation_id INTEGER, created_at INTEGER
    );
    INSERT INTO translation_sources (id, is_default) VALUES (1, 0), (2, 1);
    INSERT INTO verse_translations VALUES
      (10, 1, 1, 1, 'src1 v1:1'),
      (20, 2, 1, 1, 'src2 v1:1'),
      (21, 2, 1, 2, 'src2 v1:2');
  `);
  const insert = sqlite.prepare(
    `INSERT INTO issue_reports
     (id, fingerprint, report_type, suggested_text, contact_name, user_id, status,
      source_id, surah_number, verse_number, verse_translation_id, created_at)
     VALUES (@id, @fingerprint, @reportType, @suggestedText, @contactName, @userId, @status,
      @sourceId, @surahNumber, @verseNumber, @verseTranslationId, @createdAt)`,
  );
  for (const r of reports) {
    insert.run({
      fingerprint: "secret-fp",
      reportType: "detailed",
      suggestedText: "fix",
      contactName: null,
      userId: 99,
      status: "open",
      sourceId: null,
      surahNumber: 1,
      verseNumber: 1,
      verseTranslationId: null,
      createdAt: r.id,
      ...r,
    });
  }
  return {
    env: { DB: d1(sqlite), INTERNAL_KEY: KEY, JWT_SECRET: "s" },
    sqlite,
  };
}

const get = (path, env) => internal.request(path, { headers }, env);
const put = (path, body, env) =>
  internal.request(
    path,
    {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );

test("GET /reports and PUT /reports/{id}/status return 401 without the key", async () => {
  const { env } = seeded([{ id: 1 }]);
  assert.equal((await internal.request("/reports", {}, env)).status, 401);
  const res = await internal.request(
    "/reports/1/status",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    },
    env,
  );
  assert.equal(res.status, 401);
});

test("GET /reports excludes quick reports and empty or whitespace suggestions", async () => {
  const { env } = seeded([
    { id: 1 },
    { id: 2, reportType: "quick" },
    { id: 3, suggestedText: "" },
    { id: 4, suggestedText: "  \n\t " },
    { id: 5, suggestedText: null },
  ]);
  const body = await (await get("/reports", env)).json();
  assert.deepEqual(
    body.data.map((r) => r.id),
    [1],
  );
});

test("GET /reports filters by status, defaulting to open", async () => {
  const { env } = seeded([
    { id: 1 },
    { id: 2, status: "resolved" },
    { id: 3, status: "dismissed" },
  ]);
  const ids = async (q) =>
    (await (await get(`/reports${q}`, env)).json()).data.map((r) => r.id);
  assert.deepEqual(await ids(""), [1]);
  assert.deepEqual(await ids("?status=resolved"), [2]);
  assert.deepEqual(await ids("?status=dismissed"), [3]);
  assert.equal((await get("/reports?status=bogus", env)).status, 400);
});

test("GET /reports returns oldest first and honours limit", async () => {
  const { env } = seeded([
    { id: 1, createdAt: 300 },
    { id: 2, createdAt: 100 },
    { id: 3, createdAt: 200 },
  ]);
  const ids = async (q) =>
    (await (await get(`/reports${q}`, env)).json()).data.map((r) => r.id);
  assert.deepEqual(await ids(""), [2, 3, 1]);
  assert.deepEqual(await ids("?limit=2"), [2, 3]);
  assert.equal((await get("/reports?limit=0", env)).status, 400);
  assert.equal((await get("/reports?limit=101", env)).status, 400);
});

test("GET /reports falls back to the default source when sourceId is null", async () => {
  const { env } = seeded([{ id: 1 }, { id: 2, sourceId: 1 }]);
  const { data } = await (await get("/reports", env)).json();
  assert.equal(data[0].sourceId, 2);
  assert.equal(data[0].currentText, "src2 v1:1");
  assert.equal(data[1].sourceId, 1);
  assert.equal(data[1].currentText, "src1 v1:1");
});

test("GET /reports looks up currentText by verseTranslationId or by source/surah/verse", async () => {
  const { env } = seeded([
    { id: 1, verseTranslationId: 10, sourceId: 2 },
    { id: 2, verseNumber: 2 },
    { id: 3, verseNumber: 7 },
  ]);
  const { data } = await (await get("/reports", env)).json();
  assert.equal(data[0].currentText, "src1 v1:1");
  assert.equal(data[1].currentText, "src2 v1:2");
  assert.equal(data[2].currentText, null);
});

test("GET /reports does not leak fingerprint or user data", async () => {
  const { env } = seeded([{ id: 1, contactName: "Ali" }]);
  const res = await get("/reports", env);
  const text = await res.text();
  assert.ok(!text.includes("secret-fp"));
  assert.ok(!/fingerprint|userId|user_id|"99"/i.test(text));
  assert.deepEqual(Object.keys(JSON.parse(text).data[0]).sort(), [
    "contactName",
    "createdAt",
    "currentText",
    "id",
    "sourceId",
    "suggestedText",
    "surahNumber",
    "verseNumber",
    "verseTranslationId",
  ]);
});

test("PUT /reports/{id}/status resolves an open report", async () => {
  const { env, sqlite } = seeded([{ id: 1 }]);
  const res = await put("/reports/1/status", { status: "resolved" }, env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: true,
    id: 1,
    status: "resolved",
  });
  assert.equal(
    sqlite.prepare("SELECT status FROM issue_reports WHERE id = 1").get()
      .status,
    "resolved",
  );
});

test("PUT /reports/{id}/status returns 404 for an unknown id", async () => {
  const { env } = seeded([{ id: 1 }]);
  const res = await put("/reports/42/status", { status: "dismissed" }, env);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).success, false);
});

test("PUT /reports/{id}/status returns 409 when the report is no longer open", async () => {
  const { env, sqlite } = seeded([{ id: 1, status: "resolved" }]);
  const res = await put("/reports/1/status", { status: "dismissed" }, env);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).success, false);
  assert.equal(
    sqlite.prepare("SELECT status FROM issue_reports WHERE id = 1").get()
      .status,
    "resolved",
  );
});

test("PUT /reports/{id}/status is idempotent for a same-status retry", async () => {
  const { env } = seeded([{ id: 1 }]);
  assert.equal(
    (await put("/reports/1/status", { status: "dismissed" }, env)).status,
    200,
  );
  const retry = await put("/reports/1/status", { status: "dismissed" }, env);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    success: true,
    id: 1,
    status: "dismissed",
  });
});

test("PUT /reports/{id}/status rejects invalid status values", async () => {
  const { env } = seeded([{ id: 1 }]);
  assert.equal(
    (await put("/reports/1/status", { status: "open" }, env)).status,
    400,
  );
});
