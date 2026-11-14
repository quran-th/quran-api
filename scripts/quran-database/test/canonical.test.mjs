import assert from "node:assert/strict";
import { test } from "node:test";
import {
  embeddedLineBreaks,
  formatCanonical,
  parseCanonical,
  parseCanonicalRows,
  rowKey,
  toCanonicalRows,
} from "../lib/canonical.mjs";

const verses = [
  { sura: 1, aya: 1, translation: 'ด้วยพระนาม, "อัลลอฮฺ"', footnotes: [] },
  {
    sura: 2,
    aya: 3,
    translation: " สิ่งเร้นลับ(*1*) และละหมาด (*2*)\r\nต่อ\t",
    footnotes: [
      { number: 1, text: 'หมายถึง, "สิ่ง" ที่พ้นญาณวิสัย' },
      { number: 2, text: "บรรทัดหนึ่ง\nบรรทัดสอง\r\nบรรทัดสาม " },
    ],
  },
  { sura: 2, aya: 4, translation: "ธรรมดา", footnotes: [] },
];

test("canonical CSV: header, verse row then its footnote rows, byte-exact text", () => {
  const csv = formatCanonical(verses);
  assert.equal(
    csv,
    [
      "sura,aya,footnote,text",
      '1,1,,"ด้วยพระนาม, ""อัลลอฮฺ"""',
      '2,3,," สิ่งเร้นลับ(*1*) และละหมาด (*2*)\r\nต่อ\t"',
      '2,3,1,"หมายถึง, ""สิ่ง"" ที่พ้นญาณวิสัย"',
      '2,3,2,"บรรทัดหนึ่ง\nบรรทัดสอง\r\nบรรทัดสาม "',
      "2,4,,ธรรมดา",
      "",
    ].join("\n"),
  );
  assert.notEqual(csv.charCodeAt(0), 0xfeff);
});

test("canonical round trip returns the same verses, including CRLF, edge whitespace and multi-line footnotes", () => {
  assert.deepEqual(parseCanonical(formatCanonical(verses)), verses);
  assert.equal(
    formatCanonical(parseCanonical(formatCanonical(verses))),
    formatCanonical(verses),
  );
});

test("footnote rows are written ascending by number whatever the input order", () => {
  const shuffled = [
    { ...verses[1], footnotes: [...verses[1].footnotes].reverse() },
  ];
  assert.deepEqual(toCanonicalRows(shuffled).map(rowKey), [
    "2:3",
    "2:3:1",
    "2:3:2",
  ]);
});

test("the reader rejects rows out of mushaf order or footnotes away from their verse", () => {
  const header = "sura,aya,footnote,text\n";
  assert.throws(
    () => parseCanonical(`${header}1,2,,ก\n1,1,,ข\n`),
    /breaks mushaf order/,
  );
  assert.throws(
    () => parseCanonical(`${header}1,1,,ก\n1,1,,ข\n`),
    /breaks mushaf order/,
  );
  assert.throws(
    () => parseCanonical(`${header}1,1,1,ก\n`),
    /does not follow its verse row/,
  );
  assert.throws(
    () => parseCanonical(`${header}1,1,,ก\n1,2,1,ข\n`),
    /does not follow its verse row/,
  );
  assert.throws(
    () => parseCanonical(`${header}1,1,,ก\n1,1,2,ข\n1,1,1,ค\n`),
    /not ascending/,
  );
  assert.throws(
    () => parseCanonical(`${header}1,x,,ก\n`),
    /not a positive integer/,
  );
  assert.throws(
    () => parseCanonical("sura,aya,text\n1,1,ก\n"),
    /unexpected CSV header/,
  );
  assert.deepEqual(parseCanonicalRows(`${header}1,1,,\n`), [
    { sura: "1", aya: "1", footnote: "", text: "" },
  ]);
});

test("embeddedLineBreaks lists verse and footnote row keys that contain CR or LF", () => {
  assert.deepEqual(embeddedLineBreaks(verses), ["2:3", "2:3:2"]);
});
