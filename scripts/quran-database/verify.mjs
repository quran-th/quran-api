import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  embeddedLineBreaks,
  formatCanonical,
  formatCanonicalRows,
  joinSurahTexts,
  parseCanonical,
  parseCanonicalRows,
  surahFileName,
  toCanonicalRows,
} from "./lib/canonical.mjs";
import {
  OVERRIDES_FILE,
  importDatabaseModule,
  resolveDatabaseDir,
} from "./lib/database.mjs";
import { parseChanges } from "./lib/diff.mjs";
import {
  legacyCsvPath,
  metaPath,
  sha256,
  surahDir,
} from "./lib/metadata.mjs";
import { parseOverrides } from "./lib/notes.mjs";
import { EXPECTED_COUNTS, validateSource } from "./lib/validate.mjs";

const CONVERTER_MODULES = [
  "convert.mjs",
  "quranenc.mjs",
  "tanzil.mjs",
  "qurancom.mjs",
  "markers.mjs",
];

/** The data repository's converter modules, used to read back what its CLI wrote. */
async function loadConverter(rootDir) {
  const modules = await Promise.all(
    CONVERTER_MODULES.map((name) => importDatabaseModule(rootDir, name)),
  );
  return Object.assign({}, ...modules);
}

function listFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(join(dir, entry.name), relative)
      : [relative];
  });
}

function checkOrder(verses, expected, fail) {
  verses.forEach((verse, index) => {
    const previous = verses[index - 1];
    const contiguous =
      previous && previous.surah === verse.surah
        ? verse.ayah === previous.ayah + 1
        : verse.ayah === 1 && (!previous || verse.surah > previous.surah);
    if (!contiguous)
      fail(`CSV verse ${verse.surah}:${verse.ayah} breaks mushaf order`);
  });
  const surahNumbers = [...new Set(verses.map((verse) => verse.surah))];
  if (surahNumbers.length !== expected.surahs)
    fail(`CSV has ${surahNumbers.length} surahs, expected ${expected.surahs}`);
  if (
    expected.contiguousSurahs !== false &&
    surahNumbers.some((surah, index) => surah !== index + 1)
  )
    fail("CSV surahs are not 1..N");
  if (verses.length !== expected.verses)
    fail(`CSV has ${verses.length} verses, expected ${expected.verses}`);
}

function checkQuranEnc(text, verses, lib, fail) {
  const records = lib.readQuranEncCsv(text);
  if (records.length !== verses.length)
    fail(`quranenc has ${records.length} rows, expected ${verses.length}`);
  verses.forEach((verse, index) => {
    const record = records[index];
    if (!record) return;
    const expected = {
      id: String(index + 1),
      sura: String(verse.surah),
      aya: String(verse.ayah),
      translation: verse.translation,
      footnotes: lib.quranEncFootnotes(verse.footnotes),
    };
    if (!isDeepStrictEqual(record, expected))
      fail(`quranenc row ${index + 2} differs from ${verse.surah}:${verse.ayah}`);
  });
}

function checkTanzil(text, verses, meta, lib, fail) {
  const tanzil = lib.readTanzil(text);
  if (tanzil.verses.length !== verses.length)
    fail(
      `tanzil has ${tanzil.verses.length} verse lines, expected ${verses.length}`,
    );
  const pipes = text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.split("|").length - 1);
  if (pipes.some((count) => count !== 2))
    fail("tanzil has a verse line without exactly 2 pipes");
  verses.forEach((verse, index) => {
    const line = tanzil.verses[index];
    if (!line) return;
    if (line.surah !== verse.surah || line.ayah !== verse.ayah)
      fail(`tanzil line ${index + 1} is ${line.surah}|${line.ayah}`);
    if (line.text !== lib.tanzilText(verse.translation).text)
      fail(`tanzil ${verse.surah}:${verse.ayah} text differs from the CSV`);
  });
  if (
    tanzil.trailer.length !== 10 ||
    !tanzil.trailer.includes(
      `#  ID: ${meta.source.language}.${meta.source.slug}`,
    )
  )
    fail("tanzil trailer is not the expected 10-line block");
}

