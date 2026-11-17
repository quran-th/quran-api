// Fills the release index verse list of an already released version from the data checkout's changes/<version>.csv.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveDatabaseDir } from "./lib/database.mjs";
import { parseChanges } from "./lib/diff.mjs";
import { putVerses } from "./lib/releaseIndex.mjs";
import { releaseVersesFromChanges } from "./lib/releaseVerses.mjs";

const USAGE = `usage: node scripts/quran-database/backfill-release-verses.mjs <version> [--db DIR] [--dry-run]
  reads <db>/changes/<version>.csv and replaces the release's verse list (env CONTRIBUTE_URL, RELEASE_KEY)`;

export function loadVerses(dbDir, version) {
  const file = join(dbDir, "changes", `${version}.csv`);
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  return releaseVersesFromChanges(parseChanges(readFileSync(file, "utf8")));
}

export function summarize(verses) {
  const counts = {};
  for (const verse of verses) {
    const key = `source ${verse.sourceId} ${verse.footnote === 0 ? "verses" : "footnotes"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts).map(([key, count]) => `${key}: ${count}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        db: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
    });
    const [version] = positionals;
    if (!version) throw new Error(USAGE);
    const verses = loadVerses(resolveDatabaseDir(values.db), version);
    console.log(
      `${version}: ${verses.length} changed rows (${summarize(verses).join(", ") || "none"})`,
    );
    if (values["dry-run"]) {
      console.log("dry run: nothing sent");
    } else {
      await putVerses(version, verses);
      console.log(`sent ${verses.length} rows to the release index`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
