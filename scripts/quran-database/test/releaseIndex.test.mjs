import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildRelease, writeRelease } from "../lib/export.mjs";
import { resolveDatabaseDir } from "../lib/database.mjs";
import { loadFixture } from "../lib/fetch.mjs";
import {
  getRelease,
  putVerses,
  releaseIndexConfig,
} from "../lib/releaseIndex.mjs";
import { releaseVersesFromChanges } from "../lib/releaseVerses.mjs";
import { loadVerses, summarize } from "../backfill-release-verses.mjs";
import { testExpectedCounts } from "../lib/validate.mjs";
import {
  audioAyahsFromVerses,
  releaseAudioAyahs,
} from "../../translation-audio/release.mjs";

const execFileAsync = promisify(execFile);
const toolingDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = join(toolingDir, "test/fixtures/api");
const databaseDir = resolveDatabaseDir();
const created = [];
const servers = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.close();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "release-index-test-"));
  created.push(dir);
  return dir;
}

const detail = (overrides = {}) => ({
  release: {
    version: "2026.11.16",
    status: "frozen",
    sourceIds: [3, 4],
    ...overrides,
  },
  steps: [],
  verses: overrides.verses ?? [],
});

/** A local stand-in for the contribute worker: records every request. */
async function fakeContribute({ release = detail(), putStatus = 200 } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : null,
      });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") {
        const allowed = req.headers.authorization === "Bearer jwt";
        res.statusCode = allowed ? 200 : 403;
        res.end(
          JSON.stringify(
            allowed
              ? { success: true, data: release }
              : { success: false, error: { message: "Admin role required" } },
          ),
        );
        return;
      }
      if (req.headers["x-release-key"] !== "release-key") {
        res.statusCode = 401;
        res.end(JSON.stringify({ success: false, error: { message: "Unauthorized" } }));
        return;
      }
      res.statusCode = putStatus;
      res.end(JSON.stringify({ success: putStatus < 400, data: {} }));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    puts: () => requests.filter((request) => request.method === "PUT"),
  };
}

async function runCli(script, args, server, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(toolingDir, script), ...args],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          CONTRIBUTE_URL: server.url,
          CONTRIBUTE_TOKEN: "jwt",
          RELEASE_KEY: "release-key",
          ...extraEnv,
        },
      },
    );
    return { status: 0, stdout, stderr };
  } catch (error) {
    return { status: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

const listFiles = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(join(dir, entry.name), relative)
      : [relative];
  });

// A data checkout holding release 2026.11.14, and a fixture where the next release changes two rows.
function releaseWorkspace() {
  const root = tempDir();
  const input = loadFixture(fixtureDir, [3, 4]);
  const { files } = buildRelease({
    rootDir: root,
    version: "2026.11.14",
    sourceIds: [3, 4],
    expected: testExpectedCounts(3, 14),
    runtime: { node: "22.0.0", icu: "77.1" },
    ...input,
  });
  writeRelease(root, files);
  const changed = join(tempDir(), "api");
  cpSync(fixtureDir, changed, { recursive: true });
  const editJson = (path, edit) => {
    const file = join(changed, path);
    const body = JSON.parse(readFileSync(file, "utf8"));
    edit(body.data);
    writeFileSync(file, JSON.stringify(body, null, 2));
  };
  editJson("surahs/4/112.json", (data) => {
    data.verses.find((verse) => verse.verseNumber === 4).translation += " ทั้งสิ้น";
  });
  editJson("surahs/3/108.json", (data) => {
    data.verses.find((verse) => verse.verseNumber === 2).footnotes[0].text +=
      " เพิ่มเติม";
  });
  const overrides = join(tempDir(), "overrides.csv");
  writeFileSync(overrides, "source,surah,ayah,footnote,class,note\n");
  return { root, changed, overrides };
}

const exportArgs = ({ root, changed, overrides }, ...extra) => [
  "--db",
  root,
  "--from-fixture",
  changed,
  "--test-expected-counts",
  "3,14",
  "--overrides",
  overrides,
  ...extra,
];