function checkQuranCom(text, verses, meta, lib, fail) {
  const document = JSON.parse(text);
  const sourceId = meta.source.id;
  if (document.meta?.slug !== meta.source.slug)
    fail("quran-com meta.slug does not match");
  if (document.translations?.length !== verses.length)
    fail(
      `quran-com has ${document.translations?.length} translations, expected ${verses.length}`,
    );
  verses.forEach((verse, index) => {
    const item = document.translations?.[index];
    const ref = `${verse.surah}:${verse.ayah}`;
    if (!item) return;
    if (item.verse_key !== ref || item.resource_id !== sourceId)
      fail(
        `quran-com item ${index} is ${item.verse_key}/${item.resource_id}, expected ${ref}/${sourceId}`,
      );
    if (lib.restoreMarkers(item.text) !== verse.translation)
      fail(`quran-com ${ref} text does not restore to the CSV text`);
    const expectedNotes = Object.fromEntries(
      verse.footnotes.map((note) => [
        String(lib.footnoteId(sourceId, verse.surah, verse.ayah, note.number)),
        note.text,
      ]),
    );
    if (!isDeepStrictEqual(item.foot_notes, expectedNotes))
      fail(`quran-com ${ref} foot_notes differ from the CSV`);
    for (const sup of lib.supFootnoteIds(item.text)) {
      if (
        sup.id !==
          lib.footnoteId(sourceId, verse.surah, verse.ayah, sup.number) ||
        !(String(sup.id) in item.foot_notes)
      )
        fail(`quran-com ${ref} has a dangling <sup foot_note=${sup.id}>`);
    }
  });
}

/** Checks the generic JSON and that canonical -> json -> canonical gives the same CSV bytes. */
function checkJson(text, verses, csv, meta, fail) {
  const document = JSON.parse(text);
  if (
    document.meta?.sourceId !== meta.source.id ||
    document.meta?.slug !== meta.source.slug
  )
    fail("JSON meta does not match meta.json");
  const keys = Object.keys(document.verses ?? {});
  if (keys.length !== verses.length)
    fail(`JSON has ${keys.length} verses, expected ${verses.length}`);
  const back = keys.map((key) => {
    const [surah, ayah] = key.split(":").map(Number);
    return {
      surah,
      ayah,
      translation: document.verses[key].translation,
      footnotes: document.verses[key].footnotes,
    };
  });
  if (formatCanonicalRows(toCanonicalRows(back)) !== csv)
    fail("round trip canonical -> json -> canonical differs");
}

const SURAH_FILE = /^\d{3}\.csv$/;

/**
 * Checks data/<slug>/NNN.csv one by one (name, canonical form, every row in its own surah's file)
 * and returns the joined whole-translation CSV, or null when the files cannot be joined.
 */
function readSurahFiles(rootDir, slug, fail) {
  const dir = surahDir(slug);
  const names = readdirSync(join(rootDir, dir)).sort();
  for (const name of names)
    if (!SURAH_FILE.test(name))
      fail(`${dir}/${name} is not a surah file (NNN.csv)`);
  const surahNames = names.filter((name) => SURAH_FILE.test(name));
  if (surahNames.length === 0) {
    fail(`${dir} has no surah files`);
    return null;
  }
  const texts = surahNames.map((name) => {
    const text = readFileSync(join(rootDir, dir, name), "utf8");
    try {
      const rows = parseCanonicalRows(text);
      if (rows.length === 0) fail(`${dir}/${name} has no rows`);
      const stray = rows.find((row) => surahFileName(row.surah) !== name);
      if (stray)
        fail(
          `${dir}/${name} holds a row of surah ${stray.surah} (${stray.surah}:${stray.ayah})`,
        );
      if (formatCanonicalRows(rows) !== text)
        fail(
          `${dir}/${name} is not in canonical form (quoting, order or line endings)`,
        );
    } catch (error) {
      fail(`${dir}/${name}: ${error.message}`);
    }
    return text;
  });
  try {
    return joinSurahTexts(texts);
  } catch (error) {
    fail(`${dir}: ${error.message}`);
    return null;
  }
}

/**
 * `converted` is the data repository's converter output ({ outDir, lib }), or null when the
 * converter could not run.
 * @returns {string[]} problems found for one source; empty when consistent
 */
