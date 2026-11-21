import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ExportError,
  buildRelease,
  compareVersions,
  parseVersion,
  readPublishedCsv,
  writeRelease,
} from "../lib/export.mjs";
import { resolveDatabaseDir } from "../lib/database.mjs";
import { loadFixture } from "../lib/fetch.mjs";
import { testExpectedCounts } from "../lib/validate.mjs";
import { verifyRepository } from "../verify.mjs";

const toolingDir = fileURLToPath(new URL("..", import.meta.url));
const fixtureDir = join(toolingDir, "test/fixtures/api");
const databaseDir = resolveDatabaseDir();
const expected = testExpectedCounts(3, 14);
const runtime = { node: "22.0.0", icu: "77.1" };
const created = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "quran-database-test-"));
  created.push(dir);
  return dir;
}

function listFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(join(dir, entry.name), relative)
      : [relative];
  });
}

function snapshot(dir) {
  return Object.fromEntries(
    listFiles(dir)
      .sort()
      .map((path) => [path, readFileSync(join(dir, path))]),
  );
}

function exportFixture(
  rootDir,
  version,
  mutate = () => {},
  overridesFile = null,
) {
  const input = loadFixture(fixtureDir, [3, 4]);
  mutate(input);
  const { files, reports } = buildRelease({
    rootDir,
    version,
    sourceIds: [3, 4],
    expected,
    runtime,
    overridesFile,
    ...input,
  });
  writeRelease(rootDir, files);
  return reports;
}

// verify runs the converter of the checkout it verifies, so a fixture root gets a copy of the
// data repository's scripts/.
function addConverter(rootDir) {
  cpSync(join(databaseDir, "scripts"), join(rootDir, "scripts"), {
    recursive: true,
  });
}

const headerOnlyOverrides = () => {
  const file = join(tempRoot(), "overrides.csv");
  writeFileSync(file, "source,surah,ayah,footnote,class,note\n");
  return file;
};

const verify = async (root) =>
  (
    await verifyRepository(root, {
      expected,
      overridesFile: headerOnlyOverrides(),
    })
  ).problems;

const findVerse = (input, sourceId, surah, ayah) =>
  input.surahsBySource[sourceId]
    .find((entry) => entry.id === surah)
    .verses.find((verse) => verse.ayah === ayah);

const read = (root, path) => readFileSync(join(root, path), "utf8");

test("version scheme is YYYY.MM.DD with an optional .N suffix from 2", () => {
  assert.deepEqual(parseVersion("2026.11.14"), [2026, 11, 14, 1]);
  assert.deepEqual(parseVersion("2026.11.14.2"), [2026, 11, 14, 2]);
  for (const bad of [
    "2026.11.14.1",
    "2026.13.01",
    "2026.02.30",
    "26.11.14",
    "2026-11-14",
  ])
    assert.equal(parseVersion(bad), null);
  assert.ok(compareVersions("2026.11.14.10", "2026.11.14.2") > 0);
  assert.ok(compareVersions("2026.11.14", "2026.11.14.2") < 0);
});

