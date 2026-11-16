import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCsv,
  formatField,
  parseCsv,
  parseCsvObjects,
} from "../lib/csv.mjs";

test("formatField quotes only when RFC 4180 or edge whitespace requires it", () => {
  assert.equal(formatField("อัลลอฮฺ"), "อัลลอฮฺ");
  assert.equal(formatField("a,b"), '"a,b"');
  assert.equal(formatField('say "hi"'), '"say ""hi"""');
  assert.equal(formatField("line1\r\nline2"), '"line1\r\nline2"');
  assert.equal(formatField("line1\nline2"), '"line1\nline2"');
  assert.equal(formatField("trailing tab\t"), '"trailing tab\t"');
  assert.equal(formatField(" leading"), '" leading"');
  assert.equal(formatField(""), "");
  assert.equal(formatField(42), "42");
});

test("formatCsv uses LF records, a trailing newline and no BOM", () => {
  const text = formatCsv([
    ["a", "b"],
    ["1", "x,y"],
  ]);
  assert.equal(text, 'a,b\n1,"x,y"\n');
  assert.notEqual(text.charCodeAt(0), 0xfeff);
});

test("round trip keeps Thai text with commas, quotes, CRLF, LF and tabs byte-identical", () => {
  const rows = [
    ["id", "text"],
    ["1", 'การสรรเสริญทั้งหลายนั้น, เป็นสิทธิของ "อัลลอฮฺ"'],
    ["2", "บรรทัดแรก\r\nบรรทัดสอง"],
    ["3", "ก\nข\rค"],
    ["4", "ท้ายมีแท็บ\t"],
    ["5", ""],
    ["6", '""'],
  ];
  assert.deepEqual(parseCsv(formatCsv(rows)), rows);
});

test("parseCsv is strict", () => {
  assert.throws(() => parseCsv("a,b\n1\n"), /record 2 has 1 fields/);
  assert.throws(() => parseCsv('a,b\n1,"x'), /does not end with a newline/);
  assert.throws(() => parseCsv('a,b\n1,"x\n'), /unterminated quoted field/);
  assert.throws(() => parseCsv('a,b\n1,x"y\n'), /bare quote/);
  assert.throws(() => parseCsv('a,b\n1,"x"y\n'), /after closing quote/);
  assert.throws(() => parseCsv("a,b\n1,x\ry\n"), /bare CR/);
  assert.throws(() => parseCsv("﻿a\n"), /BOM/);
});

test("parseCsvObjects checks the header", () => {
  assert.deepEqual(parseCsvObjects("a,b\n1,2\n", ["a", "b"]), [
    { a: "1", b: "2" },
  ]);
  assert.throws(
    () => parseCsvObjects("a,c\n1,2\n", ["a", "b"]),
    /unexpected CSV header/,
  );
});