export function verifySource(
  rootDir,
  slug,
  expected = EXPECTED_COUNTS,
  converted = null,
) {
  const problems = [];
  const fail = (message) => problems.push(`${slug}: ${message}`);
  const meta = JSON.parse(readFileSync(join(rootDir, metaPath(slug)), "utf8"));
  if (meta.source?.slug !== slug)
    fail(`meta.json source.slug is ${meta.source?.slug}`);
  const csv = readSurahFiles(rootDir, slug, fail);
  if (csv === null) return problems;
  const actualHash = sha256(csv);
  if (actualHash !== meta.sha256)
    fail(
      `sha256 of the joined ${surahDir(slug)}/*.csv is ${actualHash}, meta.json says ${meta.sha256}`,
    );

  let verses;
  try {
    verses = parseCanonical(csv);
  } catch (error) {
    fail(`CSV: ${error.message}`);
    return problems;
  }
  if (formatCanonical(verses) !== csv)
    fail("CSV is not in canonical form (quoting, order or line endings)");
  checkOrder(verses, expected, fail);
  const footnoteCount = verses.reduce(
    (count, verse) => count + verse.footnotes.length,
    0,
  );
  if (verses.length !== meta.verseCount)
    fail(`CSV has ${verses.length} verses, meta.json says ${meta.verseCount}`);
  if (footnoteCount !== meta.footnoteCount)
    fail(
      `CSV has ${footnoteCount} footnotes, meta.json says ${meta.footnoteCount}`,
    );
  if (!isDeepStrictEqual(embeddedLineBreaks(verses), meta.embeddedLineBreaks))
    fail("embeddedLineBreaks differs from the CSV");
  const surahs = [...new Set(verses.map((verse) => verse.surah))].map((id) => {
    const surahVerses = verses
      .filter((verse) => verse.surah === id)
      .map((verse) => ({ ...verse, arabic: "-" }));
    return { id, versesCount: surahVerses.length, verses: surahVerses };
  });
  const recorded = validateSource(meta.source.id, surahs, {
    expected: { ...expected, contiguousSurahs: false },
    allowEmpty: true,
    allowFootnoteMismatch: true,
  });
  if (!isDeepStrictEqual(recorded.footnoteMismatches, meta.footnoteMismatches))
    fail("footnoteMismatches differs from the CSV");
  if (!isDeepStrictEqual(recorded.emptyTranslations, meta.emptyTranslations))
    fail("emptyTranslations differs from the CSV");

  if (!converted) return problems;
  const { outDir, lib } = converted;
  const output = (format) =>
    readFileSync(
      join(outDir, lib.outputPath(format, slug, meta.source.language)),
      "utf8",
    );
  const checks = [
    ["quranenc", () => checkQuranEnc(output("quranenc"), verses, lib, fail)],
    ["tanzil", () => checkTanzil(output("tanzil"), verses, meta, lib, fail)],
    [
      "quran-com",
      () => checkQuranCom(output("qurancom"), verses, meta, lib, fail),
    ],
    ["json", () => checkJson(output("json"), verses, csv, meta, fail)],
  ];
  for (const [name, check] of checks) {
    try {
      check();
    } catch (error) {
      fail(`${name}: ${error.message}`);
    }
  }
  return problems;
}

/**
 * Runs the data repository's own converter (rootDir/scripts/convert.mjs --to all) into a
 * temporary folder; the output must be exactly the files `outputPath` names for every slug.
 */
async function runConverter(rootDir, slugs, problems) {
  const script = join(rootDir, "scripts/convert.mjs");
  if (!existsSync(script)) {
    problems.push(
      `${script} is missing; verify needs the data repository's converter`,
    );
    return null;
  }
  let lib;
  try {
    lib = await loadConverter(rootDir);
  } catch (error) {
    problems.push(
      `converter modules in ${rootDir}/scripts/lib: ${error.message}`,
    );
    return null;
  }
  const outDir = mkdtempSync(join(tmpdir(), "quran-database-convert-"));
  const run = spawnSync(
    process.execPath,
    [script, "--to", "all", "--out", outDir],
    { cwd: rootDir, encoding: "utf8" },
  );
  if (run.status !== 0) {
    problems.push(
      `node scripts/convert.mjs --to all exited ${run.status}: ${run.stderr.trim()}`,
    );
    return { outDir, lib: null };
  }
  const expectedFiles = slugs
    .flatMap((slug) => {
      const { language } = JSON.parse(
        readFileSync(join(rootDir, metaPath(slug)), "utf8"),
      ).source;
      return lib.FORMATS.map((format) =>
        lib.outputPath(format, slug, language),
      );
    })
    .sort();
  const written = listFiles(outDir).sort();
  if (!isDeepStrictEqual(written, expectedFiles)) {
    problems.push(
      `converter wrote ${written.join(", ")}; expected ${expectedFiles.join(", ")}`,
    );
  }
  return { outDir, lib };
}

