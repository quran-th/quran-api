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
  parseCanonical,
  toCanonicalRows,
} from "./lib/canonical.mjs";
import {
  OVERRIDES_FILE,
  importDatabaseModule,
  resolveDatabaseDir,
} from "./lib/database.mjs";
import { parseChanges } from "./lib/diff.mjs";
import { csvPath, metaPath, sha256 } from "./lib/metadata.mjs";
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
      previous && previous.sura === verse.sura
        ? verse.aya === previous.aya + 1
        : verse.aya === 1 && (!previous || verse.sura > previous.sura);
    if (!contiguous)
      fail(`CSV verse ${verse.sura}:${verse.aya} breaks mushaf order`);
  });
  const suras = [...new Set(verses.map((verse) => verse.sura))];
  if (suras.length !== expected.surahs)
    fail(`CSV has ${suras.length} surahs, expected ${expected.surahs}`);
  if (
    expected.contiguousSurahs !== false &&
    suras.some((sura, index) => sura !== index + 1)
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
      sura: String(verse.sura),
      aya: String(verse.aya),
      translation: verse.translation,
      footnotes: lib.quranEncFootnotes(verse.footnotes),
    };
    if (!isDeepStrictEqual(record, expected))
      fail(`quranenc row ${index + 2} differs from ${verse.sura}:${verse.aya}`);
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
    if (line.sura !== verse.sura || line.aya !== verse.aya)
      fail(`tanzil line ${index + 1} is ${line.sura}|${line.aya}`);
    if (line.text !== lib.tanzilText(verse.translation).text)
      fail(`tanzil ${verse.sura}:${verse.aya} text differs from the CSV`);
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
    const ref = `${verse.sura}:${verse.aya}`;
    if (!item) return;
    if (item.verse_key !== ref || item.resource_id !== sourceId)
      fail(
        `quran-com item ${index} is ${item.verse_key}/${item.resource_id}, expected ${ref}/${sourceId}`,
      );
    if (lib.restoreMarkers(item.text) !== verse.translation)
      fail(`quran-com ${ref} text does not restore to the CSV text`);
    const expectedNotes = Object.fromEntries(
      verse.footnotes.map((note) => [
        String(lib.footnoteId(sourceId, verse.sura, verse.aya, note.number)),
        note.text,
      ]),
    );
    if (!isDeepStrictEqual(item.foot_notes, expectedNotes))
      fail(`quran-com ${ref} foot_notes differ from the CSV`);
    for (const sup of lib.supFootnoteIds(item.text)) {
      if (
        sup.id !==
          lib.footnoteId(sourceId, verse.sura, verse.aya, sup.number) ||
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
    const [sura, aya] = key.split(":").map(Number);
    return {
      sura,
      aya,
      translation: document.verses[key].translation,
      footnotes: document.verses[key].footnotes,
    };
  });
  if (formatCanonicalRows(toCanonicalRows(back)) !== csv)
    fail("round trip canonical -> json -> canonical differs");
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
  const csv = readFileSync(join(rootDir, csvPath(slug)), "utf8");
  const actualHash = sha256(csv);
  if (actualHash !== meta.sha256)
    fail(
      `sha256 of ${csvPath(slug)} is ${actualHash}, meta.json says ${meta.sha256}`,
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
  const surahs = [...new Set(verses.map((verse) => verse.sura))].map((id) => {
    const surahVerses = verses
      .filter((verse) => verse.sura === id)
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
  const allowed = new Set(
    slugs.flatMap((slug) => [`${slug}.csv`, `${slug}.meta.json`]),
  );
  for (const entry of entries) {
    if (!entry.isFile() || !allowed.has(entry.name))
      problems.push(
        `data/${entry.name} is not part of a <slug>.csv + <slug>.meta.json pair`,
      );
  }
  for (const slug of slugs)
    if (!existsSync(join(rootDir, csvPath(slug))))
      problems.push(`${csvPath(slug)} is missing`);
  if (slugs.length === 0) problems.push("no data/<slug>.meta.json found");
  const changelog = existsSync(join(rootDir, "CHANGELOG.md"))
    ? readFileSync(join(rootDir, "CHANGELOG.md"), "utf8")
    : "";
  const converted =
    slugs.length > 0 ? await runConverter(rootDir, slugs, problems) : null;
  for (const slug of slugs) {
    if (!existsSync(join(rootDir, csvPath(slug)))) continue;
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
