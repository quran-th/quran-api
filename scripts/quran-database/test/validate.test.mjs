import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_COUNTS,
  testExpectedCounts,
  validateSource,
} from "../lib/validate.mjs";

const verse = (surah, ayah, translation = "คำแปล", footnotes = []) => ({
  surah,
  ayah,
  arabic: "ع",
  translation,
  footnotes,
});
const surah = (id, verses) => ({ id, versesCount: verses.length, verses });
const twoSurahs = () => [
  surah(1, [verse(1, 1), verse(1, 2, "ก(*1*)", [{ number: 1, text: "ข" }])]),
  surah(3, [verse(3, 1)]),
];
const expected = testExpectedCounts(2, 3);

test("a consistent partial Quran passes with explicit test counts", () => {
  assert.deepEqual(validateSource(3, twoSurahs(), { expected }), {
    errors: [],
    emptyTranslations: [],
    footnoteMismatches: [],
  });
});

test("the real expectations are 114 surahs and 6236 verses and are applied by default", () => {
  assert.deepEqual(
    [EXPECTED_COUNTS.surahs, EXPECTED_COUNTS.verses],
    [114, 6236],
  );
  const { errors } = validateSource(3, twoSurahs());
  assert.ok(errors.some((error) => error.includes("2 surahs, expected 114")));
  assert.ok(errors.some((error) => error.includes("3 verses, expected 6236")));
  assert.ok(errors.some((error) => error.includes("surah 2 is missing")));
});

test("non-contiguous verse numbers and verses_count mismatches fail", () => {
  const surahs = twoSurahs();
  surahs[0].verses[1].ayah = 3;
  surahs[1].versesCount = 2;
  const { errors } = validateSource(3, surahs, { expected });
  assert.ok(errors.some((error) => error.includes("verse 2 is numbered 3")));
  assert.ok(errors.some((error) => error.includes("verses_count says 2")));
});

test("empty translations fail unless allowed, and are listed either way", () => {
  const surahs = twoSurahs();
  surahs[1].verses[0].translation = "  ";
  const strict = validateSource(3, surahs, { expected });
  assert.equal(strict.errors.length, 1);
  assert.match(strict.errors[0], /1 empty translations .*: 3:1/);
  const allowed = validateSource(3, surahs, { expected, allowEmpty: true });
  assert.deepEqual([allowed.errors, allowed.emptyTranslations], [[], ["3:1"]]);
});

test("marker/footnote mismatches fail in both directions unless allowed", () => {
  const surahs = twoSurahs();
  surahs[0].verses[0] = verse(1, 1, "ก(*1*)");
  surahs[1].verses[0] = verse(3, 1, "ก", [{ number: 1, text: "ข" }]);
  const strict = validateSource(3, surahs, { expected });
  assert.equal(strict.errors.length, 1);
  assert.match(strict.errors[0], /1:1: marker 1 has no footnote/);
  assert.match(strict.errors[0], /3:1: footnote 1 has no marker/);
  const allowed = validateSource(3, surahs, {
    expected,
    allowFootnoteMismatch: true,
  });
  assert.deepEqual(allowed.errors, []);
  assert.deepEqual(allowed.footnoteMismatches, [
    "1:1: marker 1 has no footnote",
    "3:1: footnote 1 has no marker",
  ]);
});

test("repeated footnote numbers and empty footnotes fail", () => {
  const surahs = twoSurahs();
  surahs[0].verses[1].footnotes = [
    { number: 1, text: "ข" },
    { number: 1, text: "" },
  ];
  const { errors } = validateSource(3, surahs, { expected });
  assert.ok(
    errors.some((error) => error.includes("repeats a footnote number")),
  );
  assert.ok(errors.some((error) => error.includes("footnote 1 is empty")));
});
