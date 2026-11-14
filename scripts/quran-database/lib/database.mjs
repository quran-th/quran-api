import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TOOLING_DIR = fileURLToPath(new URL("..", import.meta.url));
export const API_ROOT = resolve(TOOLING_DIR, "../..");
export const DEFAULT_DATABASE_DIR = resolve(API_ROOT, "../quran-database");
export const OVERRIDES_FILE = join(TOOLING_DIR, "overrides.csv");

const ORIGIN =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)quran-th\/quran-database(?:\.git)?\/?$/;

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Throws unless `dir` is the top of a git checkout whose origin is quran-th/quran-database. */
export function checkDatabaseCheckout(dir) {
  let top;
  try {
    top = git(dir, "rev-parse", "--show-toplevel");
  } catch {
    throw new Error(
      `${dir} is not a git checkout; clone https://github.com/quran-th/quran-database.git there or pass --db <path>`,
    );
  }
  if (realpathSync(top) !== realpathSync(dir)) {
    throw new Error(
      `${dir} is inside the git checkout ${top}, not the top of a quran-database checkout`,
    );
  }
  let origin = "";
  try {
    origin = git(dir, "remote", "get-url", "origin");
  } catch {
    // no origin: reported below
  }
  if (!ORIGIN.test(origin)) {
    throw new Error(
      `${dir} has origin "${origin || "(none)"}", expected github.com/quran-th/quran-database`,
    );
  }
}

/**
 * Resolves the data checkout: `--db` relative to the working directory, by default
 * ../quran-database next to the quran-api repository. `allowAnyDir` (fixture runs and tests)
 * skips the git/origin check.
 */
export function resolveDatabaseDir(value, { allowAnyDir = false } = {}) {
  const dir = resolve(value ?? DEFAULT_DATABASE_DIR);
  if (!existsSync(dir)) {
    throw new Error(
      `data checkout ${dir} does not exist; clone https://github.com/quran-th/quran-database.git there or pass --db <path>`,
    );
  }
  if (!allowAnyDir) checkDatabaseCheckout(dir);
  return dir;
}

/** Imports one of the data repository's converter modules, scripts/lib/<name>. */
export function importDatabaseModule(dbDir, name) {
  return import(pathToFileURL(join(dbDir, "scripts/lib", name)).href);
}