test("export --release reports the step running then done and sends the changed rows", async () => {
  const workspace = releaseWorkspace();
  const server = await fakeContribute();
  const result = await runCli(
    "export.mjs",
    exportArgs(workspace, "--release", "2026.11.16"),
    server,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    server.requests.map((request) => `${request.method} ${request.url}`),
    [
      "GET /api/releases/2026.11.16",
      "PUT /api/releases/2026.11.16/steps/export",
      "PUT /api/releases/2026.11.16/verses",
      "PUT /api/releases/2026.11.16/steps/export",
    ],
  );
  assert.equal(server.requests[0].headers.authorization, "Bearer jwt");
  for (const put of server.puts()) {
    assert.equal(put.headers["x-release-key"], "release-key");
    assert.equal(put.headers["x-internal-key"], undefined);
  }
  const [running, verses, done] = server.puts();
  assert.deepEqual(running.body, { status: "running" });
  assert.deepEqual(
    verses.body.verses.map((verse) => [
      verse.sourceId,
      verse.surah,
      verse.ayah,
      verse.footnote,
    ]),
    [
      [3, 108, 2, 1],
      [4, 112, 4, 0],
    ],
  );
  assert.equal(
    verses.body.verses.find((verse) => verse.sourceId === 4).class,
    "wordsAdded",
  );
  assert.equal(done.body.status, "done");
  assert.match(done.body.detail, /king-fahd: .*1 verses changed/);
  assert.match(done.body.detail, /al-mukhtasar: .*1 verses changed/);
  assert.ok(existsSync(join(workspace.root, "changes/2026.11.16.csv")));
});

test("export --release uses the record's version and sources when they are not given", async () => {
  const workspace = releaseWorkspace();
  const server = await fakeContribute({ release: detail({ sourceIds: [4] }) });
  const result = await runCli(
    "export.mjs",
    exportArgs(workspace, "--release", "2026.11.16"),
    server,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(workspace.root, "data/al-mukhtasar.meta.json")));
  const verses = server.puts().find((put) => put.url.endsWith("/verses"));
  assert.deepEqual(
    verses.body.verses.map((verse) => verse.sourceId),
    [4],
  );
});

test("export --release refuses a --version that differs from the record, writing and reporting nothing", async () => {
  const workspace = releaseWorkspace();
  const before = listFiles(workspace.root);
  const server = await fakeContribute();
  const result = await runCli(
    "export.mjs",
    exportArgs(workspace, "--release", "2026.11.16", "--version", "2026.11.17"),
    server,
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--version 2026\.11\.17 differs from release 2026\.11\.16/,
  );
  assert.equal(server.puts().length, 0);
  assert.deepEqual(listFiles(workspace.root), before);
});

test("export --release refuses a released record and a --sources that disagrees", async () => {
  const workspace = releaseWorkspace();
  const released = await fakeContribute({
    release: detail({ status: "released" }),
  });
  const first = await runCli(
    "export.mjs",
    exportArgs(workspace, "--release", "2026.11.16"),
    released,
  );
  assert.equal(first.status, 1);
  assert.match(first.stderr, /already released/);
  assert.equal(released.puts().length, 0);

  const onlyKingFahd = await fakeContribute({
    release: detail({ sourceIds: [3] }),
  });
  const second = await runCli(
    "export.mjs",
    exportArgs(workspace, "--release", "2026.11.16", "--sources", "3,4"),
    onlyKingFahd,
  );
  assert.equal(second.status, 1);
  assert.match(
    second.stderr,
    /--sources 3,4 differs from the release's sources 3/,
  );
  assert.equal(onlyKingFahd.puts().length, 0);
});

test("a failing export reports the step failed with the reason", async () => {
  const workspace = releaseWorkspace();
  const server = await fakeContribute();
  const args = exportArgs(workspace, "--release", "2026.11.16");
  args.splice(args.indexOf("--test-expected-counts"), 2);
  const result = await runCli("export.mjs", args, server);
  assert.equal(result.status, 1);
  const puts = server.puts();
  assert.deepEqual(
    puts.map((put) => put.body.status),
    ["running", "failed"],
  );
  assert.match(puts[1].body.detail, /expected 114/);
});

test("reporting failures only warn: the export still succeeds", async () => {
  const workspace = releaseWorkspace();
  const server = await fakeContribute({ putStatus: 500 });
  const result = await runCli(
    "export.mjs",
    exportArgs(workspace, "--release", "2026.11.16"),
    server,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: could not report export running/);
  assert.match(result.stderr, /warning: could not report the changed verses/);
  assert.match(result.stderr, /warning: could not report export done/);
  assert.ok(existsSync(join(workspace.root, "changes/2026.11.16.csv")));
});