test("exports write one canonical CSV per surah + meta per source and are byte-identical on a re-run", () => {
  const first = tempRoot();
  const second = tempRoot();
  exportFixture(first, "2026.11.14");
  exportFixture(second, "2026.11.14");
  const before = snapshot(first);
  assert.deepEqual(snapshot(second), before);
  exportFixture(first, "2026.11.14");
  assert.deepEqual(snapshot(first), before);
  assert.deepEqual(Object.keys(before), [
    "CHANGELOG.md",
    "changes/2026.11.14.csv",
    "data/al-mukhtasar.meta.json",
    "data/al-mukhtasar/001.csv",
    "data/al-mukhtasar/108.csv",
    "data/al-mukhtasar/112.csv",
    "data/king-fahd.meta.json",
    "data/king-fahd/001.csv",
    "data/king-fahd/108.csv",
    "data/king-fahd/112.csv",
    "releases/2026.11.14.md",
  ]);
  for (const [path, content] of Object.entries(before)) {
    const text = content.toString("utf8");
    assert.ok(text.endsWith("\n"), `${path} ends with a newline`);
    assert.notEqual(content[0], 0xef, `${path} has no BOM`);
    assert.doesNotMatch(
      text,
      /2026-|T\d\d:\d\d/,
      `${path} carries no timestamp`,
    );
    if (!path.endsWith(".csv")) {
      for (const line of text.split("\n"))
        assert.doesNotMatch(
          line,
          /[ \t\r]$/,
          `${path} has no trailing whitespace`,
        );
    }
  }
  assert.equal(
    read(first, "changes/2026.11.14.csv"),
    "source,surah,ayah,footnote,old,new\n",
  );
  assert.match(
    read(first, "CHANGELOG.md"),
    /### king-fahd \(source 3\)\n\ninitial release\n/,
  );
  assert.match(
    read(first, "releases/2026.11.14.md"),
    /^# 2026\.11\.14\n\n## king-fahd \(source 3\)\n\nเผยแพร่ครั้งแรก ไม่มีการเปลี่ยนแปลง \(initial release, no changes\)\n/,
  );
});

test("canonical CSV and meta hold the stored text losslessly and record line breaks and mismatches", () => {
  const root = tempRoot();
  exportFixture(root, "2026.11.14");
  const csv = readPublishedCsv(root, "king-fahd");
  assert.ok(
    read(root, "data/king-fahd/108.csv").startsWith(
      "surah,ayah,footnote,text\n108,1,,",
    ),
  );
  assert.equal(
    csv,
    "surah,ayah,footnote,text\n" +
      ["001", "108", "112"]
        .map((n) =>
          read(root, `data/king-fahd/${n}.csv`).slice(
            "surah,ayah,footnote,text\n".length,
          ),
        )
        .join(""),
  );
  assert.ok(
    csv.startsWith(
      "surah,ayah,footnote,text\n1,1,,ด้วยพระนามของอัลลอฮฺ ผู้ทรงกรุณาปราณี ผู้ทรงเมตตาเสมอ\n",
    ),
  );
  assert.ok(
    csv.includes(
      '\n1,6,,"ขอพระองค์ทรงแนะนำพวกข้าพระองค์\r\nซึ่งทางอันเที่ยงตรง\t"\n',
    ),
  );
  assert.ok(
    csv.includes(
      '\n108,1,,แท้จริงเราได้ประทานอัลเกาซัรแก่เจ้าแล้ว (*1*)\n108,1,1,"อัลเกาซัร คือ ""แม่น้ำ"" ในสวรรค์, ตามรายงาน\nบรรทัดที่สอง"\n',
    ),
  );
  const meta = JSON.parse(read(root, "data/king-fahd.meta.json"));
  assert.deepEqual(Object.keys(meta), [
    "source",
    "version",
    "previousVersion",
    "verseCount",
    "footnoteCount",
    "sha256",
    "emptyTranslations",
    "footnoteMismatches",
    "embeddedLineBreaks",
  ]);
  assert.deepEqual(meta.source, {
    id: 3,
    slug: "king-fahd",
    name: "ศูนย์กษัตริย์ฟาฮัดเพื่อการพิมพ์กุรอาน (พร้อมเชิงอรรถ)",
    shortName: "ศูนย์กษัตริย์ฟาฮัด (เชิงอรรถ)",
    author: null,
    language: "th",
  });
  assert.deepEqual(
    [meta.version, meta.previousVersion, meta.verseCount],
    ["2026.11.14", null, 14],
  );
  assert.deepEqual(meta.embeddedLineBreaks, ["1:6", "108:1:1"]);
  assert.doesNotMatch(readPublishedCsv(root, "al-mukhtasar"), /بِسْمِ/);
});

