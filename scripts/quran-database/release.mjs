// Prints the release commands; it runs nothing except a read-only `git tag --list` in the data checkout.
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import {
  API_ROOT,
  OVERRIDES_FILE,
  TOOLING_DIR,
  resolveDatabaseDir,
} from "./lib/database.mjs";
import { parseVersion } from "./lib/export.mjs";

const args = process.argv.slice(2);
const dbIndex = args.indexOf("--db");
const dbValue = dbIndex === -1 ? undefined : args[dbIndex + 1];
if (dbIndex !== -1) args.splice(dbIndex, 2);
const releaseIndex = args.indexOf("--release");
const releaseValue = releaseIndex === -1 ? undefined : args[releaseIndex + 1];
if (releaseIndex !== -1) args.splice(releaseIndex, 2);
const [requested, ...exportFlags] = args;

let dbDir;
try {
  dbDir = resolveDatabaseDir(dbValue);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function existingTags() {
  try {
    return execFileSync("git", ["-C", dbDir, "tag", "--list", "v*"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function nextVersion() {
  const today = new Date();
  const date = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join(".");
  const tags = new Set(existingTags());
  if (!tags.has(`v${date}`)) return date;
  let suffix = 2;
  while (tags.has(`v${date}.${suffix}`)) suffix++;
  return `${date}.${suffix}`;
}

const version =
  requested && !requested.startsWith("--")
    ? requested
    : (releaseValue ?? nextVersion());
if (requested?.startsWith("--")) exportFlags.unshift(requested);
if (releaseIndex !== -1 && !releaseValue) {
  console.error("--release needs a version");
  process.exit(1);
}
if (releaseValue && releaseValue !== version) {
  console.error(`--release ${releaseValue} differs from version ${version}`);
  process.exit(1);
}
const release = releaseValue ? ["--release", version] : [];
const reportStep = (step) =>
  `node ${join(TOOLING_DIR, "report-step.mjs")} ${version} ${step} done`;
if (!parseVersion(version)) {
  console.error(`"${version}" is not YYYY.MM.DD or YYYY.MM.DD.N`);
  process.exit(1);
}
if (existingTags().includes(`v${version}`))
  console.warn(`warning: tag v${version} already exists; use the next suffix`);

const db = ["--db", dbDir];
console.log(
  `# Release ${version}: run these yourself, in order, from ${API_ROOT}`,
);
console.log(
  [
    "npm run db:export --",
    ...db,
    "--version",
    version,
    ...release,
    ...exportFlags,
  ].join(" "),
);
console.log(["npm run db:verify --", ...db, ...release].join(" "));
console.log(
  `git -C ${dbDir} status --short   # review data/, changes/, releases/${version}.md, CHANGELOG.md`,
);
console.log(
  `git -C ${dbDir} add data changes releases CHANGELOG.md && git -C ${dbDir} commit -m "Release ${version}"`,
);
console.log(`git -C ${dbDir} tag v${version}`);
if (release.length) {
  console.log(`# after pushing the commit and tag:`);
  console.log(reportStep("tag"));
}
// The release asset: data/<slug>.csv (all surahs joined, checked against meta.json sha256) and
// <slug>.meta.json under quran-database-<version>/, built in the git-ignored out/ of the data checkout.
const outDir = join(dbDir, "out");
const zip = join(outDir, `quran-database-${version}.zip`);
console.log(
  `node ${join(dbDir, "scripts/bundle.mjs")} --version ${version} --out ${outDir} && (cd ${outDir} && rm -f quran-database-${version}.zip && zip -qrX quran-database-${version}.zip quran-database-${version})`,
);
console.log(
  `# after pushing the commit and tag and creating the GitHub release v${version}:`,
);
console.log(
  `gh release upload v${version} ${zip} --repo quran-th/quran-database`,
);
if (release.length) console.log(reportStep("githubRelease"));
console.log(
  `# then empty ${relative(API_ROOT, OVERRIDES_FILE)} (keep the header line) and commit that in quran-api`,
);
