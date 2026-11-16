import assert from "node:assert/strict";
import { test } from "node:test";
import { toCanonicalRows } from "../lib/canonical.mjs";
import { renderSection, upsertSection } from "../lib/changelog.mjs";
import {
  diffSource,
  formatChanges,
  parseChanges,
  revertChanges,
} from "../lib/diff.mjs";
import { analyzeChange, countClasses } from "../lib/notes.mjs";

const verse = (sura, aya, translation, footnotes = []) => ({
  sura,
  aya,
  translation,
  footnotes,
});
const notes = (...texts) =>
  texts.map((text, index) => ({ number: index + 1, text }));

const previous = toCanonicalRows([
  verse(1, 1, "เดิม"),
  verse(1, 2, "ไม่เปลี่ยน", notes("เชิงอรรถ")),
  verse(1, 3, "เชิงอรรถเปลี่ยน(*1*)", notes("เก่า")),
  verse(1, 4, "ถูกลบ", notes("ลบด้วย")),
]);
const current = toCanonicalRows([
  verse(1, 1, 'ใหม่, "แก้"'),
  verse(1, 2, "ไม่เปลี่ยน", notes("เชิงอรรถ")),
  verse(1, 3, "เชิงอรรถเปลี่ยน(*1*)(*2*)", notes("ใหม่", "เพิ่ม")),
  verse(1, 5, "เพิ่มเข้ามา"),
]);

const entry = (sourceId, diff) => ({
  sourceId,
  diff,
  counts: countClasses(diff.changes.map(analyzeChange)),
});

test("diffSource keys rows by (sura, aya, footnote): verse and footnote rows added, removed and changed", () => {
  const diff = diffSource("king-fahd", previous, current);
  assert.deepEqual(diff.rows, [
    ["king-fahd", "1", "1", "", "เดิม", 'ใหม่, "แก้"'],
    [
      "king-fahd",
      "1",
      "3",
      "",
      "เชิงอรรถเปลี่ยน(*1*)",
      "เชิงอรรถเปลี่ยน(*1*)(*2*)",
    ],
    ["king-fahd", "1", "3", "1", "เก่า", "ใหม่"],
    ["king-fahd", "1", "3", "2", "", "เพิ่ม"],
    ["king-fahd", "1", "4", "", "ถูกลบ", ""],
    ["king-fahd", "1", "4", "1", "ลบด้วย", ""],
    ["king-fahd", "1", "5", "", "", "เพิ่มเข้ามา"],
  ]);
  assert.deepEqual(diff.refs, ["1:1", "1:3", "1:4", "1:5"]);
  assert.deepEqual(
    [diff.footnotesChanged, diff.added, diff.removed],
    [3, 1, 1],
  );
  assert.equal(
    formatChanges([diff]).split("\n", 1)[0],
    "source,sura,aya,footnote,old,new",
  );
});

test("diffSource is empty for identical input and marks a missing previous release as initial", () => {
  const same = diffSource("king-fahd", current, current);
  assert.deepEqual([same.rows, same.refs, same.footnotesChanged], [[], [], 0]);
  assert.equal(diffSource("king-fahd", null, current).initial, true);
});

test("revertChanges rebuilds the previous rows, so a re-run reproduces the same diff", () => {
  const diff = diffSource("king-fahd", previous, current);
  const records = parseChanges(formatChanges([diff]));
  const restored = revertChanges(current, records, "king-fahd");
  assert.deepEqual(restored, previous);
  assert.deepEqual(diffSource("king-fahd", restored, current).rows, diff.rows);
  assert.deepEqual(revertChanges(current, records, "other-source"), current);
});

test("CHANGELOG sections are newest first, link the release notes, and a re-run replaces its own section", () => {
  const diff = diffSource("king-fahd", previous, current);
  const first = upsertSection(
    "",
    "2026.11.01",
    renderSection("2026.11.01", [
      entry(3, diffSource("king-fahd", null, previous)),
    ]),
  );
  assert.equal(
    first,
    "# Changelog\n\n## 2026.11.01\n\nRelease notes: [releases/2026.11.01.md](releases/2026.11.01.md)\n\n### king-fahd (source 3)\n\ninitial release\n",
  );
  const section = renderSection("2026.11.14", [entry(3, diff)]);
  const second = upsertSection(first, "2026.11.14", section);
  assert.match(
    second,
    /^# Changelog\n\n## 2026\.11\.14\n\nRelease notes: \[releases\/2026\.11\.14\.md\]\(releases\/2026\.11\.14\.md\)\n\n### king-fahd \(source 3\)\n\n4 verses changed, 3 footnotes changed \(1 added, 1 removed\)\n\nเชิงอรรถเครื่องหมาย \(marker\): 1, เปลี่ยนคำ \(word changed\): 2, แถวใหม่ \(row added\): 2, แถวที่ลบ \(row removed\): 2\n\n1:1, 1:3, 1:4, 1:5\n\n## 2026\.11\.01\n/,
  );
  assert.equal(upsertSection(second, "2026.11.14", section), second);
  const replaced = upsertSection(
    second,
    "2026.11.14",
    renderSection("2026.11.14", [
      entry(3, diffSource("king-fahd", current, current)),
    ]),
  );
  assert.equal((replaced.match(/^## 2026\.11\.14$/gm) ?? []).length, 1);
  assert.match(
    replaced,
    /### king-fahd \(source 3\)\n\nno changes\n\n## 2026\.11\.01/,
  );
});