test("export without --release never calls the release index", async () => {
  const workspace = releaseWorkspace();
  const server = await fakeContribute();
  const result = await runCli(
    "export.mjs",
    exportArgs(workspace, "--version", "2026.11.16"),
    server,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(server.requests.length, 0);
});

test("reading with only the release key explains that CONTRIBUTE_TOKEN is needed", async () => {
  const server = await fakeContribute();
  await assert.rejects(
    getRelease("2026.11.16", {
      config: { baseUrl: server.url, releaseKey: "release-key", token: "" },
    }),
    /answered 403.*CONTRIBUTE_TOKEN/,
  );
});

test("the client treats a redirect as an error and never follows it", async () => {
  let followed = false;
  const target = createServer((req, res) => {
    followed = true;
    res.end("{}");
  });
  await new Promise((done) => target.listen(0, "127.0.0.1", done));
  servers.push(target);
  const redirecting = createServer((req, res) => {
    res.statusCode = 307;
    res.setHeader("Location", `http://127.0.0.1:${target.address().port}/x`);
    res.end();
  });
  await new Promise((done) => redirecting.listen(0, "127.0.0.1", done));
  servers.push(redirecting);
  await assert.rejects(
    putVerses("2026.11.16", [], {
      config: {
        baseUrl: `http://127.0.0.1:${redirecting.address().port}`,
        releaseKey: "release-key",
        token: "",
      },
    }),
    /redirect \(307\)/,
  );
  assert.equal(followed, false);
});

test("the client times out instead of hanging", async () => {
  const hung = createServer(() => {});
  await new Promise((done) => hung.listen(0, "127.0.0.1", done));
  servers.push(hung);
  await assert.rejects(
    putVerses("2026.11.16", [], {
      config: {
        baseUrl: `http://127.0.0.1:${hung.address().port}`,
        releaseKey: "k",
        token: "",
      },
      timeoutMs: 100,
    }),
    /timed out after 100 ms/,
  );
});

test("config defaults to the production contribute URL", () => {
  assert.equal(
    releaseIndexConfig({}).baseUrl,
    "https://contribute.quran.in.th",
  );
  assert.equal(
    releaseIndexConfig({ CONTRIBUTE_URL: "http://localhost:8788/" }).baseUrl,
    "http://localhost:8788",
  );
});

test("verses from a changes csv: source ids, footnote 0 for verse rows, row class", () => {
  const verses = releaseVersesFromChanges([
    {
      source: "king-fahd",
      surah: "2",
      ayah: "5",
      footnote: "",
      old: "",
      new: "ใหม่",
    },
    {
      source: "king-fahd",
      surah: "2",
      ayah: "5",
      footnote: "1",
      old: "ก ข",
      new: "ก ข ค",
    },
    {
      source: "al-mukhtasar",
      surah: "3",
      ayah: "1",
      footnote: "",
      old: "เก่า",
      new: "",
    },
  ]);
  assert.deepEqual(verses, [
    { sourceId: 3, surah: 2, ayah: 5, footnote: 0, class: "rowAdded" },
    { sourceId: 3, surah: 2, ayah: 5, footnote: 1, class: "wordsAdded" },
    { sourceId: 4, surah: 3, ayah: 1, footnote: 0, class: "rowRemoved" },
  ]);
});

test("backfill dry run counts the rows and sends nothing", async () => {
  const server = await fakeContribute();
  const result = await runCli(
    "backfill-release-verses.mjs",
    ["2026.11.14", "--db", databaseDir, "--dry-run"],
    server,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2026\.11\.14: \d+ changed rows/);
  assert.match(result.stdout, /dry run: nothing sent/);
  assert.equal(server.requests.length, 0);
});

test("backfill sends the verse list of a data checkout version", async () => {
  const server = await fakeContribute();
  const result = await runCli(
    "backfill-release-verses.mjs",
    ["2026.11.14", "--db", databaseDir],
    server,
  );
  assert.equal(result.status, 0, result.stderr);
  const [put] = server.puts();
  assert.equal(put.url, "/api/releases/2026.11.14/verses");
  assert.deepEqual(put.body.verses, loadVerses(databaseDir, "2026.11.14"));
  const missing = await runCli(
    "backfill-release-verses.mjs",
    ["1999.01.01", "--db", databaseDir, "--dry-run"],
    server,
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist/);
});

test("backfill summary separates verses from footnotes per source", () => {
  assert.deepEqual(
    summarize([
      { sourceId: 3, surah: 1, ayah: 1, footnote: 0 },
      { sourceId: 3, surah: 1, ayah: 1, footnote: 2 },
      { sourceId: 4, surah: 1, ayah: 2, footnote: 0 },
    ]),
    ["source 3 verses: 1", "source 3 footnotes: 1", "source 4 verses: 1"],
  );
});

test("audio ayahs of a release: wanted source only, footnote rows and removed verses ignored", async () => {
  const verses = [
    { sourceId: 4, surah: 78, ayah: 21, footnote: 0, class: "spelling" },
    { sourceId: 4, surah: 78, ayah: 21, footnote: 1, class: "spelling" },
    { sourceId: 4, surah: 2, ayah: 255, footnote: 0, class: "wordChanged" },
    { sourceId: 4, surah: 5, ayah: 3, footnote: 0, class: "rowRemoved" },
    { sourceId: 3, surah: 1, ayah: 1, footnote: 0, class: "spelling" },
  ];
  assert.deepEqual(audioAyahsFromVerses(verses), [
    { surah: 2, ayah: 255 },
    { surah: 78, ayah: 21 },
  ]);
  const server = await fakeContribute({
    release: { ...detail({ sourceIds: [3, 4] }), verses },
  });
  const config = { baseUrl: server.url, releaseKey: "", token: "jwt" };
  assert.equal((await releaseAudioAyahs("2026.11.16", { config })).length, 2);

  const noAudio = await fakeContribute({
    release: { ...detail({ sourceIds: [3] }), verses },
  });
  await assert.rejects(
    releaseAudioAyahs("2026.11.16", {
      config: { ...config, baseUrl: noAudio.url },
    }),
    /does not include source 4/,
  );
  const empty = await fakeContribute({ release: detail() });
  await assert.rejects(
    releaseAudioAyahs("2026.11.16", {
      config: { ...config, baseUrl: empty.url },
    }),
    /lists no changed ayahs/,
  );
});

test("verify --release reports the step done, or failed with the problem", async () => {
  const workspace = releaseWorkspace();
  cpSync(join(databaseDir, "scripts"), join(workspace.root, "scripts"), {
    recursive: true,
  });
  const args = [
    "--db",
    workspace.root,
    "--overrides",
    workspace.overrides,
    "--test-expected-counts",
    "3,14",
    "--release",
    "2026.11.14",
  ];
  const ok = await fakeContribute();
  const passed = await runCli("verify.mjs", args, ok);
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(
    ok.puts().map((put) => [put.url, put.body.status]),
    [
      ["/api/releases/2026.11.14/steps/verify", "running"],
      ["/api/releases/2026.11.14/steps/verify", "done"],
    ],
  );

  writeFileSync(join(workspace.root, "data/king-fahd/001.csv"), "broken\n");
  const bad = await fakeContribute();
  const failed = await runCli("verify.mjs", args, bad);
  assert.equal(failed.status, 1);
  assert.deepEqual(
    bad.puts().map((put) => put.body.status),
    ["running", "failed"],
  );
  assert.match(bad.puts()[1].body.detail, /problems/);
});

test("release.mjs threads --release into the commands and adds the tag and githubRelease reports", async () => {
  const server = await fakeContribute();
  const result = await runCli(
    "release.mjs",
    ["--release", "2026.11.16", "--db", databaseDir],
    server,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /db:export -- --db .* --version 2026\.11\.16 --release 2026\.11\.16/,
  );
  assert.match(result.stdout, /db:verify -- --db \S+ --release 2026\.11\.16/);
  assert.match(result.stdout, /report-step\.mjs 2026\.11\.16 tag done/);
  assert.match(
    result.stdout,
    /report-step\.mjs 2026\.11\.16 githubRelease done/,
  );
  const plain = await runCli(
    "release.mjs",
    ["2026.11.16", "--db", databaseDir],
    server,
  );
  assert.doesNotMatch(plain.stdout, /--release|report-step/);
});

test("report-step.mjs puts the status with the release key and rejects unknown steps", async () => {
  const server = await fakeContribute();
  const ok = await runCli(
    "report-step.mjs",
    ["2026.11.16", "tag", "done", "pushed", "v2026.11.16"],
    server,
  );
  assert.equal(ok.status, 0, ok.stderr);
  const [put] = server.puts();
  assert.equal(put.url, "/api/releases/2026.11.16/steps/tag");
  assert.deepEqual(put.body, { status: "done", detail: "pushed v2026.11.16" });
  assert.equal(put.headers["x-release-key"], "release-key");
  assert.equal(put.headers["x-internal-key"], undefined);
  const bad = await runCli(
    "report-step.mjs",
    ["2026.11.16", "nope", "done"],
    server,
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage/);
});
