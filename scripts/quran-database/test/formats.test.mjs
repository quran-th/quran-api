import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCanonical, parseCanonical } from "../lib/canonical.mjs";
import { parseCsv } from "../lib/csv.mjs";
import { importDatabaseModule, resolveDatabaseDir } from "../lib/database.mjs";

// The converter under test is the data repository's own (../quran-database by default).
const databaseDir = resolveDatabaseDir();
const { FORMATS, convertSource, outputPath } = await importDatabaseModule(
  databaseDir,
  "convert.mjs",
);
const { restoreMarkers, toQuranComTranslation } = await importDatabaseModule(
  databaseDir,
  "qurancom.mjs",
);
const { quranEncFootnotes } = await importDatabaseModule(
  databaseDir,
  "quranenc.mjs",
);
const { readTanzil } = await importDatabaseModule(databaseDir, "tanzil.mjs");

const meta = {
  source: {
    id: 3,
    slug: "king-fahd",
    name: "ชื่อแหล่ง",
    shortName: "ชื่อย่อ",
    author: null,
    language: "th",
  },
};
const canonical = [
  "sura,aya,footnote,text",
  '1,1,,"ด้วยพระนาม, ""อัลลอฮฺ"""',
  '2,3,,"สิ่งเร้นลับ(*1*) และละหมาด (*2*)\r\nต่อ\t"',
  '2,3,1,"หมายถึง, ""สิ่ง"" ที่พ้นญาณวิสัย"',
  '2,3,2,"บรรทัดหนึ่ง\nบรรทัดสอง"',
  "",
].join("\n");
const verses = parseCanonical(canonical);
const convert = () => convertSource(meta, verses).files;
const output = (format) => convert()[outputPath(format, "king-fahd", "th")];

test("convert writes every format at its documented path", () => {
  assert.deepEqual(Object.keys(convert()), [
    "king-fahd/quranenc/king-fahd.csv",
    "king-fahd/tanzil/th.king-fahd.txt",
    "king-fahd/quran-com/king-fahd.json",
    "king-fahd/json/king-fahd.json",
  ]);
  assert.deepEqual(FORMATS, ["quranenc", "tanzil", "qurancom", "json"]);
  assert.deepEqual(Object.keys(convertSource(meta, verses, ["tanzil"]).files), [
    "king-fahd/tanzil/th.king-fahd.txt",
  ]);
  assert.throws(() => convertSource(meta, verses, ["pdf"]), /unknown format/);
});

test('QuranEnc CSV has the download columns, running ids and "[n] text" footnotes joined by LF', () => {
  const csv = output("quranenc");
  assert.ok(
    csv.startsWith(
      'id,sura,aya,translation,footnotes\n1,1,1,"ด้วยพระนาม, ""อัลลอฮฺ""",\n2,2,3,',
    ),
  );
  const rows = parseCsv(csv);
  assert.deepEqual(rows[2], [
    "2",
    "2",
    "3",
    "สิ่งเร้นลับ(*1*) และละหมาด (*2*)\r\nต่อ\t",
    '[1] หมายถึง, "สิ่ง" ที่พ้นญาณวิสัย\n[2] บรรทัดหนึ่ง\nบรรทัดสอง',
  ]);
  assert.equal(quranEncFootnotes([]), "");
});

test("Tanzil strips markers, joins lines and trims, then adds the trailer", () => {
  const tanzil = readTanzil(output("tanzil"));
  assert.deepEqual(tanzil.verses, [
    { sura: 1, aya: 1, text: 'ด้วยพระนาม, "อัลลอฮฺ"' },
    { sura: 2, aya: 3, text: "สิ่งเร้นลับ และละหมาด ต่อ" },
  ]);
  assert.equal(tanzil.trailer.length, 10);
  assert.ok(tanzil.trailer.includes("#  Name: ชื่อย่อ"));
  assert.ok(tanzil.trailer.includes("#  Translator: ชื่อแหล่ง"));
  assert.ok(tanzil.trailer.includes("#  ID: th.king-fahd"));
  assert.deepEqual(convertSource(meta, verses, ["tanzil"]).tanzilAdjustments, {
    newlinesReplaced: ["2:3"],
    whitespaceTrimmed: ["2:3"],
    pipesReplaced: [],
  });
});

test("Quran.com JSON uses reference-derived footnote ids and restores to the stored text", () => {
  const document = JSON.parse(output("qurancom"));
  assert.deepEqual(document.meta, {
    translation_name: "ชื่อแหล่ง",
    author_name: null,
    language_name: "thai",
    slug: "king-fahd",
  });
  const item = document.translations[1];
  assert.equal(
    item.text,
    "สิ่งเร้นลับ<sup foot_note=300200301>1</sup> และละหมาด <sup foot_note=300200302>2</sup>\r\nต่อ\t",
  );
  assert.deepEqual(item.foot_notes, {
    300200301: 'หมายถึง, "สิ่ง" ที่พ้นญาณวิสัย',
    300200302: "บรรทัดหนึ่ง\nบรรทัดสอง",
  });
  assert.equal(restoreMarkers(item.text), verses[1].translation);
  assert.deepEqual(document.translations[0].foot_notes, {});
});

test("Quran.com keeps a marker without a footnote as (*n*) and lists a footnote without a marker", () => {
  const item = toQuranComTranslation(3, {
    sura: 2,
    aya: 3,
    translation: "ก(*1*) ข (*2*) ค(*1*)",
    footnotes: [
      { number: 1, text: "หนึ่ง" },
      { number: 3, text: "ไม่มีเครื่องหมาย" },
    ],
  });
  assert.equal(
    item.text,
    "ก<sup foot_note=300200301>1</sup> ข (*2*) ค<sup foot_note=300200301>1</sup>",
  );
  assert.deepEqual(item.foot_notes, {
    300200301: "หนึ่ง",
    300200303: "ไม่มีเครื่องหมาย",
  });
});

test("generic JSON is keyed by sura:aya, lossless, and converts back to the same canonical CSV", () => {
  const text = output("json");
  assert.ok(
    text.startsWith(
      '{\n  "meta": {\n    "sourceId": 3,\n    "slug": "king-fahd",',
    ),
  );
  const document = JSON.parse(text);
  assert.deepEqual(Object.keys(document.verses), ["1:1", "2:3"]);
  assert.deepEqual(document.verses["2:3"], {
    translation: verses[1].translation,
    footnotes: verses[1].footnotes,
  });
  const back = Object.entries(document.verses).map(([key, value]) => {
    const [sura, aya] = key.split(":").map(Number);
    return { sura, aya, ...value };
  });
  assert.equal(formatCanonical(back), canonical);
});

test("converting twice gives identical bytes", () => {
  assert.deepEqual(convert(), convert());
});