test("the generated repository passes verify, and verify catches tampering and leftovers", async () => {
  const root = tempRoot();
  exportFixture(root, "2026.11.14");
  addConverter(root);
  assert.deepEqual(await verify(root), []);
  const csvPath = join(root, "data/king-fahd/001.csv");
  writeFileSync(
    csvPath,
    readFileSync(csvPath, "utf8")
      .replace("1,1,,ด้วยพระนาม", '1,1,,"ด้วยพระนาม')
      .replace("ผู้ทรงเมตตาเสมอ\n", 'ผู้ทรงเมตตาเสมอ"\n'),
  );
  let problems = await verify(root);
  assert.ok(
    problems.some((problem) =>
      problem.includes("sha256 of the joined data/king-fahd/*.csv"),
    ),
  );
  assert.ok(
    problems.includes(
      "king-fahd: data/king-fahd/001.csv is not in canonical form (quoting, order or line endings)",
    ),
  );
  writeFileSync(
    csvPath,
    readFileSync(csvPath, "utf8").replace("\n1,2,,", "\n1,9,,"),
  );
  problems = await verify(root);
  assert.ok(
    problems.some((problem) => problem.includes("breaks mushaf order")),
  );
  writeFileSync(join(root, "data/king-fahd.csv"), "surah,ayah,footnote,text\n");
  writeFileSync(join(root, "data/notes.txt"), "x\n");
  writeFileSync(join(root, "data/king-fahd/108.txt"), "x\n");
  problems = await verify(root);
  for (const message of [
    "data/king-fahd.csv is the old single-file layout; data/king-fahd/NNN.csv replaces it",
    "data/notes.txt is not a <slug>/ folder or <slug>.meta.json",
    "king-fahd: data/king-fahd/108.txt is not a surah file (NNN.csv)",
  ])
    assert.ok(problems.includes(message), message);
});

test("verify catches a row filed in another surah's file even though the joined text is unchanged", async () => {
  const root = tempRoot();
  exportFixture(root, "2026.11.14");
  addConverter(root);
  const header = "surah,ayah,footnote,text\n";
  const file108 = join(root, "data/al-mukhtasar/108.csv");
  const file112 = join(root, "data/al-mukhtasar/112.csv");
  const rows108 = readFileSync(file108, "utf8").slice(header.length);
  const lastRow = rows108.slice(rows108.lastIndexOf("\n", rows108.length - 2) + 1);
  writeFileSync(file108, header + rows108.slice(0, -lastRow.length));
  writeFileSync(file112, header + lastRow + readFileSync(file112, "utf8").slice(header.length));
  const problems = await verify(root);
  assert.ok(
    problems.some((problem) =>
      problem.startsWith("al-mukhtasar: data/al-mukhtasar/112.csv holds a row of surah 108"),
    ),
    problems.join("\n"),
  );
  assert.ok(!problems.some((problem) => problem.includes("sha256")));
});

test("an export over the old single-file layout reads it as the baseline and removes it", async () => {
  const root = tempRoot();
  exportFixture(root, "2026.11.14");
  for (const slug of ["king-fahd", "al-mukhtasar"]) {
    writeFileSync(join(root, `data/${slug}.csv`), readPublishedCsv(root, slug));
    rmSync(join(root, `data/${slug}`), { recursive: true });
  }
  exportFixture(root, "2026.11.15");
  assert.ok(!existsSync(join(root, "data/king-fahd.csv")));
  assert.ok(!existsSync(join(root, "data/al-mukhtasar.csv")));
  assert.ok(existsSync(join(root, "data/king-fahd/108.csv")));
  assert.equal(
    read(root, "changes/2026.11.15.csv"),
    "source,surah,ayah,footnote,old,new\n",
  );
  addConverter(root);
  assert.deepEqual(await verify(root), []);
});

