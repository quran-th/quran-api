import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeChange,
  applyOverrides,
  changedWordPair,
  classifyHunk,
  editDistance,
  isSpellingOnly,
  parseOverrides,
  renderReleaseNotes,
  tokenize,
} from "../lib/notes.mjs";
import { diffSource } from "../lib/diff.mjs";

const change = (old, next, footnote = "") => ({
  surah: "2",
  ayah: "197",
  footnote,
  old,
  new: next,
});
const classes = (old, next) =>
  analyzeChange(change(old, next)).hunks.map((hunk) => hunk.class);
const runtime = { node: "22.0.0", icu: "77.1" };

test("tokenize keeps (*n*) markers atomic and whitespace/punctuation as their own tokens", () => {
  assert.deepEqual(
    tokenize("ก(*1*) ข, ค").map((token) => [token.text, token.kind]),
    [
      ["ก", "word"],
      ["(*1*)", "marker"],
      [" ", "punct"],
      ["ข", "word"],
      [",", "punct"],
      [" ", "punct"],
      ["ค", "word"],
    ],
  );
  assert.equal(tokenize("ซ้ำ ๆ").at(-1).kind, "word");
});

test("editDistance counts code points", () => {
  assert.equal(editDistance("โช่", "โซ่"), 1);
  assert.equal(editDistance("สรรค์", "สวรรค์"), 1);
  assert.equal(editDistance("เมตตา", "กรุณา"), 4);
});

test("the real typo pairs are spelling, also when the typo changes how ICU segments its neighbours", () => {
  const pairs = (old, next) =>
    analyzeChange(change(old, next)).hunks.map((hunk) => [
      hunk.class,
      ...(hunk.pair ?? []),
    ]);
  assert.deepEqual(
    pairs(
      "ถูกมัดติดกับต้นคอด้วยโช่ตรวน และจะถูกลากไป",
      "ถูกมัดติดกับต้นคอด้วยโซ่ตรวน และจะถูกลากไป",
    ),
    [["spelling", "โช่", "โซ่"]],
  );
  assert.deepEqual(
    pairs(
      "เท้าของบรรดานักโทษถูกล่ามโช่ตรึงไว้กับต้นคอ",
      "เท้าของบรรดานักโทษถูกล่ามโซ่ตรึงไว้กับต้นคอ",
    ),
    [["spelling", "โช่", "โซ่"]],
  );
  assert.deepEqual(pairs("ในสรวงสรรค์ของพระองค์", "ในสรวงสวรรค์ของพระองค์"), [
    ["spelling", "สรรค์", "สวรรค์"],
  ]);
  assert.deepEqual(
    pairs(
      "วันเสาร์ที่เจ็ดเดือนเซาวาล ในปีที่สาม",
      "วันเสาร์ที่เจ็ดเดือนเชาวาล ในปีที่สาม",
    ),
    [["spelling", "เซา", "เชา"]],
  );
  assert.deepEqual(
    tokenize("ถูกล่ามด้วยโช่ตรวน").map((token) => token.text),
    ["ถูก", "ล่า", "มด้วยโช่", "ตรวน"],
  );
  assert.deepEqual(
    changedWordPair(tokenize("ล่ามด้วยโช่"), tokenize("ล่ามด้วยกุญแจ")),
    ["โช่", "กุญแจ"],
  );
  assert.equal(
    classifyHunk(tokenize("ล่ามด้วยโช่"), tokenize("ล่ามด้วยกุญแจ")),
    "wordChanged",
  );
  assert.equal(
    changedWordPair(tokenize("ล่ามด้วยโช่"), tokenize("ผูกด้วยโซ่")),
    null,
  );
  assert.equal(
    classifyHunk(tokenize("ล่ามด้วยโช่"), tokenize("ผูกด้วยโซ่")),
    "wordChanged",
  );
  assert.equal(
    isSpellingOnly(analyzeChange(change("ด้วยโช่ตรวน", "ด้วยโซ่ตรวน"))),
    true,
  );
});

test("punctuation, marker, word changed, words added and words removed", () => {
  assert.deepEqual(classes("ก ข", "ก, ข"), ["punctuation"]);
  assert.deepEqual(classes("ผู้ทรงเมตตา  เสมอ", "ผู้ทรงเมตตา เสมอ"), [
    "punctuation",
  ]);
  assert.deepEqual(classes("วันตอบแทน (*1*)", "วันตอบแทน (*2*)"), ["marker"]);
  assert.deepEqual(classes("วันตอบแทน", "วันตอบแทน (*1*)"), ["marker"]);
  assert.deepEqual(classes("ผู้ทรงเมตตาเสมอ", "ผู้ทรงกรุณาเสมอ"), [
    "wordChanged",
  ]);
  assert.deepEqual(
    classes("พระองค์คืออัลลอฮฺ", "พระองค์คืออัลลอฮฺผู้ทรงเอกะ"),
    ["wordsAdded"],
  );
  assert.deepEqual(
    classes("พระองค์คืออัลลอฮฺผู้ทรงเอกะ", "พระองค์คืออัลลอฮฺ"),
    ["wordsRemoved"],
  );
  assert.equal(classifyHunk(tokenize("ก"), tokenize("ข")), "wordChanged");
  assert.equal(
    classifyHunk(tokenize("เมตตา"), tokenize("เมตตา,")),
    "wordChanged",
  );
});

