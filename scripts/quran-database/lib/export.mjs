import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  embeddedLineBreaks,
  formatCanonicalRows,
  joinSurahTexts,
  parseCanonicalRows,
  splitCanonicalRows,
  toCanonicalRows,
} from "./canonical.mjs";
import { renderSection, upsertSection } from "./changelog.mjs";
import {
  diffSource,
  formatChanges,
  parseChanges,
  revertChanges,
} from "./diff.mjs";
import {
  buildMetadata,
  formatMetadata,
  legacyCsvPath,
  metaPath,
  slugFor,
  surahDir,
} from "./metadata.mjs";
import {
  analyzeChange,
  applyOverrides,
  countClasses,
  parseOverrides,
  renderReleaseNotes,
} from "./notes.mjs";
import { EXPECTED_COUNTS, validateSource } from "./validate.mjs";

const VERSION_PATTERN = /^(\d{4})\.(\d{2})\.(\d{2})(?:\.([2-9]|[1-9]\d+))?$/;

export class ExportError extends Error {
  constructor(errors) {
    super(`export failed, nothing was written:\n- ${errors.join("\n- ")}`);
    this.errors = errors;
  }
}

export function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version ?? "");
  if (!match) return null;
  const [, year, month, day, suffix] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  )
    return null;
  return [
    Number(year),
    Number(month),
    Number(day),
    suffix ? Number(suffix) : 1,
  ];
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 4; i++)
    if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

const readText = (path) => readFileSync(path, "utf8");

const SURAH_FILE = /^\d{3}\.csv$/;

/** Names of the surah files in data/<slug>/, sorted (mushaf order); empty when the folder is missing. */
export function surahFileNames(rootDir, slug) {
  const dir = join(rootDir, surahDir(slug));
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => SURAH_FILE.test(name))
        .sort()
    : [];
}

/**
 * The published canonical CSV of one source as a single text: data/<slug>/NNN.csv joined, or the
 * older single data/<slug>.csv when the surah folder does not exist yet.
 */
export function readPublishedCsv(rootDir, slug) {
  const names = surahFileNames(rootDir, slug);
  if (names.length)
    return joinSurahTexts(
      names.map((name) => readText(join(rootDir, surahDir(slug), name))),
    );
  return readText(join(rootDir, legacyCsvPath(slug)));
}

/**
 * The baseline for version V is the release before V, as canonical rows. When data/ already holds
 * V (a re-run), V's own change rows are reverted so the re-run reproduces the same diff.
 */
export function readBaseline(rootDir, slug, version) {
  const metadataFile = join(rootDir, metaPath(slug));
  if (!existsSync(metadataFile))
    return { baseline: null, previousVersion: null };
  const metadata = JSON.parse(readText(metadataFile));
  const rows = parseCanonicalRows(readPublishedCsv(rootDir, slug));
  if (metadata.version !== version) {
    if (compareVersions(version, metadata.version) < 0) {
      throw new ExportError([
        `${slug}: version ${version} is older than the published ${metadata.version}`,
      ]);
    }
    return { baseline: rows, previousVersion: metadata.version };
  }
  if (metadata.previousVersion === null)
    return { baseline: null, previousVersion: null };
  const changesPath = join(rootDir, "changes", `${version}.csv`);
  if (!existsSync(changesPath))
    throw new ExportError([
      `${slug} is at ${version} but changes/${version}.csv is missing`,
    ]);
  return {
    baseline: revertChanges(rows, parseChanges(readText(changesPath)), slug),
    previousVersion: metadata.previousVersion,
  };
}

export function publishedSlugs(rootDir) {
  const dataDir = join(rootDir, "data");
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((name) => name.endsWith(".meta.json"))
    .map((name) => name.slice(0, -".meta.json".length))
    .sort();
}

function publishedSlugsAt(rootDir, version) {
  return publishedSlugs(rootDir).filter(
    (slug) =>
      JSON.parse(readText(join(rootDir, metaPath(slug)))).version === version,
  );
}

/**
 * Builds every output file in memory. Throws ExportError (before anything is written) when the
 * input fails validation or the overrides file does not fit this release.
 * @returns {{ files: Record<string, string>, reports: object[] }} paths relative to rootDir
 */