test("verify runs the data repository's own converter and reports what it gets wrong", async () => {
  const root = tempRoot();
  exportFixture(root, "2026.11.14");
  assert.ok(
    (await verify(root)).some((problem) =>
      problem.includes("scripts/convert.mjs is missing"),
    ),
  );
  addConverter(root);
  assert.deepEqual(await verify(root), []);
  const jsonModule = join(root, "scripts/lib/json.mjs");
  writeFileSync(
    jsonModule,
    readFileSync(jsonModule, "utf8").replace(
      "translation: verse.translation,",
      "translation: verse.translation.trim(),",
    ),
  );
  assert.ok(
    (await verify(root)).some((problem) =>
      problem.includes("round trip canonical -> json -> canonical differs"),
    ),
  );
  const quranEncModule = join(root, "scripts/lib/quranenc.mjs");
  writeFileSync(
    quranEncModule,
    readFileSync(quranEncModule, "utf8").replace(
      "index + 1, verse.surah",
      "index + 2, verse.surah",
    ),
  );
  assert.ok(
    (await verify(root)).some((problem) =>
      /quranenc row 2 differs from 1:1/.test(problem),
    ),
  );
  writeFileSync(
    join(root, "scripts/convert.mjs"),
    'console.error("boom");\nprocess.exit(3);\n',
  );
  assert.ok(
    (await verify(root)).some((problem) =>
      /convert\.mjs --to all exited 3: boom/.test(problem),
    ),
  );
});

