import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATABASE_DIR, resolveDatabaseDir } from "../lib/database.mjs";

const toolingDir = fileURLToPath(new URL("..", import.meta.url));
const created = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "quran-database-db-")));
  created.push(dir);
  return dir;
}

function gitRepo(origin) {
  const dir = tempDir();
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir]);
  if (origin)
    execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

const run = (script, args, cwd = tempDir()) =>
  spawnSync(process.execPath, [join(toolingDir, script), ...args], {
    cwd,
    encoding: "utf8",
  });

test("--db defaults to the quran-database checkout next to quran-api, whatever the working directory", () => {
  assert.equal(
    DEFAULT_DATABASE_DIR,
    resolve(toolingDir, "../../../quran-database"),
  );
  const printed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DEFAULT_DATABASE_DIR } from ${JSON.stringify(join(toolingDir, "lib/database.mjs"))}; console.log(DEFAULT_DATABASE_DIR)`,
    ],
    { cwd: tempDir(), encoding: "utf8" },
  );
  assert.equal(printed.stdout.trim(), DEFAULT_DATABASE_DIR);
  assert.equal(resolveDatabaseDir(), DEFAULT_DATABASE_DIR);
});

test("only the top of a git checkout whose origin is quran-th/quran-database is accepted", () => {
  const plain = tempDir();
  assert.throws(() => resolveDatabaseDir(plain), /is not a git checkout/);
  assert.throws(
    () => resolveDatabaseDir(join(plain, "missing")),
    /does not exist/,
  );
  assert.throws(
    () => resolveDatabaseDir(gitRepo()),
    /has origin "\(none\)", expected github\.com\/quran-th\/quran-database/,
  );
  assert.throws(
    () =>
      resolveDatabaseDir(
        gitRepo("https://github.com/someone/quran-database.git"),
      ),
    /has origin "https:\/\/github\.com\/someone\/quran-database\.git"/,
  );
  assert.throws(
    () =>
      resolveDatabaseDir(
        gitRepo("https://github.com/quran-th/quran-database-fork.git"),
      ),
    /has origin/,
  );
  for (const origin of [
    "https://github.com/quran-th/quran-database.git",
    "https://github.com/quran-th/quran-database",
    "git@github.com:quran-th/quran-database.git",
    "ssh://git@github.com/quran-th/quran-database.git",
  ]) {
    const dir = gitRepo(origin);
    assert.equal(resolveDatabaseDir(dir), dir, origin);
  }
  const checkout = gitRepo("git@github.com:quran-th/quran-database.git");
  mkdirSync(join(checkout, "data"));
  assert.throws(
    () => resolveDatabaseDir(join(checkout, "data")),
    /is inside the git checkout/,
  );
  assert.equal(resolveDatabaseDir(plain, { allowAnyDir: true }), plain);
});

test("export, verify and release refuse a --db that is not the data checkout", () => {
  const plain = tempDir();
  const exported = run("export.mjs", [
    "--version",
    "2026.11.14",
    "--db",
    plain,
  ]);
  assert.equal(exported.status, 1);
  assert.match(exported.stderr, /is not a git checkout/);
  assert.doesNotMatch(exported.stdout, /fetching/);
  const verified = run("verify.mjs", ["--db", plain]);
  assert.equal(verified.status, 1);
  assert.match(verified.stderr, /is not a git checkout/);
  const foreign = gitRepo("https://github.com/someone/else.git");
  const released = run("release.mjs", ["--db", foreign]);
  assert.equal(released.status, 1);
  assert.match(
    released.stderr,
    /has origin "https:\/\/github\.com\/someone\/else\.git"/,
  );
});

test("release only prints the steps for the data checkout", () => {
  const db = gitRepo("https://github.com/quran-th/quran-database.git");
  const printed = run("release.mjs", [
    "2026.11.20",
    "--db",
    db,
    "--allow-footnote-mismatch",
  ]);
  assert.equal(printed.status, 0, printed.stderr);
  const lines = printed.stdout.trim().split("\n");
  assert.deepEqual(lines.slice(1, 3), [
    `npm run db:export -- --db ${db} --version 2026.11.20 --allow-footnote-mismatch`,
    `npm run db:verify -- --db ${db}`,
  ]);
  assert.ok(lines.includes(`git -C ${db} tag v2026.11.20`));
  const zip = join(db, "out", "quran-database-2026.11.20.zip");
  assert.ok(
    lines.includes(
      `node ${join(db, "scripts/bundle.mjs")} --version 2026.11.20 --out ${join(db, "out")} && (cd ${join(db, "out")} && rm -f quran-database-2026.11.20.zip && zip -qrX quran-database-2026.11.20.zip quran-database-2026.11.20)`,
    ),
  );
  assert.ok(
    lines.includes(
      `gh release upload v2026.11.20 ${zip} --repo quran-th/quran-database`,
    ),
  );
  assert.match(lines.at(-1), /empty scripts\/quran-database\/overrides\.csv/);
  assert.equal(
    execFileSync("git", ["-C", db, "status", "--porcelain"], {
      encoding: "utf8",
    }),
    "",
  );
});