export function buildRelease({
  rootDir,
  version,
  sources,
  surahsBySource,
  sourceIds,
  expected = EXPECTED_COUNTS,
  allowEmpty = false,
  allowFootnoteMismatch = false,
  overridesFile = null,
  runtime = process.versions,
}) {
  if (!parseVersion(version))
    throw new ExportError([
      `version "${version}" is not YYYY.MM.DD or YYYY.MM.DD.N (N >= 2)`,
    ]);
  const ids = [...new Set(sourceIds)].sort((a, b) => a - b);
  const errors = [];
  const validated = [];
  for (const sourceId of ids) {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) {
      errors.push(`source ${sourceId} is not listed by /translation-sources`);
      continue;
    }
    const surahs = surahsBySource[sourceId];
    const result = validateSource(sourceId, surahs, {
      expected,
      allowEmpty,
      allowFootnoteMismatch,
    });
    errors.push(...result.errors);
    validated.push({
      source,
      slug: slugFor(sourceId),
      verses: surahs.flatMap((surah) => surah.verses),
      ...result,
    });
  }
  const slugs = validated.map((entry) => entry.slug);
  const missing = publishedSlugsAt(rootDir, version).filter(
    (slug) => !slugs.includes(slug),
  );
  if (missing.length)
    errors.push(
      `release ${version} also contains ${missing.join(", ")}; re-run it with the same --sources`,
    );
  if (errors.length) throw new ExportError(errors);

  const files = {};
  const entries = [];
  const reports = [];
  for (const {
    source,
    slug,
    verses,
    emptyTranslations,
    footnoteMismatches,
  } of validated) {
    const { baseline, previousVersion } = readBaseline(rootDir, slug, version);
    const rows = toCanonicalRows(verses);
    const csv = formatCanonicalRows(rows);
    const lineBreaks = embeddedLineBreaks(verses);
    const metadata = buildMetadata({
      source,
      slug,
      version,
      previousVersion,
      verses,
      csv,
      footnoteMismatches,
      emptyTranslations,
      embeddedLineBreaks: lineBreaks,
    });
    const surahFiles = splitCanonicalRows(rows);
    for (const [name, text] of surahFiles)
      files[`${surahDir(slug)}/${name}`] = text;
    for (const name of surahFileNames(rootDir, slug))
      if (!surahFiles.has(name)) files[`${surahDir(slug)}/${name}`] = null;
    if (existsSync(join(rootDir, legacyCsvPath(slug))))
      files[legacyCsvPath(slug)] = null;
    files[metaPath(slug)] = formatMetadata(metadata);
    const diff = diffSource(slug, baseline, rows);
    entries.push({
      sourceId: source.id,
      slug,
      diff,
      analyses: diff.changes.map(analyzeChange),
    });
    reports.push({
      slug,
      sourceId: source.id,
      previousVersion,
      verseCount: metadata.verseCount,
      footnoteCount: metadata.footnoteCount,
      diff,
      emptyTranslations,
      footnoteMismatches,
      embeddedLineBreaks: lineBreaks,
    });
  }

  if (overridesFile !== null) {
    if (!existsSync(overridesFile))
      throw new ExportError([`overrides file ${overridesFile} does not exist`]);
    const { records, errors: parseErrors } = parseOverrides(
      readText(overridesFile),
    );
    const overrideErrors = parseErrors.length
      ? parseErrors
      : applyOverrides(
          Object.fromEntries(
            entries.map((entry) => [entry.slug, entry.analyses]),
          ),
          records,
        );
    if (overrideErrors.length) throw new ExportError(overrideErrors);
  }
  for (const entry of entries) entry.counts = countClasses(entry.analyses);
  reports.forEach((report, index) => {
    report.counts = entries[index].counts;
  });

  files[`changes/${version}.csv`] = formatChanges(
    entries.map((entry) => entry.diff),
  );
  files[`releases/${version}.md`] = renderReleaseNotes(
    version,
    entries,
    runtime,
  );
  const changelogPath = join(rootDir, "CHANGELOG.md");
  const changelog = existsSync(changelogPath) ? readText(changelogPath) : "";
  files["CHANGELOG.md"] = upsertSection(
    changelog,
    version,
    renderSection(version, entries),
  );
  return { files, reports };
}

/** Writes every file; a null content removes that file (a surah file or the old single CSV). */
export function writeRelease(rootDir, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(rootDir, path);
    if (content === null) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