test("a release pair: notes declare every change beyond spelling verse by verse, typos only as spelling", async () => {
  const root = tempRoot();
  const typo = (input) => {
    const verse = findVerse(input, 3, 112, 4);
    verse.translation = verse.translation.replace("เสมอเหมือน", "เสมอเหมีอน");
  };
  exportFixture(root, "2026.11.01", typo);
  const changes = (input) => {
    findVerse(input, 3, 1, 1).translation =
      "ด้วยพระนามของอัลลอฮฺ ผู้ทรงกรุณาปราณี ผู้ทรงกรุณาเสมอ";
    findVerse(input, 4, 112, 4).translation += " ทั้งสิ้น";
    findVerse(input, 3, 108, 2).footnotes[0].text = findVerse(
      input,
      3,
      108,
      2,
    ).footnotes[0].text.replace(
      "ความโปรดปรานอันมากมาย",
      "ความเมตตาอันใหญ่หลวง",
    );
  };
  const reports = exportFixture(root, "2026.11.14", changes);
  assert.deepEqual(
    reports.map((report) => [
      report.slug,
      report.previousVersion,
      report.diff.refs,
    ]),
    [
      ["king-fahd", "2026.11.01", ["1:1", "108:2", "112:4"]],
      ["al-mukhtasar", "2026.11.01", ["112:4"]],
    ],
  );
  const notes = read(root, "releases/2026.11.14.md");
  const kingFahd = notes.split("## al-mukhtasar")[0];
  const declared = kingFahd
    .split("### การแก้ไขที่ไม่ใช่คำสะกด (Changes beyond spelling)")[1]
    .split("### แก้คำสะกด")[0];
  const spelling = kingFahd.split("### แก้คำสะกด (Spelling fixes)")[1];
  assert.match(
    declared,
    /- \*\*1:1\*\* — เปลี่ยนคำ \(word changed\)\n  - เดิม \(old\): ด้วยพระนามของอัลลอฮฺ ผู้ทรงกรุณาปราณี ผู้ทรง\*\*เมตตา\*\*เสมอ\n  - ใหม่ \(new\): ด้วยพระนามของอัลลอฮฺ ผู้ทรงกรุณาปราณี ผู้ทรง\*\*กรุณา\*\*เสมอ\n/,
  );
  assert.match(
    declared,
    /- \*\*108:2 เชิงอรรถ 1\*\* — เปลี่ยนคำ \(word changed\)\n  - เดิม \(old\): …นั้นด้วยความ\*\*โปรดปราน\*\*อันมากมาย…\n  - ใหม่ \(new\): …นั้นด้วยความ\*\*เมตตา\*\*อัน/,
  );
  assert.match(
    declared,
    /  - เดิม \(old\): …ความโปรดปรานอัน\*\*มากมาย\*\*ที่อัลลอฮฺทรง…\n  - ใหม่ \(new\): …ความเมตตาอัน\*\*ใหญ่หลวง\*\*ที่อัลลอฮฺทรง…\n/,
  );
  assert.doesNotMatch(declared, /112:4/);
  assert.match(spelling, /^\n\n- 112:4: เหมีอน -> เหมือน\n/);
  assert.match(
    notes,
    /## al-mukhtasar \(source 4\)[\s\S]*- \*\*112:4\*\* — เพิ่มคำ \(words added\)\n  - เดิม \(old\): …สร้างของพระองค์\n  - ใหม่ \(new\): …สร้างของพระองค์ \*\*ทั้งสิ้น\*\*\n/,
  );

  const changelog = read(root, "CHANGELOG.md");
  assert.match(
    changelog,
    /^# Changelog\n\n## 2026\.11\.14\n\nRelease notes: \[releases\/2026\.11\.14\.md\]\(releases\/2026\.11\.14\.md\)\n\n### king-fahd \(source 3\)\n\n3 verses changed, 1 footnote changed\n\nแก้คำสะกด \(spelling\): 1, เปลี่ยนคำ \(word changed\): 3\n\n1:1, 108:2, 112:4\n\n### al-mukhtasar \(source 4\)\n\n1 verse changed, 0 footnotes changed\n\nเพิ่มคำ \(words added\): 1\n\n112:4\n\n## 2026\.11\.01\n/,
  );
  assert.ok(existsSync(join(root, "releases/2026.11.01.md")));
  const changeRows = read(root, "changes/2026.11.14.csv").trim().split("\n");
  assert.equal(changeRows.length, 5);
  assert.match(
    changeRows[1],
    /^king-fahd,1,1,,ด้วยพระนามของอัลลอฮฺ ผู้ทรงกรุณาปราณี ผู้ทรงเมตตาเสมอ,/,
  );
  assert.match(changeRows[2], /^king-fahd,108,2,1,/);

  const afterFirstRun = snapshot(root);
  exportFixture(root, "2026.11.14", changes);
  assert.deepEqual(snapshot(root), afterFirstRun);
  assert.equal(
    (read(root, "CHANGELOG.md").match(/^## 2026\.11\.14$/gm) ?? []).length,
    1,
  );
  addConverter(root);
  assert.deepEqual(await verify(root), []);
  const meta = JSON.parse(read(root, "data/king-fahd.meta.json"));
  assert.deepEqual(
    [meta.version, meta.previousVersion],
    ["2026.11.14", "2026.11.01"],
  );
});

test("overrides.csv annotates a changed row, and an override on an unchanged row fails the export", () => {
  const root = tempRoot();
  const overrides = join(tempRoot(), "overrides.csv");
  exportFixture(root, "2026.11.01");
  const change = (input) => {
    findVerse(input, 3, 1, 1).translation =
      "ด้วยพระนามของอัลลอฮฺ ผู้ทรงกรุณาปราณี ผู้ทรงกรุณาเสมอ";
  };
  writeFileSync(
    overrides,
    "source,surah,ayah,footnote,class,note\nking-fahd,1,1,,,ตรงกับต้นฉบับภาษาอาหรับ\n",
  );
  exportFixture(root, "2026.11.14", change, overrides);
  assert.match(
    read(root, "releases/2026.11.14.md"),
    /- \*\*1:1\*\* — เปลี่ยนคำ \(word changed\) — หมายเหตุ \(note\): ตรงกับต้นฉบับภาษาอาหรับ\n/,
  );
  const before = snapshot(root);
  writeFileSync(
    overrides,
    "source,surah,ayah,footnote,class,note\nking-fahd,1,2,,spelling,\n",
  );
  assert.throws(
    () => exportFixture(root, "2026.11.14", change, overrides),
    (error) =>
      error instanceof ExportError &&
      /king-fahd 1:2 did not change in this release/.test(error.message),
  );
  assert.throws(
    () =>
      exportFixture(
        root,
        "2026.11.14",
        change,
        join(root, "missing-overrides.csv"),
      ),
    /missing-overrides\.csv does not exist/,
  );
  assert.deepEqual(snapshot(root), before);
});

test("a failing validation throws before anything is written", () => {
  const root = tempRoot();
  assert.throws(
    () =>
      exportFixture(root, "2026.11.14", (input) => {
        findVerse(input, 4, 112, 3).translation = "";
        findVerse(input, 3, 1, 4).footnotes = [];
      }),
    (error) =>
      error instanceof ExportError &&
      error.errors.length === 2 &&
      /source 4: 1 empty translations .*: 112:3/.test(error.message) &&
      /1:4: marker 1 has no footnote/.test(error.message),
  );
  assert.throws(
    () =>
      exportFixture(root, "2026.11.14", (input) => {
        findVerse(input, 3, 1, 4).footnotes.push({ number: 1, text: "ซ้ำ" });
        input.surahsBySource[3][0].verses.pop();
      }),
    (error) =>
      error instanceof ExportError &&
      /repeats a footnote number/.test(error.message) &&
      /verses_count says 7/.test(error.message),
  );
  assert.deepEqual(readdirSync(root), []);
});

test("an older version than the published one is refused", () => {
  const root = tempRoot();
  exportFixture(root, "2026.11.14");
  const before = snapshot(root);
  assert.throws(
    () => exportFixture(root, "2026.11.01"),
    /older than the published 2026\.11\.14/,
  );
  assert.deepEqual(snapshot(root), before);
});

test("the export CLI keeps the 114/6236 expectation unless the fixture-only test option is given", () => {
  const root = tempRoot();
  const overrides = headerOnlyOverrides();
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        join(toolingDir, "export.mjs"),
        "--version",
        "2026.11.14",
        "--db",
        root,
        "--overrides",
        overrides,
        ...args,
      ],
      { encoding: "utf8" },
    );
  const strict = run("--from-fixture", fixtureDir);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /3 surahs, expected 114/);
  assert.deepEqual(readdirSync(root), []);
  const refused = run("--test-expected-counts", "3,14");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /only accepted together with --from-fixture/);
  const ok = run(
    "--from-fixture",
    fixtureDir,
    "--test-expected-counts",
    "3,14",
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(join(root, "data/king-fahd.meta.json")));
  addConverter(root);
  const verified = spawnSync(
    process.execPath,
    [
      join(toolingDir, "verify.mjs"),
      "--db",
      root,
      "--overrides",
      overrides,
      "--test-expected-counts",
      "3,14",
    ],
    { encoding: "utf8" },
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /verify ok: al-mukhtasar, king-fahd/);
});

