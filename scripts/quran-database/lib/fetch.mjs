import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_API = "https://api.quran.in.th";
export const SURAH_COUNT = 114;
// The live API answers 500 for limit=100 on large surahs; 50 works.
export const PAGE_LIMIT = 50;
const REQUEST_DELAY_MS = 150;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// The API is edge-cached for up to an hour; a unique query parameter forces a fresh read.
export function cacheBustedUrl(url, token = randomUUID()) {
  const parsed = new URL(url);
  parsed.searchParams.set("_cb", token);
  return parsed.toString();
}

export async function fetchJson(
  url,
  { fetchImpl = fetch, delayMs = REQUEST_DELAY_MS, wait = sleep } = {},
) {
  for (let attempt = 1; ; attempt++) {
    await wait(delayMs);
    try {
      const response = await fetchImpl(cacheBustedUrl(url));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS)
        throw new Error(
          `GET ${url} failed after ${attempt} attempts: ${error.message}`,
        );
      await wait(1000 * attempt);
    }
  }
}

export function normalizeSource(raw) {
  return {
    id: raw.id,
    name: raw.name,
    shortName: raw.short_name ?? null,
    author: raw.author ?? null,
    language: raw.language,
    description: raw.description ?? null,
  };
}

/** Converts one surah API payload (all pages merged into `verses`) to the exporter's model. */
export function normalizeSurah(data, verses) {
  return {
    id: data.id,
    versesCount: data.verses_count,
    verses: verses.map((verse) => ({
      sura: data.id,
      aya: verse.verseNumber,
      arabic: verse.content,
      translation: verse.translation,
      footnotes: (verse.footnotes ?? []).map((note) => ({
        number: note.number,
        text: note.text,
      })),
    })),
  };
}

export async function fetchSurah(api, surahId, sourceId, options = {}) {
  const verses = [];
  let first;
  for (;;) {
    const url = `${api}/surahs/${surahId}?sourceId=${sourceId}&offset=${verses.length}&limit=${PAGE_LIMIT}`;
    const body = await fetchJson(url, options);
    if (!body?.success || !body.data)
      throw new Error(`GET ${url} returned no data`);
    first ??= body.data;
    verses.push(...body.data.verses);
    if (!body.data.pagination?.hasMore) return normalizeSurah(first, verses);
    if (body.data.verses.length === 0)
      throw new Error(`GET ${url} reported more pages but returned none`);
  }
}

export async function fetchSourceSurahs(
  api,
  sourceId,
  { concurrency = 4, surahCount = SURAH_COUNT, ...options } = {},
) {
  const surahs = new Array(surahCount);
  let next = 0;
  const worker = async () => {
    while (next < surahCount) {
      const index = next++;
      surahs[index] = await fetchSurah(api, index + 1, sourceId, options);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return surahs;
}

export async function fetchSources(api, options = {}) {
  const body = await fetchJson(`${api}/translation-sources`, options);
  if (!body?.success || !Array.isArray(body.data))
    throw new Error("translation-sources returned no data");
  return body.data.map(normalizeSource);
}

/**
 * Offline input with the API's own JSON shapes:
 *   <dir>/translation-sources.json
 *   <dir>/surahs/<sourceId>/<surahId>.json   (one complete page, hasMore false)
 */
export function loadFixture(dir, sourceIds) {
  const sources = JSON.parse(
    readFileSync(join(dir, "translation-sources.json"), "utf8"),
  ).data.map(normalizeSource);
  const surahsBySource = {};
  for (const sourceId of sourceIds) {
    const sourceDir = join(dir, "surahs", String(sourceId));
    const files = readdirSync(sourceDir)
      .filter((name) => /^\d+\.json$/.test(name))
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    surahsBySource[sourceId] = files.map((name) => {
      const body = JSON.parse(readFileSync(join(sourceDir, name), "utf8"));
      if (body.data.pagination?.hasMore)
        throw new Error(`${sourceDir}/${name} must hold the whole surah`);
      return normalizeSurah(body.data, body.data.verses);
    });
  }
  return { sources, surahsBySource };
}
