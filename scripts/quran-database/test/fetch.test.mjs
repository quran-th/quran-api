import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cacheBustedUrl,
  fetchJson,
  fetchSourceSurahs,
  fetchSurah,
} from "../lib/fetch.mjs";

const noWait = async () => {};
const respond = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});

test("cacheBustedUrl adds a unique _cb parameter and keeps the rest", () => {
  const url = cacheBustedUrl(
    "https://api.example/surahs/2?sourceId=3&offset=0&limit=50",
    "abc",
  );
  assert.equal(
    url,
    "https://api.example/surahs/2?sourceId=3&offset=0&limit=50&_cb=abc",
  );
  assert.notEqual(
    cacheBustedUrl("https://api.example/x"),
    cacheBustedUrl("https://api.example/x"),
  );
});

test("fetchJson retries failures up to three attempts", async () => {
  let calls = 0;
  const flaky = async () =>
    ++calls < 3 ? respond(null, 500) : respond({ ok: true });
  assert.deepEqual(
    await fetchJson("https://api.example/x", {
      fetchImpl: flaky,
      wait: noWait,
    }),
    { ok: true },
  );
  assert.equal(calls, 3);
  calls = 0;
  const broken = async () => {
    calls++;
    return respond(null, 500);
  };
  await assert.rejects(
    fetchJson("https://api.example/x", { fetchImpl: broken, wait: noWait }),
    /failed after 3 attempts: HTTP 500/,
  );
  assert.equal(calls, 3);
});

test("fetchSurah follows pagination with limit 50 and a cache buster on every request", async () => {
  const requested = [];
  const all = Array.from({ length: 120 }, (_, index) => ({
    verseNumber: index + 1,
    content: "ع",
    translation: `ข้อ ${index + 1}`,
    footnotes: index === 0 ? [{ number: 1, text: "เชิงอรรถ" }] : [],
  }));
  const fake = async (url) => {
    requested.push(url);
    const params = new URL(url).searchParams;
    const offset = Number(params.get("offset"));
    const limit = Number(params.get("limit"));
    const verses = all.slice(offset, offset + limit);
    return respond({
      success: true,
      data: {
        id: 2,
        verses_count: 120,
        verses,
        pagination: {
          offset,
          limit,
          total: 120,
          hasMore: offset + limit < 120,
        },
      },
    });
  };
  const surah = await fetchSurah("https://api.example", 2, 3, {
    fetchImpl: fake,
    wait: noWait,
  });
  assert.equal(surah.verses.length, 120);
  assert.equal(surah.versesCount, 120);
  assert.deepEqual(surah.verses[0], {
    surah: 2,
    ayah: 1,
    arabic: "ع",
    translation: "ข้อ 1",
    footnotes: [{ number: 1, text: "เชิงอรรถ" }],
  });
  assert.deepEqual(
    requested.map((url) => new URL(url).searchParams.get("offset")),
    ["0", "50", "100"],
  );
  assert.ok(
    requested.every((url) => new URL(url).searchParams.get("limit") === "50"),
  );
  assert.equal(
    new Set(requested.map((url) => new URL(url).searchParams.get("_cb"))).size,
    3,
  );
});

test("fetchSourceSurahs returns surahs in order whatever the completion order", async () => {
  const fake = async (url) => {
    const id = Number(new URL(url).pathname.split("/").pop());
    await new Promise((done) => setTimeout(done, (5 - id) * 2));
    return respond({
      success: true,
      data: {
        id,
        verses_count: 1,
        verses: [
          { verseNumber: 1, content: "ع", translation: "ก", footnotes: [] },
        ],
        pagination: { hasMore: false },
      },
    });
  };
  const surahs = await fetchSourceSurahs("https://api.example", 3, {
    surahCount: 5,
    concurrency: 4,
    fetchImpl: fake,
    wait: noWait,
  });
  assert.deepEqual(
    surahs.map((surah) => surah.id),
    [1, 2, 3, 4, 5],
  );
});