test("the data repository's convert CLI writes every format for every source, identically on a second run", () => {
  const root = tempRoot();
  exportFixture(root, "2026.11.14");
  const out = join(root, "out");
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        join(databaseDir, "scripts/convert.mjs"),
        "--root",
        root,
        "--out",
        out,
        ...args,
      ],
      { encoding: "utf8" },
    );
  const first = run("--to", "all");
  assert.equal(first.status, 0, first.stderr);
  const files = snapshot(out);
  assert.deepEqual(Object.keys(files), [
    "al-mukhtasar/json/al-mukhtasar.json",
    "al-mukhtasar/quran-com/al-mukhtasar.json",
    "al-mukhtasar/quranenc/al-mukhtasar.csv",
    "al-mukhtasar/tanzil/th.al-mukhtasar.txt",
    "king-fahd/json/king-fahd.json",
    "king-fahd/quran-com/king-fahd.json",
    "king-fahd/quranenc/king-fahd.csv",
    "king-fahd/tanzil/th.king-fahd.txt",
  ]);
  assert.equal(run("--to", "all", "--source", "all").status, 0);
  assert.deepEqual(snapshot(out), files);
  rmSync(out, { recursive: true });
  assert.equal(run("--to", "tanzil", "--source", "king-fahd").status, 0);
  assert.deepEqual(listFiles(out), ["king-fahd/tanzil/th.king-fahd.txt"]);
  assert.match(run("--to", "pdf").stderr, /unknown format "pdf"/);
  assert.match(
    run("--to", "json", "--source", "nope").stderr,
    /unknown source "nope"/,
  );
});
