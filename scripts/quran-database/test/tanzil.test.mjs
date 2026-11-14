import assert from "node:assert/strict";
import { test } from "node:test";
import { importDatabaseModule, resolveDatabaseDir } from "../lib/database.mjs";

const { readTanzil, tanzilText, toTanzil } = await importDatabaseModule(
  resolveDatabaseDir(),
  "tanzil.mjs",
);

const info = {
  name: "ชื่อ",
  translator: "ผู้แปล",
  language: "Thai",
  id: "th.test",
  source: "Open Thai Quran Project",
};

test("tanzilText strips markers, joins lines, trims edges and replaces pipes", () => {
  assert.deepEqual(tanzilText("อะลิฟ ลาม มีม (*1*)"), {
    text: "อะลิฟ ลาม มีม",
    newlineReplaced: false,
    whitespaceTrimmed: false,
    pipeReplaced: false,
  });
  assert.deepEqual(tanzilText("ก\r\nข\nค\t"), {
    text: "ก ข ค",
    newlineReplaced: true,
    whitespaceTrimmed: true,
    pipeReplaced: false,
  });
  assert.deepEqual(tanzilText("ก | ข"), {
    text: "ก / ข",
    newlineReplaced: false,
    whitespaceTrimmed: false,
    pipeReplaced: true,
  });
});

test("toTanzil writes sura|aya|text lines followed by the tanzil.net style trailer", () => {
  const verses = [
    { sura: 1, aya: 1, translation: "ด้วยพระนามของอัลลอฮฺ (*1*)" },
    { sura: 1, aya: 2, translation: "บรรทัด\r\nใหม่ " },
  ];
  const { content, adjustments } = toTanzil(verses, info);
  assert.equal(
    content,
    [
      "1|1|ด้วยพระนามของอัลลอฮฺ",
      "1|2|บรรทัด ใหม่",
      "",
      "",
      "# --------------------------------------------------------------------",
      "#",
      "#  Quran Translation",
      "#  Name: ชื่อ",
      "#  Translator: ผู้แปล",
      "#  Language: Thai",
      "#  ID: th.test",
      "#  Source: Open Thai Quran Project",
      "#",
      "# --------------------------------------------------------------------",
      "",
    ].join("\n"),
  );
  assert.deepEqual(adjustments, {
    newlinesReplaced: ["1:2"],
    whitespaceTrimmed: ["1:2"],
    pipesReplaced: [],
  });
  const parsed = readTanzil(content);
  assert.equal(parsed.verses.length, 2);
  assert.deepEqual(parsed.verses[1], { sura: 1, aya: 2, text: "บรรทัด ใหม่" });
  assert.equal(parsed.trailer.length, 10);
  for (const line of content.split("\n")) assert.doesNotMatch(line, /\s$/);
});

test("readTanzil rejects malformed files", () => {
  assert.throws(() => readTanzil("1|1|a|b\n\n\n#\n"), /has 4 fields/);
  assert.throws(() => readTanzil("1|1|a \n\n\n#\n"), /ends in whitespace/);
  assert.throws(() => readTanzil("1|1|a\n"), /trailer/);
  assert.throws(() => readTanzil("1|1|a\r\n\n\n#\n"), /CR/);
});