export async function verifyRepository(
  rootDir,
  { expected = EXPECTED_COUNTS, overridesFile = OVERRIDES_FILE } = {},
) {
  const problems = [];
  const dataDir = join(rootDir, "data");
  const entries = existsSync(dataDir)
    ? readdirSync(dataDir, { withFileTypes: true })
    : [];
  const slugs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"))
    .map((entry) => entry.name.slice(0, -".meta.json".length))
    .sort();
  for (const entry of entries) {
    const slug = entry.name.replace(/\.csv$/, "");
    if (entry.isFile() && entry.name.endsWith(".meta.json")) continue;
    if (entry.isDirectory() && slugs.includes(entry.name)) continue;
    problems.push(
      entry.isFile() && slugs.includes(slug)
        ? `${legacyCsvPath(slug)} is the old single-file layout; ${surahDir(slug)}/NNN.csv replaces it`
        : `data/${entry.name} is not a <slug>/ folder or <slug>.meta.json`,
    );
  }
  const hasSurahDir = (slug) =>
    entries.some((entry) => entry.isDirectory() && entry.name === slug);
  for (const slug of slugs)
    if (!hasSurahDir(slug)) problems.push(`${surahDir(slug)}/ is missing`);
  if (slugs.length === 0) problems.push("no data/<slug>.meta.json found");
  const changelog = existsSync(join(rootDir, "CHANGELOG.md"))
    ? readFileSync(join(rootDir, "CHANGELOG.md"), "utf8")
    : "";
  const converted =
    slugs.length > 0 ? await runConverter(rootDir, slugs, problems) : null;
  for (const slug of slugs) {
    if (!hasSurahDir(slug)) continue;
    problems.push(
      ...verifySource(
        rootDir,
        slug,
        expected,
        converted?.lib ? converted : null,
      ),
    );
    const { version } = JSON.parse(
      readFileSync(join(rootDir, metaPath(slug)), "utf8"),
    );
    if (!changelog.split("\n").includes(`## ${version}`))
      problems.push(`${slug}: CHANGELOG.md has no section for ${version}`);
    if (!existsSync(join(rootDir, "changes", `${version}.csv`)))
      problems.push(`${slug}: changes/${version}.csv is missing`);
    if (!existsSync(join(rootDir, "releases", `${version}.md`)))
      problems.push(`${slug}: releases/${version}.md is missing`);
  }
  const changesDir = join(rootDir, "changes");
  for (const name of existsSync(changesDir) ? readdirSync(changesDir) : []) {
    try {
      parseChanges(readFileSync(join(changesDir, name), "utf8"));
    } catch (error) {
      problems.push(`changes/${name}: ${error.message}`);
    }
  }
  if (converted) rmSync(converted.outDir, { recursive: true, force: true });
  if (existsSync(join(rootDir, "releases/overrides.csv"))) {
    problems.push(
      "releases/overrides.csv does not belong in the data repository; overrides live in quran-api/scripts/quran-database/overrides.csv",
    );
  }
  try {
    problems.push(
      ...parseOverrides(readFileSync(overridesFile, "utf8")).errors,
    );
  } catch (error) {
    problems.push(`${overridesFile}: ${error.message}`);
  }
  return { slugs, problems };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      overrides: { type: "string", default: OVERRIDES_FILE },
      "test-expected-counts": { type: "string" },
    },
  });
  let expected = EXPECTED_COUNTS;
  if (values["test-expected-counts"] !== undefined) {
    const [surahs, verses] = values["test-expected-counts"]
      .split(",")
      .map(Number);
    expected = { surahs, verses, contiguousSurahs: false };
  }
  let rootDir;
  try {
    rootDir = resolveDatabaseDir(values.db, {
      allowAnyDir: values["test-expected-counts"] !== undefined,
    });
  } catch (error) {
    console.error(`verify failed: ${error.message}`);
    process.exit(1);
  }
  const { slugs, problems } = await verifyRepository(rootDir, {
    expected,
    overridesFile: resolve(values.overrides),
  });
  if (problems.length) {
    console.error(
      `verify failed with ${problems.length} problems:\n- ${problems.join("\n- ")}`,
    );
    process.exit(1);
  }
  console.log(`verify ok: ${slugs.join(", ")}`);
}
