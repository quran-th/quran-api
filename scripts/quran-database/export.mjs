import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { OVERRIDES_FILE, resolveDatabaseDir } from "./lib/database.mjs";
import {
  DEFAULT_API,
  fetchSourceSurahs,
  fetchSources,
  loadFixture,
} from "./lib/fetch.mjs";
import { ExportError, buildRelease, writeRelease } from "./lib/export.mjs";
import { EXPECTED_COUNTS, testExpectedCounts } from "./lib/validate.mjs";

const USAGE = `usage: node scripts/quran-database/export.mjs --version YYYY.MM.DD[.N] [options]
  --db DIR                       quran-database checkout to write into (default ../quran-database)
  --overrides FILE               release overrides (default scripts/quran-database/overrides.csv)
  --api URL                      API base (default ${DEFAULT_API})
  --sources 3,4                  source ids to export (default 3,4)
  --from-fixture DIR             read API-shaped JSON from DIR instead of the network
  --allow-empty                  publish empty translations instead of failing
  --allow-footnote-mismatch      publish verses whose (*n*) markers and footnotes disagree
  --concurrency N                parallel API requests (default 4)
  --test-expected-counts S,V     fixture runs only: expect S surahs and V verses per source`;

function parseSourceIds(value) {
  const ids = value.split(",").map((part) => part.trim());
  if (ids.some((id) => !/^[1-9]\d*$/.test(id)))
    throw new Error(`--sources "${value}" is not a list of ids`);
  return ids.map(Number);
}

function printReport(reports) {
  for (const report of reports) {
    const { diff } = report;
    const changes = diff.initial
      ? "initial release"
      : `${diff.refs.length} verses changed, ${diff.footnotesChanged} footnotes changed`;
    console.log(
      `${report.slug} (source ${report.sourceId}): ${report.verseCount} verses, ${report.footnoteCount} footnotes; previous ${report.previousVersion ?? "none"}; ${changes}`,
    );
    if (diff.refs.length) console.log(`  changed: ${diff.refs.join(", ")}`);
    const classes = Object.entries(report.counts).filter(
      ([, count]) => count.hunks > 0,
    );
    if (classes.length)
      console.log(
        `  hunks: ${classes.map(([cls, count]) => `${cls} ${count.hunks}`).join(", ")}`,
      );
    if (report.emptyTranslations.length)
      console.warn(
        `  empty translations (allowed): ${report.emptyTranslations.join(", ")}`,
      );
    if (report.footnoteMismatches.length) {
      console.warn(
        `  ${report.footnoteMismatches.length} footnote marker mismatches (allowed):\n    ${report.footnoteMismatches.join("\n    ")}`,
      );
    }
    if (report.embeddedLineBreaks.length)
      console.warn(
        `  embedded line breaks: ${report.embeddedLineBreaks.join(", ")}`,
      );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      api: { type: "string", default: DEFAULT_API },
      sources: { type: "string", default: "3,4" },
      "from-fixture": { type: "string" },
      db: { type: "string" },
      overrides: { type: "string", default: OVERRIDES_FILE },
      "allow-empty": { type: "boolean", default: false },
      "allow-footnote-mismatch": { type: "boolean", default: false },
      "test-expected-counts": { type: "string" },
      concurrency: { type: "string", default: "4" },
    },
  });
  if (!values.version) throw new Error(`--version is required\n${USAGE}`);
  const sourceIds = parseSourceIds(values.sources);
  let expected = EXPECTED_COUNTS;
  if (values["test-expected-counts"] !== undefined) {
    if (!values["from-fixture"])
      throw new Error(
        "--test-expected-counts is only accepted together with --from-fixture",
      );
    const [surahs, verses] = values["test-expected-counts"]
      .split(",")
      .map(Number);
    if (!Number.isInteger(surahs) || !Number.isInteger(verses))
      throw new Error("--test-expected-counts takes S,V");
    expected = testExpectedCounts(surahs, verses);
  }
  const rootDir = resolveDatabaseDir(values.db, {
    allowAnyDir: values["from-fixture"] !== undefined,
  });

  let input;
  if (values["from-fixture"]) {
    input = loadFixture(resolve(values["from-fixture"]), sourceIds);
  } else {
    const concurrency = Math.max(
      1,
      Number.parseInt(values.concurrency, 10) || 4,
    );
    const sources = await fetchSources(values.api);
    const surahsBySource = {};
    for (const sourceId of sourceIds) {
      console.log(`fetching source ${sourceId} from ${values.api}`);
      surahsBySource[sourceId] = await fetchSourceSurahs(values.api, sourceId, {
        concurrency,
      });
    }
    input = { sources, surahsBySource };
  }

  const { files, reports } = buildRelease({
    rootDir,
    version: values.version,
    sourceIds,
    expected,
    allowEmpty: values["allow-empty"],
    allowFootnoteMismatch: values["allow-footnote-mismatch"],
    overridesFile: resolve(values.overrides),
    ...input,
  });
  writeRelease(rootDir, files);
  printReport(reports);
  console.log(
    `wrote ${Object.values(files).filter((content) => content !== null).length} files and removed ${Object.values(files).filter((content) => content === null).length} for release ${values.version}`,
  );
}

main().catch((error) => {
  console.error(
    error instanceof ExportError
      ? error.message
      : `export failed: ${error.message}`,
  );
  process.exit(1);
});