test("a row with a spelling fix and a word change is declared, row additions and removals always are", () => {
  const analysis = analyzeChange(
    change("ด้วยโช่ตรวน และผู้ทรงเมตตาเสมอ", "ด้วยโซ่ตรวน และผู้ทรงกรุณาเสมอ"),
  );
  assert.deepEqual(
    analysis.hunks.map((hunk) => hunk.class),
    ["spelling", "wordChanged"],
  );
  assert.equal(isSpellingOnly(analysis), false);
  assert.deepEqual(
    analyzeChange(change("", "ใหม่", "1")).hunks.map((hunk) => hunk.class),
    ["rowAdded"],
  );
  assert.deepEqual(
    analyzeChange(change("เก่า", "")).hunks.map((hunk) => hunk.class),
    ["rowRemoved"],
  );
  assert.equal(analyzeChange(change("", "ใหม่", "1")).ref, "2:197 เชิงอรรถ 1");
});

test("excerpts bold the change with ~3 words of context, or show a short row in full", () => {
  const short = analyzeChange(change("ผู้ทรงเมตตาเสมอ", "ผู้ทรงกรุณาเสมอ"))
    .hunks[0];
  assert.equal(short.oldExcerpt, "ผู้ทรง**เมตตา**เสมอ");
  assert.equal(short.newExcerpt, "ผู้ทรง**กรุณา**เสมอ");
  const long = "หนึ่ง สอง สาม สี่ ห้า หก เจ็ด แปด เก้า สิบ ช้าง ม้า วัว ควาย";
  const hunk = analyzeChange(change(long, long.replace("เจ็ด", "เจ็ด ปลา")))
    .hunks[0];
  assert.equal(hunk.class, "wordsAdded");
  assert.equal(hunk.oldExcerpt, "…ห้า หก เจ็ด แปด เก้า สิบ…");
  assert.equal(hunk.newExcerpt, "…ห้า หก เจ็ด **ปลา** แปด เก้า สิบ…");
  assert.equal(
    analyzeChange(change("ก (*1*)", "ข (*1*)")).hunks[0].oldExcerpt,
    "**ก** (\\*1\\*)",
  );
});

test("overrides reclassify and annotate a changed row, and fail loudly on rows that did not change", () => {
  const diff = diffSource(
    "king-fahd",
    [{ surah: "2", ayah: "197", footnote: "", text: "ผู้ทรงเมตตาเสมอ" }],
    [{ surah: "2", ayah: "197", footnote: "", text: "ผู้ทรงกรุณาเสมอ" }],
  );
  const analyses = diff.changes.map(analyzeChange);
  const csv = (rows) =>
    `source,surah,ayah,footnote,class,note\n${rows.join("\n")}\n`;
  const { records, errors } = parseOverrides(
    csv(["king-fahd,2,197,,spelling,ตรงกับฉบับพิมพ์"]),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(applyOverrides({ "king-fahd": analyses }, records), []);
  assert.equal(analyses[0].hunks[0].class, "spelling");
  assert.equal(analyses[0].note, "ตรงกับฉบับพิมพ์");
  const notes = renderReleaseNotes(
    "2026.11.14",
    [{ sourceId: 3, diff, analyses }],
    runtime,
  );
  assert.match(
    notes,
    /- 2:197: เมตตา -> กรุณา — จัดประเภทเอง \(manual class\); หมายเหตุ \(note\): ตรงกับฉบับพิมพ์/,
  );

  const fresh = () => ({ "king-fahd": diff.changes.map(analyzeChange) });
  assert.deepEqual(
    applyOverrides(
      fresh(),
      parseOverrides(csv(["king-fahd,2,198,,,เหตุผล"])).records,
    ),
    ["overrides.csv: king-fahd 2:198 did not change in this release"],
  );
  assert.deepEqual(
    applyOverrides(
      fresh(),
      parseOverrides(csv(["al-mukhtasar,2,197,,,เหตุผล"])).records,
    ),
    ["overrides.csv: al-mukhtasar 2:197 did not change in this release"],
  );
  assert.match(
    applyOverrides(
      fresh(),
      parseOverrides(csv(["king-fahd,2,197,,rowAdded,"])).records,
    )[0],
    /cannot be reclassified as rowAdded/,
  );
  assert.match(
    parseOverrides(csv(["king-fahd,2,197,,typo,"])).errors[0],
    /unknown class "typo"/,
  );
  assert.match(
    parseOverrides(csv(["king-fahd,2,197,,,"])).errors[0],
    /neither a class nor a note/,
  );
  assert.match(
    parseOverrides(csv(["king-fahd,2,197,,,ก", "king-fahd,2,197,,,ข"]))
      .errors[0],
    /listed twice/,
  );
});

test("release notes are deterministic and record Node and ICU versions", () => {
  const diff = diffSource(
    "king-fahd",
    [{ surah: "1", ayah: "1", footnote: "", text: "ด้วยโช่ตรวน" }],
    [{ surah: "1", ayah: "1", footnote: "", text: "ด้วยโซ่ตรวน" }],
  );
  const render = () =>
    renderReleaseNotes(
      "2026.11.14",
      [{ sourceId: 3, diff, analyses: diff.changes.map(analyzeChange) }],
      runtime,
    );
  assert.equal(render(), render());
  assert.match(
    render(),
    /สร้างด้วย \(generated with\) Node 22\.0\.0, ICU 77\.1\n$/,
  );
  assert.match(
    render(),
    /### การแก้ไขที่ไม่ใช่คำสะกด \(Changes beyond spelling\)\n\nไม่มี \(none\)\n/,
  );
  const initial = renderReleaseNotes(
    "2026.11.14",
    [{ sourceId: 3, diff: diffSource("king-fahd", null, []), analyses: [] }],
    runtime,
  );
  assert.match(
    initial,
    /## king-fahd \(source 3\)\n\nเผยแพร่ครั้งแรก ไม่มีการเปลี่ยนแปลง \(initial release, no changes\)/,
  );
});
